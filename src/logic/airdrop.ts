// Bucket 3: loyalty airdrop. Through each round the bucket buys the coin back
// in small slices; at the end of the round it airdrops everything bought to
// holders, weighted by
//
//   lowest balance held this round  ×  loyalty multiplier
//
// The multiplier grows with continuous holding (1× at 1h up to 3× at 7d, by
// default) and drops to zero on any sell or transfer out. Weight stays linear
// in balance on purpose: anything that favours small wallets would reward
// splitting a bag across many, and splitting is a transfer out, which resets.

import { sliceCap } from "./bot.js";
import type { Holder } from "./holders.js";

export type Tier = { ms: number; mult: number }; // held this long -> this multiplier

export const DEFAULT_TIERS: Tier[] = [
  { ms: 3_600_000, mult: 1 },
  { ms: 24 * 3_600_000, mult: 1.5 },
  { ms: 72 * 3_600_000, mult: 2 },
  { ms: 168 * 3_600_000, mult: 3 },
];

// "1:1,24:1.5,72:2,168:3" (hours:multiplier) -> tiers, shortest first.
export function parseTiers(s: string): Tier[] {
  const t = s.split(",").map((p) => {
    const [hours, mult] = p.split(":").map(Number);
    if (!(hours >= 0 && mult > 0)) throw new Error(`bad tier "${p}"`);
    return { ms: hours * 3_600_000, mult };
  });
  return t.sort((a, b) => a.ms - b.ms);
}

// 0 before the first tier (not eligible yet), then linear between tiers, flat after the last.
export function multiplier(heldMs: number, tiers: Tier[]): number {
  if (heldMs < tiers[0].ms) return 0;
  for (let i = 1; i < tiers.length; i++) {
    const a = tiers[i - 1], b = tiers[i];
    if (heldMs < b.ms) return a.mult + ((b.mult - a.mult) * (heldMs - a.ms)) / (b.ms - a.ms);
  }
  return tiers[tiers.length - 1].mult;
}

// The next tier still ahead of this wallet, if any.
export function nextTier(heldMs: number, tiers: Tier[]): (Tier & { inMs: number }) | null {
  const t = tiers.find((t) => t.ms > heldMs);
  return t ? { ...t, inMs: t.ms - heldMs } : null;
}

export type Weighted = { owner: string; balance: bigint; counted: bigint; mult: number; heldMs: number; weight: bigint };

const MULT_SCALE = 1000n; // multipliers to 3 decimals in integer math

export function airdropWeights(
  holders: Iterable<Holder>,
  now: number,
  opts: { tiers: Tier[]; exclude: Set<string>; minBalance: bigint },
): Weighted[] {
  const out: Weighted[] = [];
  for (const h of holders) {
    if (opts.exclude.has(h.owner)) continue;
    const heldMs = now - h.heldSince;
    const mult = multiplier(heldMs, opts.tiers);
    const counted = h.minSinceRound < h.balance ? h.minSinceRound : h.balance;
    if (mult <= 0 || counted < opts.minBalance) continue;
    out.push({ owner: h.owner, balance: h.balance, counted, mult, heldMs, weight: counted * BigInt(Math.round(mult * Number(MULT_SCALE))) });
  }
  return out;
}

// Pro-rata split by weight. Shares under `minPayout` are dropped and the total
// is re-split among the rest, so dust wallets don't eat transaction fees.
// Whatever rounding leaves over stays in the bucket for next time.
export function allocate(total: bigint, recipients: { owner: string; weight: bigint }[], minPayout: bigint) {
  let pool = recipients.filter((r) => r.weight > 0n);
  for (;;) {
    const weight = pool.reduce((s, r) => s + r.weight, 0n);
    if (weight === 0n || total === 0n) return { payouts: [] as { owner: string; amount: bigint }[], leftover: total };
    const payouts = pool.map((r) => ({ owner: r.owner, amount: (total * r.weight) / weight }));
    const kept = payouts.filter((p) => p.amount >= minPayout);
    if (kept.length === payouts.length) {
      const paid = kept.reduce((s, p) => s + p.amount, 0n);
      return { payouts: kept, leftover: total - paid };
    }
    const keep = new Set(kept.map((p) => p.owner));
    pool = pool.filter((r) => keep.has(r.owner));
  }
}

// Buy back across the round instead of all at once at the top of the hour:
// each slice is the balance divided by the slices left before the round ends,
// so the bucket is spent by payout time, and no slice moves price more than
// maxImpactPct (anything the cap holds back rolls into the next round).
export function planBuyback(input: {
  quoteBalance: bigint;
  now: number;
  roundEnd: number;
  sliceGapMs: number;
  minQuote: bigint;
  maxImpactPct: number;
  reserves: { quote: bigint; base: bigint } | null;
}): bigint {
  const { quoteBalance, now, roundEnd, sliceGapMs, minQuote, maxImpactPct, reserves } = input;
  if (quoteBalance < minQuote) return 0n;
  const left = BigInt(Math.max(1, Math.ceil((roundEnd - now) / Math.max(1, sliceGapMs))));
  let q = quoteBalance / left;
  if (q < minQuote) q = minQuote;
  if (reserves) {
    const cap = sliceCap("buy", reserves, maxImpactPct);
    if (q > cap) q = cap > minQuote ? cap : minQuote;
  }
  return q > quoteBalance ? quoteBalance : q;
}
