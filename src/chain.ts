// Everything that talks to Solana: curve/pool state, price, holder snapshots,
// fee claims, buys, sells and transfers. Trades route to the bonding curve
// (v3 instructions) until the coin migrates, then to its PumpSwap pool.
//
// Transactions are signed before they are sent (`prepare`), so the caller
// learns the signature first and can write it down. If the process dies
// mid-send, the signature on record says whether it landed.

import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createBurnCheckedInstruction,
  createCloseAccountInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import BN from "bn.js";
import bs58 from "bs58";
import {
  OnlinePumpSdk,
  PUMP_SDK,
  bondingCurvePda,
  canonicalPumpPoolPdaWithQuote,
  getBuyV3QuoteAmountFromTokenAmount,
  getBuyV3TokenAmountFromQuoteAmount,
  getSellSolAmountFromTokenAmount,
} from "@pump-fun/pump-sdk";
import { OnlinePumpAmmSdk, PUMP_AMM_SDK } from "@pump-fun/pump-swap-sdk";
import type { Config } from "./config.js";

const DECIMALS = 6; // pump coins and $PUMP both use 6
export const TRANSFERS_PER_TX = 8; // measured: 8 ATA-create + transferChecked pairs = 1074 of 1232 bytes

export type Prepared = { sig: string; raw: Buffer; blockhash: string; lastValidBlockHeight: number };

export async function retry<T>(fn: () => Promise<T>, tries = 4): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= tries - 1) throw e;
      await new Promise((r) => setTimeout(r, 500 * 2 ** i));
    }
  }
}

export class Chain {
  readonly conn: Connection;
  readonly pump: OnlinePumpSdk;
  readonly amm: OnlinePumpAmmSdk;
  readonly curvePda: PublicKey;
  readonly poolPda: PublicKey;
  quoteTokenProgram!: PublicKey;

  constructor(private cfg: Config) {
    this.conn = new Connection(cfg.rpcUrl, "confirmed");
    this.pump = new OnlinePumpSdk(this.conn);
    this.amm = new OnlinePumpAmmSdk(this.conn);
    this.curvePda = bondingCurvePda(cfg.mint);
    this.poolPda = canonicalPumpPoolPdaWithQuote(cfg.mint, cfg.quoteMint);
  }

  async init() {
    this.quoteTokenProgram = await this.pump.fetchQuoteTokenProgram(this.cfg.quoteMint);
    return this;
  }

  async curve() {
    const info = await this.conn.getAccountInfo(this.curvePda);
    return info ? PUMP_SDK.decodeBondingCurveNullable(info) : null;
  }

  async migrated() {
    return (await this.conn.getAccountInfo(this.poolPda)) !== null;
  }

  // Constant-product reserves the next swap trades against (curve: virtual
  // reserves; pool: vaults plus the pool's virtual quote).
  async reserves(): Promise<{ quote: bigint; base: bigint; venue: "curve" | "pool" } | null> {
    if (await this.migrated()) {
      const pool = await this.amm.fetchPool(this.poolPda);
      const [b, q] = await Promise.all([
        this.conn.getTokenAccountBalance(pool.poolBaseTokenAccount),
        this.conn.getTokenAccountBalance(pool.poolQuoteTokenAccount),
      ]);
      // Raw vault balance: fees waiting for a sweep sit in it and skew this by well under 1%.
      const quote = BigInt(q.value.amount) + BigInt(pool.virtualQuoteReserves.toString());
      return { quote, base: BigInt(b.value.amount), venue: "pool" };
    }
    const c = await this.curve();
    if (!c || c.virtualTokenReserves.isZero()) return null;
    return { quote: BigInt(c.virtualQuoteReserves.toString()), base: BigInt(c.virtualTokenReserves.toString()), venue: "curve" };
  }

  // Quote ($PUMP) per token. Both sides are 6 decimals, so raw/raw is the price.
  async price(): Promise<{ price: number; venue: "curve" | "pool" | "none" }> {
    const r = await this.reserves();
    return r ? { price: Number(r.quote) / Number(r.base), venue: r.venue } : { price: 0, venue: "none" };
  }

  async totalSupply(): Promise<bigint> {
    return BigInt((await this.conn.getTokenSupply(this.cfg.mint)).value.amount);
  }

