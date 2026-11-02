// Bucket 2: price stabilizer. A counter-cyclical ladder around a slow anchor
// (time-weighted average price), worked in small slices so it absorbs moves
// instead of making them.
//
// Buys: the bucket is split into tranches at deepening levels under the
// anchor (default -15/-25/-35/-50% with 10/20/30/40% of the money). Each
// tranche fires once and re-arms only after price recovers past its level.
// Sells: half the bag per rung (+50%, +100%, ... over average entry), only
// above the anchor, only while price is rising, never under entry.
// Orders are sliced so no single swap moves price more than `maxImpactPct`,
// with jittered gaps between slices. A crash (fast collapse from the recent
// high) cancels buying and pauses it, so the bucket isn't poured into a dump.

export type Tranche = { below: number; weight: number }; // 0.15 = 15% under the anchor

export type Order = {
  side: "buy" | "sell";
  remaining: bigint; // quote for a buy, tokens for a sell
  level: number; // buy: shallowest tranche level fired; sell: the rung
  reason: string;
};

export type BotState = {
  tokens: bigint;
  avgEntry: number | null; // quote per token (both 6 decimals, so raw/raw)
  ladderStep: number; // sell rungs used since the last buy
  lastBuyAt: number | null;
  armed: boolean[]; // one per tranche
  order: Order | null; // being worked in slices
  nextSliceAt: number;
  pausedUntil: number;
};

export type BotConfig = {
  tranches: Tranche[];
  rearmGap: number; // a fired tranche re-arms once price is this far back above its level
  topStepPct: number; // 0.5 = sell rungs at +50%, +100%, +150% over entry
  sellFraction: number; // 0.5 = sell half the bag per rung
  minSellPremium: number; // only sell this far above the anchor
  maxImpactPct: number; // per slice
  sliceGapMs: number;
  sliceJitter: number; // 0.5 = gap varies +/-25%
  crashPct: number; // 0.6 = a 60% fall from the recent high pauses buying
  pauseMs: number;
  minAnchorSamples: number;
  minQuoteToBuy: bigint;
  minTokensToSell: bigint;
};

export type Market = {
  price: number;
  anchor: number; // TWAP over the anchor window
  anchorSamples: number;
  recentHigh: number; // max over the crash window
  priceAgo: number; // price one momentum window ago
  reserves: { quote: bigint; base: bigint } | null;
};

export type Decision =
  | { action: "buy"; quote: bigint; reason: string }
  | { action: "sell"; tokens: bigint; rung: number; reason: string }
  | { action: "hold"; reason: string };

export const INITIAL_BOT: BotState = {
  tokens: 0n, avgEntry: null, ladderStep: 0, lastBuyAt: null,
  armed: [], order: null, nextSliceAt: 0, pausedUntil: 0,
};

export const DEFAULT_TRANCHES: Tranche[] = [
  { below: 0.15, weight: 10 },
  { below: 0.25, weight: 20 },
  { below: 0.35, weight: 30 },
  { below: 0.5, weight: 40 },
];

// "0.15:10,0.25:20" -> tranches, sorted shallow to deep.
export function parseTranches(s: string): Tranche[] {
  const t = s.split(",").map((p) => {
    const [below, weight] = p.split(":").map(Number);
    if (!(below > 0 && below < 1 && weight > 0)) throw new Error(`bad tranche "${p}"`);
    return { below, weight };
  });
  return t.sort((a, b) => a.below - b.below);
}

export function nextSellTrigger(s: BotState, c: Pick<BotConfig, "topStepPct">): number | null {
  return s.avgEntry === null ? null : s.avgEntry * (1 + c.topStepPct * (s.ladderStep + 1));
}

export const trancheLine = (anchor: number, t: Tranche) => anchor * (1 - t.below);

// Largest swap whose price impact stays under `impact`, on a constant-product
// curve (pump.fun curve and PumpSwap pool both are). A buy of dq quote moves
// price by (1 + dq/Q)^2; a sell of db tokens by (B / (B + db))^2.
export function sliceCap(side: "buy" | "sell", r: { quote: bigint; base: bigint }, impact: number): bigint {
  const f = side === "buy" ? Math.sqrt(1 + impact) - 1 : 1 / Math.sqrt(1 - impact) - 1;
  return BigInt(Math.floor(Number(side === "buy" ? r.quote : r.base) * f));
}

function normalize(s: BotState, c: BotConfig): BotState {
  return { ...s, armed: c.tranches.map((_, i) => s.armed?.[i] ?? true) };
}

/**
 * Plan this tick. Returns the state to keep (arming, orders, pauses) and the
 * one swap to make now, if any. Pure: the engine executes the swap and folds
 * the fill back in with applyBuy / applySell.
 */
