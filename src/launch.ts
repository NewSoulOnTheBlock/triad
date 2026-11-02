// Builds the launch transaction: create the coin quoted in $PUMP with a 2.1%
// creator fee paid to the treasury, optionally with the dev's first buy in
// the same transaction (no block for snipers to land in between).

import {
  AddressLookupTableAccount,
  AddressLookupTableProgram,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import BN from "bn.js";
import { OnlinePumpSdk, PUMP_SDK, getBuyTokenAmountFromSolAmount } from "@pump-fun/pump-sdk";

export type LaunchParams = {
  conn: Connection;
  mint: PublicKey;
  dev: PublicKey; // pays, signs, and makes the optional first buy
  treasury: PublicKey; // the coin's creator: every creator fee lands here
  quoteMint: PublicKey;
  name: string;
  symbol: string;
  uri: string;
  creatorFeeBps: number;
  devBuyQuote: bigint; // 0 = no dev buy
};

export async function preflight(sdk: OnlinePumpSdk, p: Pick<LaunchParams, "quoteMint" | "creatorFeeBps" | "dev" | "treasury" | "name" | "symbol">) {
  const global = await sdk.fetchGlobal();
  const listed = (await sdk.fetchSupportedQuoteMints()).find((m) => m.mint.equals(p.quoteMint));
  const checks: [string, boolean][] = [
    ["create_v2 is enabled", global.createV2Enabled],
    ["configurable creator fees are enabled", global.creatorFeeConfigurable],
    [`${p.creatorFeeBps} bps is within 1..${global.maxConfigurableCreatorFeeBps.toString()}`, p.creatorFeeBps >= 1 && new BN(p.creatorFeeBps).lte(global.maxConfigurableCreatorFeeBps)],
    [`quote mint is listed (${listed?.source ?? "not listed"})`, !!listed],
    ["quote is a custom pair (not SOL/USDC), so the fee rate applies", !global.whitelistedQuoteMints.some((m) => m.equals(p.quoteMint))],
    ["dev and treasury are different wallets", !p.dev.equals(p.treasury)],
    [`name ≤ 32 chars (${p.name.length})`, p.name.length > 0 && p.name.length <= 32],
    [`symbol ≤ 13 chars (${p.symbol.length})`, p.symbol.length > 0 && p.symbol.length <= 13],
  ];
  return { global, checks, ok: checks.every(([, ok]) => ok) };
}

export async function buildLaunch(p: LaunchParams) {
  const sdk = new OnlinePumpSdk(p.conn);
  const pre = await preflight(sdk, p);
  if (!pre.ok) throw new Error("preflight failed:\n" + pre.checks.filter(([, ok]) => !ok).map(([l]) => "  - " + l).join("\n"));
  const quoteTokenProgram = await sdk.fetchQuoteTokenProgram(p.quoteMint);
  const creatorFeeBps = new BN(p.creatorFeeBps);
  const common = {
    mint: p.mint, name: p.name, symbol: p.symbol, uri: p.uri,
    creator: p.treasury, user: p.dev, mayhemMode: false,
    quoteMint: p.quoteMint, quoteTokenProgram, creatorFeeBps,
    holderReward: false, // true would hand the fee to pump.fun's own holder payout instead of the treasury
  };

  let ixs: TransactionInstruction[];
  let expectedTokens = 0n;
  if (p.devBuyQuote > 0n) {
    const [feeConfig, quoteControl] = await Promise.all([sdk.fetchFeeConfig(), sdk.fetchQuoteControl()]);
    const quoteAmount = new BN(p.devBuyQuote.toString());
    const amount = getBuyTokenAmountFromSolAmount({
      global: pre.global, feeConfig, mintSupply: null, bondingCurve: null,
      amount: quoteAmount, quoteMint: p.quoteMint, quoteControl, creatorFeeBps,
    });
    expectedTokens = BigInt(amount.toString());
    ixs = await PUMP_SDK.createV2AndBuyV2Instructions({ ...common, global: pre.global, amount, quoteAmount, slippage: 2 });
  } else {
    ixs = [await PUMP_SDK.createV2Instruction(common)];
  }
  return {
    checks: pre.checks,
    expectedTokens,
    ixs: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: p.devBuyQuote > 0n ? 500_000 : 300_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 200_000 }),
      ...ixs,
    ],
  };
}

// ---- lookup table ----
// create + dev buy is 34 accounts (~1.47 KB as a legacy transaction, over the
// 1232-byte limit). The 23 that don't depend on the new mint go into a lookup
// table owned by the dev, which brings the v0 transaction to ~880 bytes.

const keysOf = (ixs: TransactionInstruction[]) => {
  const s = new Set<string>();
  for (const ix of ixs) {
    s.add(ix.programId.toBase58());
    for (const k of ix.keys) s.add(k.pubkey.toBase58());
  }
  return s;
};

// Accounts that are the same whatever the mint: build the launch for a second
// throwaway mint and keep what both share, minus signers.
export async function staticAccounts(p: LaunchParams, ixs: TransactionInstruction[]): Promise<PublicKey[]> {
  const other = keysOf((await buildLaunch({ ...p, mint: Keypair.generate().publicKey })).ixs);
  const signers = new Set(ixs.flatMap((ix) => ix.keys.filter((k) => k.isSigner).map((k) => k.pubkey.toBase58())));
  return [...keysOf(ixs)].filter((k) => other.has(k) && !signers.has(k)).map((k) => new PublicKey(k));
}

// An in-memory table, only for measuring the transaction size offline.
export const tableForSizing = (addresses: PublicKey[], authority: PublicKey) =>
  new AddressLookupTableAccount({
    key: Keypair.generate().publicKey,
    state: { deactivationSlot: 2n ** 64n - 1n, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, authority, addresses },
  });

export async function createLookupTable(conn: Connection, payer: Keypair, addresses: PublicKey[]) {
  const slot = await conn.getSlot("finalized");
  const [create, table] = AddressLookupTableProgram.createLookupTable({ authority: payer.publicKey, payer: payer.publicKey, recentSlot: slot });
  const extend = AddressLookupTableProgram.extendLookupTable({ authority: payer.publicKey, payer: payer.publicKey, lookupTable: table, addresses });
  await sendAndConfirmTransaction(conn, new Transaction().add(create, extend), [payer], { commitment: "confirmed" });
  // A table is usable from the slot after its last extension.
  for (let i = 0; i < 30; i++) {
    const acct = (await conn.getAddressLookupTable(table)).value;
    if (acct && acct.state.addresses.length === addresses.length && (await conn.getSlot("confirmed")) > acct.state.lastExtendedSlot) return acct;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`lookup table ${table.toBase58()} did not activate`);
}
