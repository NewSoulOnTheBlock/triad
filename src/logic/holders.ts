// Holder-age bookkeeping. Two clocks per wallet:
//
//   heldSince      — continuous holding of any amount (airdrop eligibility)
//   qualifiedSince — continuous holding of at least `prizeMin` (prize ranking)
//
// Both restart whenever the balance goes down (sell or transfer out), or a
// trade scan catches the wallet selling between snapshots. qualifiedSince is
// null while the wallet is under the prize minimum, so buying 1 token at
// launch and topping up later does not buy you seniority.

export type Holder = { owner: string; balance: bigint; heldSince: number; qualifiedSince: number | null };

export function applySnapshot(
  prev: Map<string, Holder>,
  snapshot: Map<string, bigint>,
  now: number,
  sellers: Set<string> = new Set(),
  prizeMin = 0n,
): Map<string, Holder> {
  const next = new Map<string, Holder>();
  for (const [owner, balance] of snapshot) {
    if (balance <= 0n) continue;
    const before = prev.get(owner);
    const reset = !before || balance < before.balance || sellers.has(owner);
    const heldSince = reset ? now : before.heldSince;
    const qualifiedSince = balance < prizeMin ? null : reset || before.qualifiedSince === null ? now : before.qualifiedSince;
    next.set(owner, { owner, balance, heldSince, qualifiedSince });
  }
  return next;
}

// An RPC node that is behind or flaky can answer getProgramAccounts with a
// partial list. Accepting it would reset every missing wallet's clock, so a
// snapshot that loses most of the known holders at once is refused.
export function snapshotLooksTruncated(prevCount: number, nextCount: number): boolean {
  return prevCount >= 20 && nextCount < prevCount * 0.5;
}

export type Filter = { exclude: Set<string> };

// Prize ranking: oldest qualified clock first; ties to the bigger bag, then
// address so the order is deterministic.
export function rankByAge(holders: Iterable<Holder>, f: Filter): Holder[] {
  return [...holders]
    .filter((h) => !f.exclude.has(h.owner) && h.qualifiedSince !== null)
    .sort(
      (a, b) =>
        a.qualifiedSince! - b.qualifiedSince! ||
        (b.balance > a.balance ? 1 : b.balance < a.balance ? -1 : 0) ||
        a.owner.localeCompare(b.owner),
    );
}