export function decide(input: {
  market: Market;
  quoteBalance: bigint;
  state: BotState;
  now: number;
  config: BotConfig;
}): { state: BotState; decision: Decision } {
  const { market: m, quoteBalance, now, config: c } = input;
  let s = normalize(input.state, c);
  const hold = (reason: string) => ({ state: s, decision: { action: "hold" as const, reason } });

  if (!(m.price > 0)) return hold("no price");
  if (m.anchorSamples < c.minAnchorSamples || !(m.anchor > 0))
    return hold(`warming up: ${m.anchorSamples}/${c.minAnchorSamples} price samples`);

  const crashed = m.recentHigh > 0 && m.price <= m.recentHigh * (1 - c.crashPct);
  if (crashed && now >= s.pausedUntil) s = { ...s, pausedUntil: now + c.pauseMs };

  // Re-arm tranches price has recovered past.
  const armed = s.armed.map((a, i) => a || m.price >= trancheLine(m.anchor, c.tranches[i]) * (1 + c.rearmGap));
  s = { ...s, armed };

  // 1. An order in progress: cancel it if conditions turned, else work the next slice.
  if (s.order) {
    const o = s.order;
    const cancel =
      o.side === "buy"
        ? crashed ? "crash" : m.price >= m.anchor * (1 - o.level + c.rearmGap) ? "price recovered" : null
        : m.price < Math.max(s.avgEntry ?? 0, m.anchor) ? "price fell back under entry/anchor" : null;
    if (cancel) {
      s = { ...s, order: null };
      return hold(`${o.side} order cancelled: ${cancel}`);
    }
    if (now < s.nextSliceAt) return hold(`working ${o.side} order, next slice soon`);
    return { state: s, decision: slice(s, o, m, quoteBalance, c) };
  }

  // 2. Sell into strength.
  const trigger = nextSellTrigger(s, c);
  if (
    trigger !== null &&
    s.tokens >= c.minTokensToSell &&
    m.price >= trigger &&
    m.price >= m.anchor * (1 + c.minSellPremium) &&
    m.price >= m.priceAgo
  ) {
    const tokens = (s.tokens * BigInt(Math.round(c.sellFraction * 10_000))) / 10_000n;
    if (tokens > 0n) {
      const rung = s.ladderStep + 1;
      const order: Order = { side: "sell", remaining: tokens, level: rung, reason: `rung ${rung}: price ${fmt(m.price)} ≥ ${fmt(trigger)}` };
      s = { ...s, order, ladderStep: rung };
      return { state: s, decision: slice(s, order, m, quoteBalance, c) };
    }
  }

  // 3. Buy the dip, tranche by tranche.
  if (now < s.pausedUntil) return hold(crashed ? "crash: buying paused" : "buying paused after a crash");
  const fired = c.tranches.map((t, i) => s.armed[i] && m.price <= trancheLine(m.anchor, t));
  if (!fired.some(Boolean)) return hold("inside the band");
  if (quoteBalance < c.minQuoteToBuy) return hold("bucket below minimum");

  // Fired weight over all still-armed weight, so later fee income tops up
  // every tranche in proportion and a gap down through several levels fires them together.
  const w = (pick: (i: number) => boolean) => BigInt(Math.round(c.tranches.reduce((a, t, i) => a + (pick(i) ? t.weight : 0), 0) * 1e6));
  const quote = (quoteBalance * w((i) => fired[i])) / w((i) => s.armed[i]);
  const deepest = fired.lastIndexOf(true);
  const level = c.tranches[fired.indexOf(true)].below;
  const order: Order = {
    side: "buy", remaining: quote, level,
    reason: `${Math.round(c.tranches[deepest].below * 100)}% under anchor ${fmt(m.anchor)}`,
  };
  s = { ...s, order, armed: s.armed.map((a, i) => a && !fired[i]) };
  return { state: s, decision: slice(s, order, m, quoteBalance, c) };
}

function slice(s: BotState, o: Order, m: Market, quoteBalance: bigint, c: BotConfig): Decision {
  const floor = o.side === "buy" ? c.minQuoteToBuy : c.minTokensToSell;
  const cap = m.reserves ? sliceCap(o.side, m.reserves, c.maxImpactPct) : o.remaining;
  const have = o.side === "buy" ? quoteBalance : s.tokens;
  let amt = [o.remaining, cap > floor ? cap : floor, have].reduce((a, b) => (b < a ? b : a));
  // Don't leave a dust tail smaller than a slice could be.
  if (o.remaining - amt < floor && o.remaining <= have) amt = o.remaining;
  if (amt <= 0n) return { action: "hold", reason: `${o.side} order: nothing left to trade` };
  const part = amt < o.remaining ? ` (slice, ${o.remaining - amt} left)` : "";
  return o.side === "buy"
    ? { action: "buy", quote: amt, reason: o.reason + part }
    : { action: "sell", tokens: amt, rung: o.level, reason: o.reason + part };
}

// Called just before a slice is sent: the gap starts even if it fails, so no retry storms.
export function scheduleNext(s: BotState, now: number, c: Pick<BotConfig, "sliceGapMs" | "sliceJitter">, rand: number): BotState {
  return { ...s, nextSliceAt: now + Math.round(c.sliceGapMs * (1 + c.sliceJitter * (rand - 0.5))) };
}

function consume(o: Order | null, side: Order["side"], amount: bigint): Order | null {
  if (!o || o.side !== side) return o;
  const remaining = o.remaining - amount;
  return remaining > 0n ? { ...o, remaining } : null;
}

export function applyBuy(s: BotState, quoteSpent: bigint, tokensGot: bigint, now: number): BotState {
  const tokens = s.tokens + tokensGot;
  const cost = (s.avgEntry ?? 0) * Number(s.tokens) + Number(quoteSpent);
  return { ...s, tokens, avgEntry: tokens > 0n ? cost / Number(tokens) : null, ladderStep: 0, lastBuyAt: now, order: consume(s.order, "buy", quoteSpent) };
}

export function applySell(s: BotState, tokensSold: bigint): BotState {
  const tokens = s.tokens - tokensSold;
  return { ...s, tokens, avgEntry: tokens > 0n ? s.avgEntry : null, order: consume(s.order, "sell", tokensSold) };
}

// A landed buy whose fill size is unknown (crash recovery): only the order shrinks.
export function consumeBuy(s: BotState, quoteSpent: bigint): BotState {
  return { ...s, order: consume(s.order, "buy", quoteSpent) };
}

const fmt = (n: number) => n.toPrecision(4);
