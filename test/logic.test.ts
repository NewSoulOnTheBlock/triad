import { describe, expect, it } from "vitest";
import { applySnapshot, snapshotLooksTruncated, startRound, type Holder } from "../src/logic/holders.js";
import { planFunding, planCycleQuote, scheduleNextCycle, shouldRotate, type VolumeConfig } from "../src/logic/volume.js";
import {
  applyBuy, applySell, decide, DEFAULT_TRANCHES, INITIAL_BOT, nextSellTrigger, parseTranches, scheduleNext, sliceCap,
  type BotConfig, type BotState, type Market,
} from "../src/logic/bot.js";
import { airdropWeights, allocate, DEFAULT_TIERS, multiplier, nextTier, parseTiers, planBuyback } from "../src/logic/airdrop.js";
import { recenter, shouldRebalance, nextHalfWidth, planDeploy } from "../src/logic/dlmm.js";

const H = (owner: string, balance: bigint, heldSince: number, minSinceRound: bigint = balance): Holder => ({ owner, balance, heldSince, minSinceRound });
const map = (...hs: Holder[]) => new Map(hs.map((h) => [h.owner, h]));

describe("holder clock", () => {
  it("starts on first sight, keeps on growth, resets on any decrease", () => {
    let m = applySnapshot(new Map(), new Map([["a", 100n]]), 1);
    m = applySnapshot(m, new Map([["a", 150n]]), 2);
    expect(m.get("a")!.heldSince).toBe(1);
    m = applySnapshot(m, new Map([["a", 149n]]), 3);
    expect(m.get("a")!.heldSince).toBe(3);
  });
  it("resets a wallet caught selling between snapshots even if it rebought", () => {
    const m = applySnapshot(map(H("a", 100n, 1)), new Map([["a", 100n]]), 5, new Set(["a"]));
    expect(m.get("a")!.heldSince).toBe(5);
  });
  it("drops wallets that exit fully", () => {
    expect(applySnapshot(map(H("a", 100n, 1)), new Map(), 2).size).toBe(0);
  });
  it("tracks the lowest balance this round: a top-up doesn't raise it", () => {
    let m = applySnapshot(new Map(), new Map([["a", 1n]]), 1);
    m = applySnapshot(m, new Map([["a", 10_000n]]), 2); // big buy right before the round
    expect(m.get("a")!.minSinceRound).toBe(1n);
    expect(m.get("a")!.heldSince).toBe(1); // growth keeps the clock
    m = startRound(m); // the round paid: the window starts over
    expect(m.get("a")!.minSinceRound).toBe(10_000n);
  });
  it("refuses a snapshot that lost most known holders at once", () => {
    expect(snapshotLooksTruncated(100, 0)).toBe(true);
    expect(snapshotLooksTruncated(100, 49)).toBe(true);
    expect(snapshotLooksTruncated(100, 80)).toBe(false);
    expect(snapshotLooksTruncated(5, 0)).toBe(false); // too small to judge at launch
  });
});

