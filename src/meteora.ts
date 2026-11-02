// Bucket 3's on-chain Meteora DLMM adapter: the real implementation of the
// MeteoraLp interface the engine drives. Single-sided $PUMP liquidity on the
// coin/$PUMP pair — the bucket's $PUMP is the principal; the coin side that
// accrues (from fills and claimed fees) is swapped back to $PUMP so everything
// airdropped is $PUMP, per the bucket's design.
//
// VERIFY-AT-LAUNCH: these calls are typechecked against @meteora-ag/dlmm and
// modelled on the reference bot, but can only be runtime-verified once a real
// migrated coin + pool exists (there is none pre-launch, like the rest of the
// engine's chain layer). The bin placement and amount math in openPosition /
// rebalance are the parts to confirm on the first live migrated coin.

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  ComputeBudgetProgram,
  sendAndConfirmRawTransaction,
} from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import DLMM, { StrategyType, ActivationType } from "@meteora-ag/dlmm";
import BN from "bn.js";
import type { Config } from "./config.js";
import { recenter, type LpSnapshot, type MeteoraLp } from "./logic/dlmm.js";

export class DlmmLp implements MeteoraLp {
  private pool: PublicKey | null = null;
  private dlmm: DLMM | null = null;

  // `coin` = base (token X), `$PUMP` = quote (token Y). priceFn gives the live
  // coin/$PUMP price (quote per 1 coin) used only to seed a new pool's active bin.
  constructor(
    private conn: Connection,
    private cfg: Config,
    private signer: Keypair,
    private quoteTokenProgram: PublicKey,
    private priceFn: () => Promise<number>,
  ) {}

  private get coin() { return this.cfg.mint; }
  private get quote() { return this.cfg.quoteMint; }

  async poolExists(): Promise<boolean> {
    return (await this.resolvePool()) !== null;
  }

  private async resolvePool(): Promise<PublicKey | null> {
    if (this.pool) return this.pool;
    const p = await DLMM.getCustomizablePermissionlessLbPairIfExists(this.conn, this.coin, this.quote);
    if (p) this.pool = p;
    return this.pool;
  }

  private async load(): Promise<DLMM> {
    const pool = await this.resolvePool();
    if (!pool) throw new Error("dlmm pool does not exist yet");
    if (!this.dlmm) this.dlmm = await DLMM.create(this.conn, pool);
    else await this.dlmm.refetchStates();
    return this.dlmm;
  }

  async ensurePool(): Promise<string> {
    const existing = await this.resolvePool();
    if (existing) return existing.toBase58();
    const price = await this.priceFn();
    const activeId = new BN(DLMM.getBinIdFromPrice(price, this.cfg.dlmm.binStep, true));
    const tx = await DLMM.createCustomizablePermissionlessLbPair2(
      this.conn,
      new BN(this.cfg.dlmm.binStep),
      this.coin,
      this.quote,
      activeId,
      new BN(this.cfg.dlmm.baseFeeBps),
      ActivationType.Timestamp,
      false, // no alpha vault
      this.signer.publicKey,
    );
    await this.submit(tx);
    const pool = await DLMM.getCustomizablePermissionlessLbPairIfExists(this.conn, this.coin, this.quote);
    if (!pool) throw new Error("pool create landed but the pair is not resolvable yet");
    this.pool = pool;
    this.dlmm = null;
    return pool.toBase58();
  }

  async snapshot(): Promise<LpSnapshot | null> {
    const pool = await this.resolvePool();
    if (!pool) return null;
    const dlmm = await this.load();
    const active = await dlmm.getActiveBin();
    const { userPositions } = await dlmm.getPositionsByUserAndLbPair(this.signer.publicKey);
    const pos = userPositions[0]; // the engine keeps a single position per pool
    return {
      pool: pool.toBase58(),
      position: pos ? pos.publicKey.toBase58() : null,
      activeBinId: active.binId,
      lowerBinId: pos ? pos.positionData.lowerBinId : active.binId,
      upperBinId: pos ? pos.positionData.upperBinId : active.binId,
      feeX: pos ? BigInt(pos.positionData.feeX.toString()) : 0n,
      feeY: pos ? BigInt(pos.positionData.feeY.toString()) : 0n,
    };
  }

  // Single-sided $PUMP (token Y) placed in the band at and below the active
  // bin: it fills (earns fees) as the coin is sold into it, and re-centres up
  // when price rises past the range.
  async openPosition(quote: bigint, halfWidth: number): Promise<void> {
    const dlmm = await this.load();
    const active = await dlmm.getActiveBin();
    const { minBinId } = recenter(active.binId, 2 * halfWidth);
    const posKp = Keypair.generate();
    const tx = await dlmm.initializePositionAndAddLiquidityByStrategy({
      positionPubKey: posKp.publicKey,
      totalXAmount: new BN(0),
      totalYAmount: new BN(quote.toString()),
      strategy: { minBinId, maxBinId: active.binId, strategyType: StrategyType.Spot },
      user: this.signer.publicKey,
      slippage: this.cfg.dlmm.slippageBps / 100,
    });
    await this.submit(tx, [posKp]);
  }

