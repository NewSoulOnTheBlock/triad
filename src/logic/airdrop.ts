// Bucket 3: buy back the token and airdrop it pro-rata by balance to every
// wallet (dev included) that has held for at least `minAgeMs`.

import type { Holder } from "./holders.js";

export function airdropEligible(
  holders: Iterable<Holder>,
  now: number,
  opts: { minAgeMs: number; exclude: Set<string>; minBalance: bigint },
): Holder[] {
  return [...holders].filter(
    (h) => !opts.exclude.has(h.owner) && h.balance >= opts.minBalance && now - h.heldSince >= opts.minAgeMs,
  );
}

// Pro-rata split. Shares under `minPayout` are dropped and the total is
// re-split among the rest, so dust wallets don't eat transaction fees.
// Whatever rounding leaves over stays in the bucket for next time.
export function allocate(total: bigint, recipients: Holder[], minPayout: bigint) {
  let pool = recipients.filter((r) => r.balance > 0n);
  for (;;) {
    const weight = pool.reduce((s, r) => s + r.balance, 0n);
    if (weight === 0n || total === 0n) return { payouts: [] as { owner: string; amount: bigint }[], leftover: total };
    const payouts = pool.map((r) => ({ owner: r.owner, amount: (total * r.balance) / weight }));
    const kept = payouts.filter((p) => p.amount >= minPayout);
    if (kept.length === payouts.length) {
      const paid = kept.reduce((s, p) => s + p.amount, 0n);
      return { payouts: kept, leftover: total - paid };
    }
    const keep = new Set(kept.map((p) => p.owner));
    pool = pool.filter((r) => keep.has(r.owner));
  }
}