  // USD price of the quote token: Jupiter first, DexScreener as fallback.
  async quoteUsd(): Promise<number> {
    const id = this.cfg.quoteMint.toBase58();
    try {
      const r = await fetch(`https://lite-api.jup.ag/price/v3?ids=${id}`, { signal: AbortSignal.timeout(8000) });
      const p = Number(((await r.json()) as any)?.[id]?.usdPrice);
      if (p > 0) return p;
    } catch {}
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${id}`, { signal: AbortSignal.timeout(8000) });
    const p = Number(((await r.json()) as any)?.pairs?.[0]?.priceUsd);
    if (!(p > 0)) throw new Error("no USD price for quote token");
    return p;
  }

  // Every wallet holding the coin. Off-curve owners (the curve, the pool, any
  // program vault) are PDAs, never people, so they are dropped here.
  async snapshotHolders(): Promise<Map<string, bigint>> {
    const accts = await retry(() =>
      this.conn.getProgramAccounts(TOKEN_2022_PROGRAM_ID, {
        filters: [{ memcmp: { offset: 0, bytes: this.cfg.mint.toBase58() } }],
        dataSlice: { offset: 32, length: 40 }, // owner (32) + amount (8)
      }),
    );
    const out = new Map<string, bigint>();
    for (const { account } of accts) {
      const owner = new PublicKey(account.data.subarray(0, 32));
      const amount = account.data.readBigUInt64LE(32);
      if (amount === 0n || !PublicKey.isOnCurve(owner.toBytes())) continue;
      const k = owner.toBase58();
      out.set(k, (out.get(k) ?? 0n) + amount);
    }
    return out;
  }

  // Wallets whose balance dropped in any curve/pool trade since `untilSig`
  // (including Jupiter-routed ones: they touch the same account). Catches a
  // sell-then-rebuy that nets out inside one snapshot interval.
  async scanSellers(untilSig: string | null, untilVenue: string | null) {
    const venue = (await this.migrated()) ? this.poolPda : this.curvePda;
    const venueKey = venue.toBase58();
    const sellers = new Set<string>();
    const [head] = await this.conn.getSignaturesForAddress(venue, { limit: 1 });
    // First run, or the coin just graduated: bookmark and start from here.
    if (!untilSig || untilVenue !== venueKey) return { sellers, newest: head?.signature ?? null, venue: venueKey };

    const sigs: string[] = [];
    let before: string | undefined;
    for (let page = 0; page < 10; page++) {
      const batch = await retry(() => this.conn.getSignaturesForAddress(venue, { until: untilSig, before, limit: 1000 }));
      sigs.push(...batch.filter((s) => !s.err).map((s) => s.signature));
      if (batch.length < 1000) break;
      before = batch[batch.length - 1].signature;
    }
    const mint = this.cfg.mint.toBase58();
    for (let i = 0; i < sigs.length; i += 10) {
      const txs = await retry(() => this.conn.getParsedTransactions(sigs.slice(i, i + 10), { maxSupportedTransactionVersion: 1 }));
      for (const tx of txs) {
        const post = new Map<string, bigint>();
        for (const b of tx?.meta?.postTokenBalances ?? []) if (b.mint === mint && b.owner) post.set(b.owner, BigInt(b.uiTokenAmount.amount));
        for (const b of tx?.meta?.preTokenBalances ?? [])
          if (b.mint === mint && b.owner && (post.get(b.owner) ?? 0n) < BigInt(b.uiTokenAmount.amount)) sellers.add(b.owner);
      }
    }
    return { sellers, newest: head?.signature ?? untilSig, venue: venueKey };
  }

  async tokenBalance(owner: PublicKey, mint = this.cfg.mint, program = TOKEN_2022_PROGRAM_ID): Promise<bigint> {
    const ata = getAssociatedTokenAddressSync(mint, owner, true, program);
    const r = await this.conn.getTokenAccountBalance(ata).catch(() => null);
    return r ? BigInt(r.value.amount) : 0n;
  }

  quoteBalance(owner: PublicKey) {
    return this.tokenBalance(owner, this.cfg.quoteMint, this.quoteTokenProgram);
  }

  solBalance(owner: PublicKey) {
    return this.conn.getBalance(owner);
  }

  tokenProgramFor(mint: PublicKey) {
    return mint.equals(this.cfg.quoteMint) ? this.quoteTokenProgram : TOKEN_2022_PROGRAM_ID;
  }

  // ---- instruction builders ----

  // Sweep the waiting creator fee (curve, and pool once migrated) into the
  // treasury's creator vaults, then collect both to the treasury's $PUMP ATA.
  async claimIxs(): Promise<TransactionInstruction[]> {
    const t = this.cfg.treasury.publicKey;
    const q = this.cfg.quoteMint;
    const qtp = this.quoteTokenProgram;
    const ixs: TransactionInstruction[] = [
      createAssociatedTokenAccountIdempotentInstruction(t, getAssociatedTokenAddressSync(q, t, true, qtp), t, q, qtp),
      await PUMP_SDK.sweepCreatorFeeInstruction({ payer: t, mint: this.cfg.mint, creator: t, quoteMint: q, quoteTokenProgram: qtp }),
    ];
    if (await this.migrated()) {
      const pool = await this.amm.fetchPool(this.poolPda);
      ixs.push(await PUMP_SDK.sweepPoolCreatorFeeInstruction({ payer: t, mint: this.cfg.mint, coinCreator: pool.coinCreator, quoteMint: q, quoteTokenProgram: qtp }));
    }
    ixs.push(...(await this.pump.collectCoinCreatorFeeV2Instructions(t, q, qtp, t)));
    return ixs;
  }

  // Spend exactly `quote` $PUMP on the coin.
  async buyIxs(user: PublicKey, quote: bigint): Promise<TransactionInstruction[]> {
    if (await this.migrated()) {
      const state = await this.amm.swapSolanaState(this.poolPda, user);
      return PUMP_AMM_SDK.buyQuoteInput(state, new BN(quote.toString()), this.cfg.bot.slippagePct);
    }
    const [global, feeConfig, s] = await Promise.all([
      this.pump.fetchGlobal(),
      this.pump.fetchFeeConfig(),
      this.pump.fetchBuyState(this.cfg.mint, user, TOKEN_2022_PROGRAM_ID, this.cfg.quoteMint),
    ]);
    if (s.bondingCurve.complete) throw new Error("curve complete, waiting for migration");
    const quoteBn = new BN(quote.toString());
    const amount = getBuyV3TokenAmountFromQuoteAmount({
      global, feeConfig, mintSupply: s.bondingCurve.tokenTotalSupply, bondingCurve: s.bondingCurve,
      amount: quoteBn, curveBaseTokenBalance: s.curveBaseTokenBalance,
    });
    return PUMP_SDK.buyExactQuoteInV3Instructions({
      bondingCurve: s.bondingCurve, associatedUserAccountInfo: s.associatedUserAccountInfo, mint: this.cfg.mint, user,
      amount, quoteAmount: quoteBn, slippage: this.cfg.bot.slippagePct,
      tokenProgram: TOKEN_2022_PROGRAM_ID, quoteTokenProgram: s.quoteTokenProgram,
    });
  }

  // Sell exactly `tokens`.
  async sellIxs(user: PublicKey, tokens: bigint): Promise<TransactionInstruction[]> {
    if (await this.migrated()) {
      const state = await this.amm.swapSolanaState(this.poolPda, user);
      return PUMP_AMM_SDK.sellBaseInput(state, new BN(tokens.toString()), this.cfg.bot.slippagePct);
    }
    const [global, feeConfig, s] = await Promise.all([
      this.pump.fetchGlobal(),
      this.pump.fetchFeeConfig(),
      this.pump.fetchSellState(this.cfg.mint, user, TOKEN_2022_PROGRAM_ID, this.cfg.quoteMint),
    ]);
    if (s.bondingCurve.complete) throw new Error("curve complete, waiting for migration");
    const amount = new BN(tokens.toString());
    const quoteAmount = getSellSolAmountFromTokenAmount({ global, feeConfig, mintSupply: s.bondingCurve.tokenTotalSupply, bondingCurve: s.bondingCurve, amount });
    return PUMP_SDK.sellV3Instructions({
      bondingCurve: s.bondingCurve, mint: this.cfg.mint, user, amount, quoteAmount,
      slippage: this.cfg.bot.slippagePct, tokenProgram: TOKEN_2022_PROGRAM_ID, quoteTokenProgram: s.quoteTokenProgram,
    });
  }

  // Bucket 1: ONE atomic buy+sell. Spends `quote` buying the exact token amount
  // the curve returns, then sells that exact amount back in the same tx — zero
  // dust, and the wallet is never left holding the coin even for a slot. Curve
  // only: pre-migration is where volume matters, and exact buy+sell matching
  // isn't available on the pool, so the engine round-trips in two txs there.
  async volumeCycleIxs(user: PublicKey, quote: bigint): Promise<TransactionInstruction[]> {
    if (await this.migrated()) throw new Error("volume cycle is curve-only (coin migrated)");
    const [global, feeConfig, s] = await Promise.all([
      this.pump.fetchGlobal(),
      this.pump.fetchFeeConfig(),
      this.pump.fetchBuyState(this.cfg.mint, user, TOKEN_2022_PROGRAM_ID, this.cfg.quoteMint),
    ]);
    if (s.bondingCurve.complete) throw new Error("curve complete, waiting for migration");
    const bc = s.bondingCurve;
    const mintSupply = bc.tokenTotalSupply;
    const quoteBn = new BN(quote.toString());
    const amount = getBuyV3TokenAmountFromQuoteAmount({ global, feeConfig, mintSupply, bondingCurve: bc, amount: quoteBn, curveBaseTokenBalance: s.curveBaseTokenBalance });
    if (amount.lten(0)) throw new Error("volume cycle: buy quotes to zero tokens");
    const buyQuote = getBuyV3QuoteAmountFromTokenAmount({ global, feeConfig, mintSupply, bondingCurve: bc, amount, curveBaseTokenBalance: s.curveBaseTokenBalance });
    const sellQuote = getSellSolAmountFromTokenAmount({ global, feeConfig, mintSupply, bondingCurve: bc, amount });
    const slip = this.cfg.volume.slippagePct;
    const buy = await PUMP_SDK.buyV3Instructions({ bondingCurve: bc, associatedUserAccountInfo: s.associatedUserAccountInfo, mint: this.cfg.mint, user, amount, quoteAmount: buyQuote, slippage: slip, tokenProgram: TOKEN_2022_PROGRAM_ID, quoteTokenProgram: s.quoteTokenProgram });
    const sell = await PUMP_SDK.sellV3Instructions({ bondingCurve: bc, mint: this.cfg.mint, user, amount, quoteAmount: sellQuote, slippage: slip, tokenProgram: TOKEN_2022_PROGRAM_ID, quoteTokenProgram: s.quoteTokenProgram });
    return [...buy, ...sell];
  }

  // Move native SOL (funding a sub, or sweeping it back on drain).
  solTransferIxs(from: PublicKey, to: PublicKey, lamports: bigint): TransactionInstruction[] {
    return [SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports: Number(lamports) })];
  }

  // Close an emptied token account back to its owner, reclaiming the rent.
  // Returns [] when the account doesn't exist, so a drain is re-entrant.
  async closeAtaIxs(owner: PublicKey, mint: PublicKey): Promise<TransactionInstruction[]> {
    const program = this.tokenProgramFor(mint);
    const ata = getAssociatedTokenAddressSync(mint, owner, true, program);
    if (!(await this.conn.getAccountInfo(ata))) return [];
    return [createCloseAccountInstruction(ata, owner, owner, [], program)];
  }

  transferIxs(from: PublicKey, mint: PublicKey, items: { owner: string; amount: bigint }[]): TransactionInstruction[] {
    const program = this.tokenProgramFor(mint);
    const src = getAssociatedTokenAddressSync(mint, from, true, program);
    return items.flatMap(({ owner, amount }) => {
      const to = new PublicKey(owner);
      const dst = getAssociatedTokenAddressSync(mint, to, true, program);
      return [
        createAssociatedTokenAccountIdempotentInstruction(from, dst, to, mint, program),
        createTransferCheckedInstruction(src, mint, dst, from, amount, DECIMALS, [], program),
      ];
    });
  }

  // Destroys `amount` of the coin from the owner's account: total supply drops on-chain.
  burnIxs(owner: PublicKey, amount: bigint): TransactionInstruction[] {
    const ata = getAssociatedTokenAddressSync(this.cfg.mint, owner, true, TOKEN_2022_PROGRAM_ID);
    return [createBurnCheckedInstruction(ata, this.cfg.mint, owner, amount, DECIMALS, [], TOKEN_2022_PROGRAM_ID)];
  }

  // ---- sending ----

  async prepare(ixs: TransactionInstruction[], signer: Keypair): Promise<Prepared> {
    const { blockhash, lastValidBlockHeight } = await this.conn.getLatestBlockhash("confirmed");
    const tx = new Transaction({ feePayer: signer.publicKey, blockhash, lastValidBlockHeight }).add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: this.cfg.priorityMicroLamports }),
      ...ixs,
    );
    tx.sign(signer);
    return { sig: bs58.encode(tx.signature!), raw: tx.serialize(), blockhash, lastValidBlockHeight };
  }

  // Simulate first so a doomed transaction costs nothing, then send and wait.
  async submit(p: Prepared): Promise<string> {
    const sim = await this.conn.simulateTransaction(Transaction.from(p.raw));
    if (sim.value.err) throw new Error(`simulation failed: ${JSON.stringify(sim.value.err)} ${(sim.value.logs ?? []).slice(-3).join(" | ")}`);
    await this.conn.sendRawTransaction(p.raw, { skipPreflight: true, maxRetries: 5 });
    const res = await this.conn.confirmTransaction({ signature: p.sig, blockhash: p.blockhash, lastValidBlockHeight: p.lastValidBlockHeight }, "confirmed");
    if (res.value.err) throw new Error(`transaction failed: ${JSON.stringify(res.value.err)}`);
    return p.sig;
  }

  // Gas station: sell this wallet's $PUMP for native SOL (via Jupiter) until it
  // holds about `targetLamports`, so engine wallets self-fund their gas from the
  // fees they already hold instead of needing manual SOL top-ups. Returns the
  // signature, or null when nothing needs selling / there's no $PUMP / no route.
  async topUpSolFromQuote(wallet: Keypair, targetLamports: number): Promise<string | null> {
    const have = await this.conn.getBalance(wallet.publicKey, "confirmed");
    const deficit = targetLamports - have;
    if (deficit <= 0) return null;
    const qbal = await this.quoteBalance(wallet.publicKey);
    if (qbal <= 0n) return null;
    const SOL = "So11111111111111111111111111111111111111112";
    const inMint = this.cfg.quoteMint.toBase58();
    const base = "https://lite-api.jup.ag/swap/v1";
    // ExactOut: ask for `deficit` lamports of SOL out; Jupiter sizes the $PUMP in.
    const quote: any = await (await fetch(`${base}/quote?inputMint=${inMint}&outputMint=${SOL}&amount=${deficit}&swapMode=ExactOut&slippageBps=300`)).json();
    if (!quote || quote.error || !quote.inAmount) return null;
    if (BigInt(quote.inAmount) > qbal) return null; // not enough $PUMP to cover this much gas: skip
    const swap: any = await (await fetch(`${base}/swap`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ quoteResponse: quote, userPublicKey: wallet.publicKey.toBase58(), wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true }),
    })).json();
    if (!swap || !swap.swapTransaction) return null;
    const tx = VersionedTransaction.deserialize(Buffer.from(swap.swapTransaction, "base64"));
    tx.sign([wallet]);
    const sim = await this.conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: false });
    if (sim.value.err) throw new Error(`gas swap simulation failed: ${JSON.stringify(sim.value.err)}`);
    const sig = await this.conn.sendRawTransaction(Buffer.from(tx.serialize()), { skipPreflight: true, maxRetries: 5 });
    await this.conn.confirmTransaction({ signature: sig, blockhash: tx.message.recentBlockhash, lastValidBlockHeight: swap.lastValidBlockHeight }, "confirmed");
    return sig;
  }

  // Did these signatures land? "landed" / "failed" / "unknown" (still in
  // flight, or never made it if the blockhash has expired).
  async sigOutcomes(sigs: string[]): Promise<Map<string, "landed" | "failed" | "unknown">> {
    const out = new Map<string, "landed" | "failed" | "unknown">();
    for (let i = 0; i < sigs.length; i += 200) {
      const chunk = sigs.slice(i, i + 200);
      const { value } = await this.conn.getSignatureStatuses(chunk, { searchTransactionHistory: true });
      chunk.forEach((s, j) => {
        const v = value[j];
        out.set(s, !v ? "unknown" : v.err ? "failed" : v.confirmationStatus === "processed" ? "unknown" : "landed");
      });
    }
    return out;
  }

  blockHeight() {
    return this.conn.getBlockHeight("confirmed");
  }
}