describe("volume bot", () => {
  const c: VolumeConfig = {
    everyMs: 90_000, timingJitter: 0, cyclesPerWallet: 6, fundPct: 0.2, fundJitter: 0,
    minQuote: 100n, maxImpactPct: 0.01, subSolLamports: 10_000_000, slippagePct: 5,
  };
  const deep = { quote: 10n ** 15n, base: 10n ** 15n };
  const thin = { quote: 100_000n, base: 100_000n }; // sliceCap(buy, 0.01) = 498

  it("seeds a paced fraction of the bucket into each sub", () => {
    expect(planFunding({ bucketQuote: 1_000_000n, reserves: deep, config: c, rand: 0.5 })).toBe(200_000n); // 20%
  });
  it("holds when the bucket is below the minimum, and floors a tiny seed at minQuote", () => {
    expect(planFunding({ bucketQuote: 50n, reserves: deep, config: c, rand: 0.5 })).toBe(0n);
    expect(planFunding({ bucketQuote: 300n, reserves: deep, config: c, rand: 0.5 })).toBe(100n); // 20% = 60 < min
  });
  it("caps the seed so one buy can't move price past maxImpactPct", () => {
    expect(planFunding({ bucketQuote: 1_000_000n, reserves: thin, config: c, rand: 0.5 })).toBe(498n);
  });
  it("jitters the seed size", () => {
    expect(planFunding({ bucketQuote: 1_000_000n, reserves: deep, config: { ...c, fundJitter: 0.4 }, rand: 0 })).toBe(160_000n); // 0.2*(1-0.2)=0.16
  });

  it("a cycle spends what the sub holds, capped by impact, skipping dust", () => {
    expect(planCycleQuote({ subQuote: 200_000n, reserves: deep, config: c })).toBe(200_000n);
    expect(planCycleQuote({ subQuote: 200_000n, reserves: thin, config: c })).toBe(498n);
    expect(planCycleQuote({ subQuote: 50n, reserves: deep, config: c })).toBe(0n); // below min
    expect(planCycleQuote({ subQuote: 200_000n, reserves: { quote: 10_000n, base: 10_000n }, config: c })).toBe(0n); // cap (49) < min
  });

  it("jitters the cycle gap so it is not a metronome", () => {
    expect(scheduleNextCycle(0, { ...c, timingJitter: 0.6 }, 0)).toBe(63_000); // -30%
    expect(scheduleNextCycle(0, { ...c, timingJitter: 0.6 }, 1)).toBe(117_000); // +30%
  });

  it("rotates to a fresh sub when there is none or the active one hit its cap", () => {
    expect(shouldRotate({ sub: null, cyclesDone: 0, nextCycleAt: 0 }, c)).toBe(true);
    expect(shouldRotate({ sub: "x", cyclesDone: 6, nextCycleAt: 0 }, c)).toBe(true);
    expect(shouldRotate({ sub: "x", cyclesDone: 5, nextCycleAt: 0 }, c)).toBe(false);
  });
});

