// Bucket 3: DLMM liquidity + fee airdrop.
//
// Post-migration, this bucket turns its $PUMP into a Meteora DLMM position on
// the coin/$PUMP pair and keeps it in range: when the active bin leaves the
// position, the engine removes, re-centers on the active bin (same width), and
// re-adds. The bucket's $PUMP is the LP *principal* (it compounds as more fee
// flows in). The position's *earned trading fees* are claimed, converted to
// $PUMP, and airdropped to holders of 1h+ by the existing loyalty weighting.
//
// This module is pure: range/rebalance math and sizing only. The engine owns
// the on-chain DLMM calls (behind the MeteoraLp interface) and the crash-safe
// airdrop ledger.

export type LpSnapshot = {
  pool: string;
  position: string | null; // null until the first position is opened
  activeBinId: number;
  lowerBinId: number;
  upperBinId: number;
  feeX: bigint; // unclaimed fee, base (coin) side
  feeY: bigint; // unclaimed fee, quote ($PUMP) side
};

// The engine talks to Meteora only through this. Each method that moves funds
// submits its own transaction(s); reads are plain. A real DlmmLp (src/meteora.ts)
// implements it against @meteora-ag/dlmm; tests use a fake.
export interface MeteoraLp {
  poolExists(): Promise<boolean>;
  ensurePool(): Promise<string>; // create the coin/$PUMP pair if missing; returns the pool pubkey
  snapshot(): Promise<LpSnapshot | null>; // null before the first position
  // Open the first position: `quote` $PUMP, half swapped to the coin, two-sided
  // around the active bin at +/- halfWidth bins.
  openPosition(quote: bigint, halfWidth: number): Promise<void>;
  addLiquidity(quote: bigint): Promise<void>; // grow the existing position with more $PUMP
  rebalance(halfWidth: number): Promise<void>; // remove + close, re-center on the active bin, re-add
  // Claim both fee sides to the wallet, swap the coin side to $PUMP, and return
  // the total $PUMP the claim added to the wallet (0 if nothing to claim).
  claimFeesToQuote(): Promise<bigint>;
}

// Re-center: a position of +/- halfWidth bins around the active bin.
export function recenter(activeBinId: number, halfWidth: number): { minBinId: number; maxBinId: number } {
  const h = Math.max(1, Math.floor(halfWidth));
  return { minBinId: activeBinId - h, maxBinId: activeBinId + h };
}

// The position is out of range when the active bin has left it.
export function shouldRebalance(activeBinId: number, lowerBinId: number, upperBinId: number): boolean {
  return activeBinId < lowerBinId || activeBinId > upperBinId;
}

// Half-width to use on the next (re)open: the configured fixed width, or the
// current position's own width when configured to preserve it.
export function nextHalfWidth(cfg: { halfWidth: number; keepWidth: boolean }, lowerBinId: number, upperBinId: number): number {
  if (cfg.keepWidth) return Math.max(1, Math.floor((upperBinId - lowerBinId) / 2));
  return Math.max(1, Math.floor(cfg.halfWidth));
}

// How much of the bucket's idle $PUMP to deploy as LP this tick: everything at
// or above the minimum, else nothing (dust isn't worth a deposit's fees).
export function planDeploy(idleQuote: bigint, minQuote: bigint): bigint {
  return idleQuote >= minQuote ? idleQuote : 0n;
}
