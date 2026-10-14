// Bucket 2: dip buyer / top taker. Buys with the FULL bucket when price is
// `dipPct` under the rolling high; sells HALF its bag each time price clears
// the next rung of a ladder above its average entry.

export type BotState = {
  tokens: bigint;
  avgEntry: number | null; // quote per token (both 6 decimals, so raw/raw)
  ladderStep: number; // rungs already sold since the last buy
  lastBuyAt: number | null;
};

export type BotConfig = {
  dipPct: number; // 0.2 = buy at 20% under the 24h high
  topStepPct: number; // 0.5 = sell rungs at +50%, +100%, +150% over entry
  sellFraction: number; // 0.5 = sell half the bag per rung
  cooldownMs: number;
  minQuoteToBuy: bigint;
  minTokensToSell: bigint;
};

export type Decision =
  | { action: "buy"; quote: bigint; reason: string }
  | { action: "sell"; tokens: bigint; rung: number; reason: string }
  | { action: "hold"; reason: string };

export const INITIAL_BOT: BotState = { tokens: 0n, avgEntry: null, ladderStep: 0, lastBuyAt: null };

export function nextSellTrigger(s: BotState, c: BotConfig): number | null {
  return s.avgEntry === null ? null : s.avgEntry * (1 + c.topStepPct * (s.ladderStep + 1));
}

export function decide(input: {
  price: number;
  high24: number;
  quoteBalance: bigint;
  state: BotState;
  now: number;
  config: BotConfig;
}): Decision {
  const { price, high24, quoteBalance, state: s, now, config: c } = input;
  if (!(price > 0)) return { action: "hold", reason: "no price" };

  const trigger = nextSellTrigger(s, c);
  if (trigger !== null && s.tokens >= c.minTokensToSell && price >= trigger) {
    const tokens = (s.tokens * BigInt(Math.round(c.sellFraction * 10_000))) / 10_000n;
    if (tokens > 0n)
      return { action: "sell", tokens, rung: s.ladderStep + 1, reason: `price ${fmt(price)} ≥ rung ${s.ladderStep + 1} at ${fmt(trigger)}` };
  }

  const dipLine = high24 * (1 - c.dipPct);
  if (quoteBalance < c.minQuoteToBuy) return { action: "hold", reason: "bucket below minimum" };
  if (s.lastBuyAt !== null && now - s.lastBuyAt < c.cooldownMs) return { action: "hold", reason: "cooldown" };
  if (price <= dipLine)
    return { action: "buy", quote: quoteBalance, reason: `price ${fmt(price)} ≤ ${Math.round(c.dipPct * 100)}% under 24h high ${fmt(high24)}` };
  return { action: "hold", reason: "no dip, no top" };
}

export function applyBuy(s: BotState, quoteSpent: bigint, tokensGot: bigint, now: number): BotState {
  const tokens = s.tokens + tokensGot;
  const cost = (s.avgEntry ?? 0) * Number(s.tokens) + Number(quoteSpent);
  return { tokens, avgEntry: tokens > 0n ? cost / Number(tokens) : null, ladderStep: 0, lastBuyAt: now };
}

export function applySell(s: BotState, tokensSold: bigint): BotState {
  const tokens = s.tokens - tokensSold;
  return { ...s, tokens, ladderStep: s.ladderStep + 1, avgEntry: tokens > 0n ? s.avgEntry : null };
}

const fmt = (n: number) => n.toPrecision(4);