describe("price stabilizer", () => {
  const c: BotConfig = {
    tranches: DEFAULT_TRANCHES, rearmGap: 0.1, topStepPct: 0.5, sellFraction: 0.5, minSellPremium: 0.1,
    maxImpactPct: 0.02, sliceGapMs: 60_000, sliceJitter: 0, crashPct: 0.6, pauseMs: 30 * 60_000,
    minAnchorSamples: 10, minQuoteToBuy: 10n, minTokensToSell: 10n,
  };
  const deep = { quote: 10n ** 15n, base: 10n ** 15n }; // impact never binds
  const thin = { quote: 10_000n, base: 10_000n };
  const mk = (price: number, o: Partial<Market> = {}): Market =>
    ({ price, anchor: 1, anchorSamples: 100, recentHigh: Math.max(1, price), priceAgo: price, reserves: deep, ...o });
  const run = (price: number, s: BotState, quoteBalance = 1000n, now = 0, o: Partial<Market> = {}) =>
    decide({ market: mk(price, o), quoteBalance, state: s, now, config: c });
  const holding = (s: BotState): BotState => ({ ...applyBuy({ ...s, armed: [false, false, false, false] }, 1000n, 1000n, 0), order: null }); // entry 1.0

  it("holds inside the band and while the anchor warms up", () => {
    expect(run(0.9, INITIAL_BOT).decision.reason).toBe("inside the band");
    expect(run(0.5, INITIAL_BOT, 1000n, 0, { anchorSamples: 3 }).decision.reason).toMatch(/warming up/);
  });

  it("fires only the first tranche at -15%, keeping the rest for deeper dips", () => {
    const { state, decision } = run(0.84, INITIAL_BOT);
    expect(decision).toMatchObject({ action: "buy", quote: 100n }); // 10 of 100 parts
    expect(state.armed).toEqual([false, true, true, true]);
  });

  it("scales in: each deeper tranche gets its weight of what is still armed", () => {
    const s = applyBuy(run(0.84, INITIAL_BOT).state, 100n, 119n, 0);
    const r = run(0.74, s, 900n);
    expect(r.decision).toMatchObject({ action: "buy", quote: 200n }); // 20 of the remaining 90 parts of 900
    expect(r.state.armed).toEqual([false, false, true, true]);
  });

  it("a gap straight down through every level spends the whole bucket", () => {
    expect(run(0.45, INITIAL_BOT).decision).toMatchObject({ action: "buy", quote: 1000n });
  });

  it("slices a buy so no swap moves price more than maxImpactPct", () => {
    expect(sliceCap("buy", thin, 0.02)).toBe(99n); // 10,000 * (sqrt(1.02) - 1)
    const r1 = run(0.45, INITIAL_BOT, 1000n, 0, { reserves: thin });
    expect(r1.decision).toMatchObject({ action: "buy", quote: 99n });
    const s = scheduleNext(applyBuy(r1.state, 99n, 200n, 0), 0, c, 0.5);
    expect(s.order?.remaining).toBe(901n);
    expect(run(0.45, s, 901n, 30_000, { reserves: thin }).decision.reason).toMatch(/next slice soon/);
    expect(run(0.45, s, 901n, 60_000, { reserves: thin }).decision).toMatchObject({ action: "buy", quote: 99n });
  });

  it("cancels the rest of a buy order when price recovers, and re-arms", () => {
    const r1 = run(0.84, INITIAL_BOT, 1000n, 0, { reserves: thin });
    const s = applyBuy(r1.state, 99n, 100n, 0);
    expect(s.order?.remaining).toBe(1n);
    const r2 = run(0.97, s, 901n, 60_000, { reserves: thin });
    expect(r2.decision.reason).toBe("buy order cancelled: price recovered");
    expect(r2.state.order).toBeNull();
    expect(r2.state.armed).toEqual([true, true, true, true]);
  });

  it("does not re-arm a tranche until price clears its level by rearmGap", () => {
    const s = { ...applyBuy(run(0.84, INITIAL_BOT).state, 100n, 119n, 0), order: null };
    expect(run(0.9, s).state.armed[0]).toBe(false); // 0.85 * 1.1 = 0.935
    expect(run(0.94, s).state.armed[0]).toBe(true);
  });

  it("a crash pauses buying instead of pouring the bucket into it", () => {
    const r = run(0.3, INITIAL_BOT, 1000n, 0, { recentHigh: 1 });
    expect(r.decision.reason).toMatch(/crash/);
    expect(r.state.pausedUntil).toBe(30 * 60_000);
    expect(run(0.3, r.state, 1000n, 10 * 60_000, { recentHigh: 0.32 }).decision.reason).toMatch(/paused/);
    expect(run(0.3, r.state, 1000n, 31 * 60_000, { recentHigh: 0.32 }).decision.action).toBe("buy");
  });

  it("sells half per rung, only above the anchor and while rising", () => {
    let s = holding(INITIAL_BOT);
    expect(run(1.5, s, 0n, 0, { anchor: 1.45 }).decision.reason).toBe("inside the band"); // under anchor +10%
    expect(run(1.5, s, 0n, 0, { priceAgo: 1.6 }).decision.reason).toBe("inside the band"); // falling
    const r1 = run(1.5, s, 0n);
    expect(r1.decision).toMatchObject({ action: "sell", tokens: 500n, rung: 1 });
    s = applySell(r1.state, 500n);
    expect(s.order).toBeNull();
    expect(nextSellTrigger(s, c)).toBe(2);
    expect(run(1.6, s, 0n).decision.action).toBe("hold");
    expect(run(2.0, s, 0n).decision).toMatchObject({ tokens: 250n, rung: 2 });
  });

  it("abandons a sell order if price falls back under entry", () => {
    const r1 = run(1.5, holding(INITIAL_BOT), 0n, 0, { reserves: thin });
    expect(r1.decision).toMatchObject({ action: "sell", tokens: sliceCap("sell", thin, 0.02) });
    const s = applySell(r1.state, sliceCap("sell", thin, 0.02));
    expect(s.order).not.toBeNull();
    expect(run(0.95, s, 0n, 1e9, { reserves: thin }).decision.reason).toMatch(/sell order cancelled/);
  });

  it("parses tranche specs shallow to deep", () => {
    expect(parseTranches("0.3:5,0.1:1")).toEqual([{ below: 0.1, weight: 1 }, { below: 0.3, weight: 5 }]);
    expect(() => parseTranches("1.2:5")).toThrow();
  });

  it("averages entry across buys and resets the ladder", () => {
    const s = applyBuy(applySell(applyBuy(INITIAL_BOT, 100n, 100n, 0), 50n), 100n, 50n, 1);
    expect(s.tokens).toBe(100n);
    expect(s.ladderStep).toBe(0);
  });
});

