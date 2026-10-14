// Bucket 1: the longest-holder prize, paid at every market-cap milestone.
//
// Ladder rule: if the #1 longest holder is the same wallet as last round, the
// winner set grows by one (top 2, then top 3, ...). The moment a different
// wallet is #1 (because the old one sold or dropped out), it resets to 1.

export type LadderState = { top: string | null; size: number };

export const EMPTY_LADDER: LadderState = { top: null, size: 0 };

export function nextLadder(rankedOwners: string[], prev: LadderState) {
  if (rankedOwners.length === 0) return null;
  const top = rankedOwners[0];
  const size = top === prev.top ? prev.size + 1 : 1;
  const winners = rankedOwners.slice(0, size);
  return { winners, state: { top, size } satisfies LadderState };
}

export function splitEven(pot: bigint, n: number): bigint[] {
  if (n <= 0) return [];
  const share = pot / BigInt(n);
  const out = Array<bigint>(n).fill(share);
  out[0] += pot - share * BigInt(n); // dust to the longest holder
  return out;
}

// Milestones are every `step` USD of market cap (25k, 50k, 75k...). Each level
// pays once; a jump across several levels in one tick pays once and marks them
// all reached, since the pot only holds what has accrued.
export function milestoneReached(mcapUsd: number, step: number, lastPaidLevel: number): number | null {
  const level = Math.floor(mcapUsd / step);
  return level >= 1 && level > lastPaidLevel ? level : null;
}
