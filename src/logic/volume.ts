// Bucket 1: volume bot. Instead of buying and burning, this bucket prints
// two-sided volume: it funds a throwaway sub-wallet from the bucket, runs a
// handful of ATOMIC buy+sell cycles on it (each a single transaction, so the
// sub can never be left holding the coin), then drains the sub back to the
// bucket and rotates to a fresh one (anti-clustering). Every trade is a real
// on-chain round trip; the only net outflow is the pump fee on each leg.
//
// This module is pure: sizing and timing only. The engine owns the on-chain
// spawn / fund / cycle / drain and the crash-safe ledger.

import { sliceCap } from "./bot.js";

export type VolumeState = {
  nextCycleAt: number; // when the next buy+sell cycle may run
  sub: string | null; // active throwaway sub-wallet pubkey (secret kept in volume_wallets)
  cyclesDone: number; // cycles the active sub has completed
};

export type VolumeConfig = {
  everyMs: number; // gap between cycles
  timingJitter: number; // 0.6 = the gap varies +/-30%
  cyclesPerWallet: number; // rotate to a fresh sub after this many cycles
  fundPct: number; // fraction of the bucket seeded into each new sub
  fundJitter: number; // size jitter on the seed amount
  minQuote: bigint; // smallest sub seed / cycle (quote units)
  maxImpactPct: number; // no single buy may move price more than this
  subSolLamports: number; // SOL seeded to each sub for gas + ATA rent
  slippagePct: number;
};

export const INITIAL_VOLUME: VolumeState = { nextCycleAt: 0, sub: null, cyclesDone: 0 };

type Reserves = { quote: bigint; base: bigint } | null;

// How much quote to seed into a fresh throwaway sub, paced off the bucket so a
// big bucket is spread over many subs rather than dumped into one. 0 = hold
// (bucket below the minimum).
export function planFunding(input: {
  bucketQuote: bigint;
  reserves: Reserves;
  config: VolumeConfig;
  rand: number; // [0,1) size jitter
}): bigint {
  const { bucketQuote, reserves, config: c, rand } = input;
  if (bucketQuote < c.minQuote) return 0n;

  const pace = c.fundPct * (1 + c.fundJitter * (rand - 0.5));
  let quote = BigInt(Math.floor(Number(bucketQuote) * Math.min(1, Math.max(0, pace))));
  if (quote < c.minQuote) quote = c.minQuote;
  // One buy of this seed must not move price more than maxImpactPct.
  if (reserves) {
    const cap = sliceCap("buy", reserves, c.maxImpactPct);
    if (quote > cap) quote = cap > c.minQuote ? cap : c.minQuote;
  }
  if (quote > bucketQuote) quote = bucketQuote;
  return quote;
}

// The buy size for one atomic cycle: the sub spends what it holds, capped so
// the buy stays under the impact limit. The matching sell in the same tx
// returns it (minus fees), so the balance drifts down slowly across cycles.
export function planCycleQuote(input: {
  subQuote: bigint;
  reserves: Reserves;
  config: Pick<VolumeConfig, "maxImpactPct" | "minQuote">;
}): bigint {
  const { subQuote, reserves, config: c } = input;
  if (subQuote < c.minQuote) return 0n;
  let quote = subQuote;
  if (reserves) {
    const cap = sliceCap("buy", reserves, c.maxImpactPct);
    if (quote > cap) quote = cap;
  }
  if (quote < c.minQuote) return 0n; // impact cap pushed it below the floor: skip, don't dust-trade
  return quote;
}

// Set before a cycle is sent, so a failure still waits a full gap: no retry storms.
export function scheduleNextCycle(now: number, c: Pick<VolumeConfig, "everyMs" | "timingJitter">, rand: number): number {
  return now + Math.round(c.everyMs * (1 + c.timingJitter * (rand - 0.5)));
}

// Time to retire the active sub and rotate to a fresh one.
export function shouldRotate(state: VolumeState, c: Pick<VolumeConfig, "cyclesPerWallet">): boolean {
  return state.sub === null || state.cyclesDone >= c.cyclesPerWallet;
}