  async addLiquidity(quote: bigint): Promise<void> {
    const dlmm = await this.load();
    const { userPositions } = await dlmm.getPositionsByUserAndLbPair(this.signer.publicKey);
    const pos = userPositions[0];
    if (!pos) return this.openPosition(quote, this.cfg.dlmm.halfWidth);
    const active = await dlmm.getActiveBin();
    const tx = await dlmm.addLiquidityByStrategy({
      positionPubKey: pos.publicKey,
      totalXAmount: new BN(0),
      totalYAmount: new BN(quote.toString()),
      strategy: { minBinId: pos.positionData.lowerBinId, maxBinId: active.binId, strategyType: StrategyType.Spot },
      user: this.signer.publicKey,
      slippage: this.cfg.dlmm.slippageBps / 100,
    });
    await this.submit(tx);
  }

  // Remove + close the position (claims fees out with it), swap the coin we got
  // back to $PUMP, then re-open single-sided $PUMP centred on the active bin.
  async rebalance(halfWidth: number): Promise<void> {
    const dlmm = await this.load();
    const { userPositions } = await dlmm.getPositionsByUserAndLbPair(this.signer.publicKey);
    const pos = userPositions[0];
    if (!pos) return;
    const removeTx = await dlmm.removeLiquidity({
      user: this.signer.publicKey,
      position: pos.publicKey,
      fromBinId: pos.positionData.lowerBinId,
      toBinId: pos.positionData.upperBinId,
      bps: new BN(10_000), // all of it
      shouldClaimAndClose: true,
    });
    for (const tx of Array.isArray(removeTx) ? removeTx : [removeTx]) await this.submit(tx);
    await this.swapCoinToQuote();
    const quote = await this.quoteBalance();
    if (quote > 0n) await this.openPosition(quote, halfWidth);
  }

  // Claim the position's swap fees to the wallet, swap the coin side to $PUMP,
  // and report how much $PUMP the claim added to the wallet (the airdrop pot).
  async claimFeesToQuote(): Promise<bigint> {
    const dlmm = await this.load();
    const { userPositions } = await dlmm.getPositionsByUserAndLbPair(this.signer.publicKey);
    const pos = userPositions[0];
    if (!pos) return 0n;
    const before = await this.quoteBalance();
    let claimTxs: Transaction[] = [];
    try {
      claimTxs = await dlmm.claimSwapFee({ owner: this.signer.publicKey, position: pos });
    } catch (e) {
      if ((e as Error).message === "No fee to claim") return 0n;
      throw e;
    }
    for (const tx of claimTxs) await this.submit(tx);
    await this.swapCoinToQuote();
    const after = await this.quoteBalance();
    return after > before ? after - before : 0n;
  }

  // Swap the wallet's entire coin balance to $PUMP on the pool (used to keep
  // everything the bucket holds and airdrops denominated in $PUMP).
  private async swapCoinToQuote(): Promise<void> {
    const coin = await this.tokenBalance(this.coin);
    if (coin <= 0n) return;
    const dlmm = await this.load();
    const inAmount = new BN(coin.toString());
    const binArrays = await dlmm.getBinArrayForSwap(true); // swapForY: coin(X) -> $PUMP(Y)
    const quoteOut = dlmm.swapQuote(inAmount, true, new BN(this.cfg.dlmm.slippageBps), binArrays);
    const tx = await dlmm.swap({
      inToken: this.coin,
      outToken: this.quote,
      inAmount,
      minOutAmount: quoteOut.minOutAmount,
      lbPair: dlmm.pubkey,
      user: this.signer.publicKey,
      binArraysPubkey: quoteOut.binArraysPubkey,
    });
    await this.submit(tx);
  }

  // ---- balances + sending ----

  private async tokenBalance(mint: PublicKey, program = (this.cfg.mint.equals(mint) ? undefined : this.quoteTokenProgram)): Promise<bigint> {
    const ata = getAssociatedTokenAddressSync(mint, this.signer.publicKey, true, program);
    const r = await this.conn.getTokenAccountBalance(ata).catch(() => null);
    return r ? BigInt(r.value.amount) : 0n;
  }
  private quoteBalance() { return this.tokenBalance(this.quote, this.quoteTokenProgram); }

  private async submit(tx: Transaction, extra: Keypair[] = []): Promise<string> {
    const { blockhash, lastValidBlockHeight } = await this.conn.getLatestBlockhash("confirmed");
    tx.feePayer = this.signer.publicKey;
    tx.recentBlockhash = blockhash;
    tx.instructions.unshift(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: this.cfg.priorityMicroLamports }));
    tx.sign(this.signer, ...extra);
    const raw = tx.serialize();
    const sim = await this.conn.simulateTransaction(tx);
    if (sim.value.err) throw new Error(`dlmm sim failed: ${JSON.stringify(sim.value.err)} ${(sim.value.logs ?? []).slice(-3).join(" | ")}`);
    return sendAndConfirmRawTransaction(this.conn, Buffer.from(raw), { blockhash, lastValidBlockHeight, commitment: "confirmed" }, { skipPreflight: true });
  }
}
