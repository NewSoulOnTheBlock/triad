import "dotenv/config";
import { readFileSync } from "node:fs";
import { Keypair, PublicKey } from "@solana/web3.js";

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
    port: num("PORT", 8787),
    dryRun: (process.env.DRY_RUN ?? "true") !== "false",
    priorityMicroLamports: num("PRIORITY_MICRO_LAMPORTS", 50_000),

    mint: new PublicKey(env("MINT")),
    quoteMint: new PublicKey(process.env.QUOTE_MINT ?? PUMP_MINT.toBase58()),
    devWallet: new PublicKey(env("DEV_WALLET")),
    launchTime: Date.parse(env("LAUNCH_TIME")),

    treasury: loadKeypair(env("TREASURY_KEYPAIR")), // the coin's `creator`: receives the 3%, holds the prize pot
    botWallet: loadKeypair(env("BOT_KEYPAIR")),
    airdropWallet: loadKeypair(env("AIRDROP_KEYPAIR")),

    tickMs: num("TICK_MS", 30_000),
    claimEveryMs: num("CLAIM_EVERY_MS", 10 * 60_000),
    minSolLamports: num("MIN_SOL_LAMPORTS", 5_000_000), // below this a wallet stops sending (0.005 SOL)
    failBackoffMs: num("FAIL_BACKOFF_MS", 5 * 60_000), // a failed money step sits out this long

    prize: {
      stepUsd: num("MILESTONE_STEP_USD", 25_000),
      confirmSamples: num("MILESTONE_CONFIRM_SAMPLES", 3), // mcap must hold the level this many ticks running
      minBalance: big("PRIZE_MIN_BALANCE", "1000000000000"), // 1M tokens: the prize clock only runs at or above this
    },
    bot: {
      dipPct: num("BOT_DIP_PCT", 0.2),
      topStepPct: num("BOT_TOP_STEP_PCT", 0.5),
      sellFraction: 0.5,
      cooldownMs: num("BOT_COOLDOWN_MS", 30 * 60_000),
      minQuoteToBuy: big("BOT_MIN_QUOTE", "1000000000"), // 1,000 PUMP
      minTokensToSell: big("BOT_MIN_TOKENS", "1000000000"),
      slippagePct: num("SLIPPAGE_PCT", 5),
    },
    airdrop: {
      minAgeMs: num("AIRDROP_MIN_AGE_MS", 60 * 60_000),
      everyMs: num("AIRDROP_EVERY_MS", 60 * 60_000),
      minBalance: big("AIRDROP_MIN_BALANCE", "1000000"), // 1 token
      minPayout: big("AIRDROP_MIN_PAYOUT", "1000000"),
      minQuote: big("AIRDROP_MIN_QUOTE", "1000000000"),
    },
  };
}

export type Config = ReturnType<typeof loadConfig>;