describe("dlmm range (bucket 3)", () => {
  it("re-centers a +/-halfWidth band on the active bin", () => {
    expect(recenter(100, 34)).toEqual({ minBinId: 66, maxBinId: 134 });
    expect(recenter(-5, 10)).toEqual({ minBinId: -15, maxBinId: 5 });
  });
  it("is out of range only when the active bin has left the position", () => {
    expect(shouldRebalance(100, 90, 110)).toBe(false);
    expect(shouldRebalance(90, 90, 110)).toBe(false); // edges are still in
    expect(shouldRebalance(89, 90, 110)).toBe(true);
    expect(shouldRebalance(111, 90, 110)).toBe(true);
  });
  it("keeps the current width or uses a fixed one", () => {
    expect(nextHalfWidth({ halfWidth: 34, keepWidth: true }, 60, 140)).toBe(40); // (140-60)/2
    expect(nextHalfWidth({ halfWidth: 34, keepWidth: false }, 60, 140)).toBe(34);
  });
  it("deploys idle $PUMP only at or above the minimum", () => {
    expect(planDeploy(1000n, 500n)).toBe(1000n);
    expect(planDeploy(400n, 500n)).toBe(0n);
  });
});

describe("loyalty airdrop", () => {
  const hour = 3_600_000;
  const opts = { tiers: DEFAULT_TIERS, exclude: new Set(["bot"]), minBalance: 1n };

  it("multiplier: 0 before 1h, 1x at 1h, linear between tiers, capped at 3x from 7d", () => {
    expect(multiplier(hour - 1, DEFAULT_TIERS)).toBe(0);
    expect(multiplier(hour, DEFAULT_TIERS)).toBe(1);
    expect(multiplier(12.5 * hour, DEFAULT_TIERS)).toBeCloseTo(1.25);
    expect(multiplier(24 * hour, DEFAULT_TIERS)).toBe(1.5);
    expect(multiplier(168 * hour, DEFAULT_TIERS)).toBe(3);
    expect(multiplier(1000 * hour, DEFAULT_TIERS)).toBe(3);
    expect(nextTier(30 * hour, DEFAULT_TIERS)).toMatchObject({ mult: 2, inMs: 42 * hour });
    expect(nextTier(200 * hour, DEFAULT_TIERS)).toBeNull();
  });

  it("only pays wallets past the first tier, dev included, engine wallets out", () => {
    const hs = [H("dev", 100n, 0), H("old", 100n, 0), H("new", 100n, hour), H("bot", 100n, 0)];
    expect(airdropWeights(hs, hour + 1, opts).map((h) => h.owner)).toEqual(["dev", "old"]);
  });

  it("a 7-day holder out-earns a bigger 1-hour holder", () => {
    const [loyal, fresh] = airdropWeights([H("loyal", 100n, 0), H("fresh", 200n, 167 * hour)], 168 * hour, opts);
    expect(loyal.weight).toBe(300_000n); // 100 x 3.000
    expect(fresh.weight).toBe(200_000n); // 200 x 1.000
  });

  it("counts the lowest balance this round, so a last-minute top-up earns nothing", () => {
    const [w] = airdropWeights([H("t", 10_001n, 0, 1n)], 2 * hour, opts);
    expect(w.counted).toBe(1n);
  });

  it("buys back in slices that spend the bucket by the round's end", () => {
    const base = { quoteBalance: 1200n, now: 0, roundEnd: hour, sliceGapMs: 5 * 60_000, minQuote: 10n, maxImpactPct: 0.01, reserves: null };
    expect(planBuyback(base)).toBe(100n); // 12 slices left
    expect(planBuyback({ ...base, now: hour - 1 })).toBe(1200n); // last slice: everything
    expect(planBuyback({ ...base, now: 2 * hour })).toBe(1200n); // overdue round: everything
    expect(planBuyback({ ...base, quoteBalance: 5n })).toBe(0n); // under the minimum
    expect(planBuyback({ ...base, quoteBalance: 60n })).toBe(10n); // floor
    expect(planBuyback({ ...base, now: hour - 1, reserves: { quote: 10_000n, base: 10_000n } })).toBe(49n); // impact cap
  });

  it("parses tiers in hours", () => {
    expect(parseTiers("24:1.5,1:1")).toEqual([{ ms: hour, mult: 1 }, { ms: 24 * hour, mult: 1.5 }]);
  });

  it("splits by weight and re-splits after dropping dust", () => {
    const r = allocate(1000n, [{ owner: "a", weight: 900n }, { owner: "b", weight: 99n }, { owner: "c", weight: 1n }], 5n);
    expect(r.payouts).toEqual([
      { owner: "a", amount: 900n },
      { owner: "b", amount: 99n },
    ]);
    expect(r.leftover).toBe(1n);
  });
});
