// Holder bookkeeping. Per wallet:
//
//   heldSince      — continuous holding of any amount. Restarts whenever the
//                    balance goes down (sell or transfer out), or a trade
//                    scan catches the wallet selling between snapshots.
//                    Drives airdrop eligibility and the loyalty multiplier.
//   minSinceRound  — the lowest balance seen since the last airdrop round.
//                    Airdrops weigh this, not the balance at payout time, so
//                    buying right before a round earns nothing for it.

export type Holder = { owner: string; balance: bigint; heldSince: number; minSinceRound: bigint };

export function applySnapshot(
  prev: Map<string, Holder>,
  snapshot: Map<string, bigint>,
  now: number,
  sellers: Set<string> = new Set(),
): Map<string, Holder> {
  const next = new Map<string, Holder>();
  for (const [owner, balance] of snapshot) {
    if (balance <= 0n) continue;
    const before = prev.get(owner);
    const reset = !before || balance < before.balance || sellers.has(owner);
    const heldSince = reset ? now : before.heldSince;
    const minSinceRound = !before ? balance : balance < before.minSinceRound ? balance : before.minSinceRound;
    next.set(owner, { owner, balance, heldSince, minSinceRound });
  }
  return next;
}

// A round was just paid: every wallet's window starts over at what it holds now.
export function startRound(holders: Map<string, Holder>): Map<string, Holder> {
  return new Map([...holders].map(([k, h]) => [k, { ...h, minSinceRound: h.balance }]));
}

// An RPC node that is behind or flaky can answer getProgramAccounts with a
// partial list. Accepting it would reset every missing wallet's clock, so a
// snapshot that loses most of the known holders at once is refused.
export function snapshotLooksTruncated(prevCount: number, nextCount: number): boolean {
  return prevCount >= 20 && nextCount < prevCount * 0.5;
}
