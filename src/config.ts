import "dotenv/config";
import { readFileSync } from "node:fs";
import { Keypair, PublicKey } from "@solana/web3.js";
import { DEFAULT_TRANCHES, parseTranches } from "./logic/bot.js";
import { DEFAULT_TIERS, parseTiers } from "./logic/airdrop.js";

const env = (k: string, d?: string) => {
  const v = process.env[k] ?? d;
  if (v === undefined || v === "") throw new Error(`missing env ${k}`);
  return v;
};
const num = (k: string, d: number) => Number(process.env[k] ?? d);
const big = (k: string, d: string) => BigInt(process.env[k] ?? d);

// A keypair from a file path, or inline as the JSON byte array itself (how
// hosts like Render pass secrets).
export const loadKeypair = (pathOrJson: string) =>
  Keypair.fromSecretKey(Uint8Array.from(JSON.parse(pathOrJson.trim().startsWith("[") ? pathOrJson : readFileSync(pathOrJson, "utf8"))));

// $PUMP — listed in pump.fun's QuoteControl, so it is a "custom pair" quote
// and create_v2 accepts creator_fee_bps up to Global.max_configurable (300).
export const PUMP_MINT = new PublicKey("pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn");

export function loadConfig() {
  return {
    rpcUrl: env("RPC_URL"),
    databaseUrl: env("DATABASE_URL"),
    port: num("PORT", 8787), // Render injects PORT
    dryRun: (process.env.DRY_RUN ?? "true") !== "false",
    priorityMicroLamports: num("PRIORITY_MICRO_LAMPORTS", 50_000),

    // Before launch MINT is empty: the dashboard serves "awaiting launch" and nothing ticks.
    prelaunch: !process.env.MINT,
    mint: new PublicKey(process.env.MINT || PublicKey.default.toBase58()),
    quoteMint: new PublicKey(process.env.QUOTE_MINT ?? PUMP_MINT.toBase58()),
    devWallet: new PublicKey(process.env.DEV_WALLET || PublicKey.default.toBase58()),
    launchTime: process.env.LAUNCH_TIME ? Date.parse(process.env.LAUNCH_TIME) : 0,

    treasury: loadKeypair(env("TREASURY_KEYPAIR")), // the coin's `creator`: receives the 3% and splits it
    volumeWallet: loadKeypair(env("VOLUME_KEYPAIR", process.env.BUYER_KEYPAIR)), // bucket 1 funder (falls back to the old BUYER_KEYPAIR)
    botWallet: loadKeypair(env("BOT_KEYPAIR")),
    airdropWallet: loadKeypair(env("AIRDROP_KEYPAIR")),

    tickMs: num("TICK_MS", 30_000),
    claimEveryMs: num("CLAIM_EVERY_MS", 10 * 60_000),
    minSolLamports: num("MIN_SOL_LAMPORTS", 5_000_000), // below this a wallet stops sending (0.005 SOL)
    failBackoffMs: num("FAIL_BACKOFF_MS", 5 * 60_000), // a failed money step sits out this long

    volume: {
      everyMs: num("VOLUME_EVERY_MS", 90_000), // one buy+sell cycle every ~90s
      timingJitter: num("VOLUME_TIMING_JITTER", 0.6),
      cyclesPerWallet: num("VOLUME_CYCLES_PER_WALLET", 6), // rotate to a fresh sub after this many cycles
      fundPct: num("VOLUME_FUND_PCT", 0.2), // seed ~20% of the bucket into each sub
      fundJitter: num("VOLUME_FUND_JITTER", 0.4),
      minQuote: big("VOLUME_MIN_QUOTE", "100000000"), // 100 PUMP: smallest seed / cycle
      maxImpactPct: num("VOLUME_MAX_IMPACT_PCT", 0.01), // no single buy moves price more than 1%
      subSolLamports: num("VOLUME_SUB_SOL_LAMPORTS", 10_000_000), // 0.01 SOL seeded per sub for gas + ATA rent
      slippagePct: num("SLIPPAGE_PCT", 5),
    },
    bot: {
      // "below:weight" pairs: 15% under the anchor with 10 parts of the bucket, ...
      tranches: process.env.BOT_TRANCHES ? parseTranches(process.env.BOT_TRANCHES) : DEFAULT_TRANCHES,
      rearmGap: num("BOT_REARM_GAP", 0.1),
      topStepPct: num("BOT_TOP_STEP_PCT", 0.5),
      sellFraction: 0.5,
      minSellPremium: num("BOT_MIN_SELL_PREMIUM", 0.1),
      maxImpactPct: num("BOT_MAX_IMPACT_PCT", 0.02),
      sliceGapMs: num("BOT_SLICE_GAP_MS", 90_000),
      sliceJitter: num("BOT_SLICE_JITTER", 0.5),
      crashPct: num("BOT_CRASH_PCT", 0.6),
      crashWindowMs: num("BOT_CRASH_WINDOW_MS", 15 * 60_000),
      pauseMs: num("BOT_PAUSE_MS", 30 * 60_000),
      anchorWindowMs: num("BOT_ANCHOR_WINDOW_MS", 6 * 3_600_000),
      momentumMs: num("BOT_MOMENTUM_MS", 10 * 60_000),
      minAnchorSamples: num("BOT_MIN_ANCHOR_SAMPLES", 60), // 30 min of 30s ticks
      minQuoteToBuy: big("BOT_MIN_QUOTE", "1000000000"), // 1,000 PUMP
      minTokensToSell: big("BOT_MIN_TOKENS", "1000000000"),
      slippagePct: num("SLIPPAGE_PCT", 5),
    },
    airdrop: {
      // "hours:multiplier" loyalty tiers. The first tier is also the eligibility age.
      tiers: process.env.AIRDROP_TIERS ? parseTiers(process.env.AIRDROP_TIERS) : DEFAULT_TIERS,
      everyMs: num("AIRDROP_EVERY_MS", 60 * 60_000),
      sliceGapMs: num("AIRDROP_SLICE_GAP_MS", 5 * 60_000), // buyback slices through the round
      maxImpactPct: num("AIRDROP_MAX_IMPACT_PCT", 0.01),
      minBalance: big("AIRDROP_MIN_BALANCE", "1000000"), // 1 token
      minPayout: big("AIRDROP_MIN_PAYOUT", "1000000"),
      minQuote: big("AIRDROP_MIN_QUOTE", "100000000"), // 100 $PUMP
    },
    dlmm: {
      halfWidth: num("DLMM_HALF_WIDTH", 34), // bins each side of the active bin (the position width)
      keepWidth: (process.env.DLMM_KEEP_WIDTH ?? "true") !== "false", // reuse the current width when re-centering
      minQuote: big("DLMM_MIN_QUOTE", "1000000000"), // 1,000 $PUMP: smallest LP deploy
      binStep: num("DLMM_BIN_STEP", 100), // pool bin step in bps, used only when the engine creates the pair
      baseFeeBps: num("DLMM_BASE_FEE_BPS", 100), // pool base fee in bps, used only on pool creation
      slippageBps: num("DLMM_SLIPPAGE_BPS", 50), // swap/add slippage for LP ops
    },
  };
}

export type Config = ReturnType<typeof loadConfig>;
