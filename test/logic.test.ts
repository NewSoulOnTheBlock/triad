import { describe, expect, it } from "vitest";
import { applySnapshot, rankByAge, snapshotLooksTruncated, type Holder } from "../src/logic/holders.js";
import { EMPTY_LADDER, milestoneReached, nextLadder, splitEven } from "../src/logic/prize.js";
import { applyBuy, applySell, decide, INITIAL_BOT, type BotConfig } from "../src/logic/bot.js";
import { airdropEligible, allocate } from "../src/logic/airdrop.js";

const H = (owner: string, balance: bigint, heldSince: number, qualifiedSince: number | null = heldSince): Holder => ({ owner, balance, heldSince, qualifiedSince });
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
  it("ranks by qualified clock, honouring exclusions and unqualified wallets", () => {
    const r = rankByAge([H("dev", 90n, 0), H("b", 50n, 2), H("a", 50n, 1), H("dust", 1n, 0, null)], { exclude: new Set(["dev"]) });
    expect(r.map((h) => h.owner)).toEqual(["a", "b"]);
  });
  it("a dust buy at launch topped up later gets no seniority", () => {
    let m = applySnapshot(new Map(), new Map([["sniper", 1n], ["real", 100n]]), 1, new Set(), 50n);
    expect(m.get("sniper")!.qualifiedSince).toBeNull();
    m = applySnapshot(m, new Map([["sniper", 100n], ["real", 100n]]), 9, new Set(), 50n);
    expect(m.get("sniper")!.heldSince).toBe(1); // still counts for the 1h airdrop clock
    expect(m.get("sniper")!.qualifiedSince).toBe(9); // but the prize clock starts at the top-up
    expect(rankByAge(m.values(), { exclude: new Set() }).map((h) => h.owner)).toEqual(["real", "sniper"]);
  });
  it("dropping under the prize minimum loses the prize clock", () => {
    let m = applySnapshot(new Map(), new Map([["a", 100n]]), 1, new Set(), 50n);
    m = applySnapshot(m, new Map([["a", 40n]]), 2, new Set(), 50n);
    expect(m.get("a")!.qualifiedSince).toBeNull();
  });
  it("refuses a snapshot that lost most known holders at once", () => {
    expect(snapshotLooksTruncated(100, 0)).toBe(true);
    expect(snapshotLooksTruncated(100, 49)).toBe(true);
    expect(snapshotLooksTruncated(100, 80)).toBe(false);
    expect(snapshotLooksTruncated(5, 0)).toBe(false); // too small to judge at launch
  });
});

describe("prize ladder", () => {
  it("grows while #1 repeats, resets when #1 changes", () => {
    const r1 = nextLadder(["a", "b", "c"], EMPTY_LADDER)!;
    expect(r1.winners).toEqual(["a"]);
    const r2 = nextLadder(["a", "b", "c"], r1.state)!;
    expect(r2.winners).toEqual(["a", "b"]);
    const r3 = nextLadder(["a", "b", "c"], r2.state)!;
    expect(r3.winners).toEqual(["a", "b", "c"]);
    const r4 = nextLadder(["b", "c"], r3.state)!; // a sold
    expect(r4.winners).toEqual(["b"]);
  });
  it("splits evenly, dust to the longest holder", () => {
    expect(splitEven(10n, 3)).toEqual([4n, 3n, 3n]);
  });
  it("pays each $25k level once", () => {
    expect(milestoneReached(24_999, 25_000, 0)).toBeNull();
    expect(milestoneReached(25_000, 25_000, 0)).toBe(1);
    expect(milestoneReached(49_000, 25_000, 1)).toBeNull();
    expect(milestoneReached(80_000, 25_000, 1)).toBe(3);
  });
});

describe("dip/top bot", () => {
  const c: BotConfig = { dipPct: 0.2, topStepPct: 0.5, sellFraction: 0.5, cooldownMs: 60_000, minQuoteToBuy: 10n, minTokensToSell: 10n };
  it("buys with the full bucket on a dip", () => {
    const d = decide({ price: 0.79, high24: 1, quoteBalance: 500n, state: INITIAL_BOT, now: 0, config: c });
    expect(d).toMatchObject({ action: "buy", quote: 500n });
  });
  it("holds when not dipped, and during cooldown", () => {
    expect(decide({ price: 0.9, high24: 1, quoteBalance: 500n, state: INITIAL_BOT, now: 0, config: c }).action).toBe("hold");
    const s = applyBuy(INITIAL_BOT, 100n, 100n, 0);
    expect(decide({ price: 0.5, high24: 1, quoteBalance: 500n, state: s, now: 1000, config: c }).reason).toBe("cooldown");
  });
  it("sells half the bag per rung up the ladder", () => {
    let s = applyBuy(INITIAL_BOT, 1000n, 1000n, 0); // entry 1.0
    const d1 = decide({ price: 1.5, high24: 1.5, quoteBalance: 0n, state: s, now: 1e9, config: c });
    expect(d1).toMatchObject({ action: "sell", tokens: 500n, rung: 1 });
    s = applySell(s, 500n);
    expect(decide({ price: 1.6, high24: 1.6, quoteBalance: 0n, state: s, now: 1e9, config: c }).action).toBe("hold");
    expect(decide({ price: 2.0, high24: 2, quoteBalance: 0n, state: s, now: 1e9, config: c })).toMatchObject({ tokens: 250n, rung: 2 });
  });
  it("averages entry across buys and resets the ladder", () => {
    const s = applyBuy(applySell(applyBuy(INITIAL_BOT, 100n, 100n, 0), 50n), 100n, 50n, 1);
    expect(s.tokens).toBe(100n);
    expect(s.ladderStep).toBe(0);
  });
});

describe("airdrop", () => {
  const hour = 3_600_000;
  it("only pays wallets past the 1h mark, dev included", () => {
    const hs = [H("dev", 100n, 0), H("old", 100n, 0), H("new", 100n, hour)];
    const e = airdropEligible(hs, hour + 1, { minAgeMs: hour, exclude: new Set(["bot"]), minBalance: 1n });
    expect(e.map((h) => h.owner)).toEqual(["dev", "old"]);
  });
  it("splits pro-rata and re-splits after dropping dust", () => {
    const r = allocate(1000n, [H("a", 900n, 0), H("b", 99n, 0), H("c", 1n, 0)], 5n);
    expect(r.payouts).toEqual([
      { owner: "a", amount: 900n },
      { owner: "b", amount: 99n },
    ]);
    expect(r.leftover).toBe(1n);
  });
});
