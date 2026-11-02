// Local design preview of the dashboard: the real server (src/server.ts) on an
// in-memory Postgres filled with sample data. No RPC, no keys, no .env:
// nothing here can touch the chain or a real wallet.
//
//   npx tsx scripts/dev-ui.ts               live-looking sample data
//   npx tsx scripts/dev-ui.ts --prelaunch   the "awaiting launch" state
//   PORT=8790 by default
import { randomBytes } from "node:crypto";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import postgres from "postgres";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import * as db from "../src/db.js";
import { serve } from "../src/server.js";
import { DEFAULT_TRANCHES } from "../src/logic/bot.js";
import { DEFAULT_TIERS } from "../src/logic/airdrop.js";
import type { Holder } from "../src/logic/holders.js";

const PORT = Number(process.env.PORT ?? 8790);
const PRELAUNCH = process.argv.includes("--prelaunch");
const H = 3_600_000, M = 60_000;
const now = Date.now();
const kp = () => Keypair.generate();
const addr = () => kp().publicKey.toBase58();
const sig = () => bs58.encode(randomBytes(64));
const raw = (whole: number) => BigInt(Math.round(whole * 1e6)); // 6 decimals
const rnd = (a: number, b: number) => a + Math.random() * (b - a);

async function main() {
  const pg = await PGlite.create();
  const dbPort = 57000 + Math.floor(Math.random() * 2000);
  await new PGLiteSocketServer({ db: pg, port: dbPort, host: "127.0.0.1" }).start();
  const sql = postgres(`postgres://postgres@127.0.0.1:${dbPort}/postgres`, { max: 1, types: { bigint: postgres.BigInt }, onnotice: () => {} }) as db.Sql;
  await db.migrate(sql);

  const [treasury, volumeWallet, botWallet, airdropWallet, dev] = [kp(), kp(), kp(), kp(), kp()];
  const wallets = {
    treasury: { address: treasury.publicKey.toBase58(), sol: 412_000_000, low: false },
    volumeWallet: { address: volumeWallet.publicKey.toBase58(), sol: 186_000_000, low: false },
    botWallet: { address: botWallet.publicKey.toBase58(), sol: 94_000_000, low: false },
    airdropWallet: { address: airdropWallet.publicKey.toBase58(), sol: 151_000_000, low: false },
  };

  let overview: () => Record<string, unknown>;
  if (PRELAUNCH) {
    overview = () => ({ at: Date.now(), prelaunch: true, dryRun: true, wallets, volume: { everyMs: 90_000, cyclesPerWallet: 6, maxImpactPct: 0.01 } });
  } else {
    // 24h of price: a slow climb, a dip the stabilizer bought, a recovery.
    const quoteUsd = 0.0042;
    let p = 0.0151;
    const prices: { ts: Date; price: number }[] = [];
    for (let t = now - 24 * H; t <= now; t += 5 * M) {
      const phase = (t - (now - 24 * H)) / (24 * H);
      const drift = phase < 0.55 ? 0.0012 : phase < 0.68 ? -0.0075 : 0.0036;
      p = Math.max(0.006, p * (1 + drift + rnd(-0.012, 0.012)));
      prices.push({ ts: new Date(t), price: p });
    }
    for (const s of prices) await sql`insert into price_samples (ts, price, quote_usd, mcap_usd, venue) values (${s.ts}, ${s.price}, ${quoteUsd}, ${s.price * 1e9 * quoteUsd}, 'curve')`;
    const price = prices[prices.length - 1].price;
    const anchor = prices.slice(-72).reduce((a, s) => a + s.price, 0) / 72;

    // volume cycles, newest first on the page
    const activeSub = addr();
    for (let i = 60; i >= 1; i--) {
      const status = i === 1 ? "sent" : i === 17 ? "failed" : "done";
      await sql`insert into volume_cycles (ts, sub, quote, price, sig, status)
        values (${new Date(now - i * 92_000)}, ${i <= 3 ? activeSub : addr()}, ${raw(rnd(9_000, 26_000)).toString()}, ${price * rnd(0.97, 1.03)}, ${sig()}, ${status})`;
    }

    // stabilizer trades
    const trades = [
      { ago: 15.5 * H, side: "buy", q: 120_000, t: 9_100_000, r: "15% under anchor 0.01622 (slice, 360000000000 left)" },
      { ago: 15.2 * H, side: "buy", q: 120_000, t: 9_350_000, r: "15% under anchor 0.01622 (slice, 240000000000 left)" },
      { ago: 14.9 * H, side: "buy", q: 120_000, t: 9_480_000, r: "15% under anchor 0.01622 (slice, 120000000000 left)" },
      { ago: 14.6 * H, side: "buy", q: 120_000, t: 9_610_000, r: "15% under anchor 0.01622" },
      { ago: 9.1 * H, side: "buy", q: 210_000, t: 17_900_000, r: "25% under anchor 0.01555 (slice, 210000000000 left)" },
      { ago: 8.8 * H, side: "buy", q: 210_000, t: 18_300_000, r: "25% under anchor 0.01555" },
      { ago: 2.4 * H, side: "sell", q: 168_000, t: 7_400_000, r: "rung 1: price 0.02268 ≥ 0.02241" },
    ];
    for (const t of trades) await sql`insert into bot_trades (ts, side, quote, tokens, price, reason, sig, status)
      values (${new Date(now - t.ago)}, ${t.side}, ${raw(t.q).toString()}, ${raw(t.t).toString()}, ${raw(t.q) === 0n ? 0 : t.q / t.t}, ${t.r}, ${sig()}, 'done')`;

    // holders, held from minutes to days
    const holders = new Map<string, Holder>();
    for (let i = 0; i < 38; i++) {
      const owner = i === 0 ? dev.publicKey.toBase58() : addr();
      const balance = raw(Math.round(rnd(150_000, 19_000_000)));
      const heldSince = now - (i < 6 ? rnd(5 * M, 55 * M) : rnd(1.1 * H, 8 * 24 * H));
      holders.set(owner, { owner, balance, heldSince, minSinceRound: i % 7 === 3 ? balance / 2n : balance });
    }
    await db.saveHolders(sql, holders);

    // fee airdrop rounds (the latest one still delivering)
    for (let r = 6; r >= 1; r--) {
      const recipients = 18 + r;
      const fees = raw(rnd(22_000, 64_000));
      const [row] = await sql<{ id: number }[]>`insert into airdrops (ts, quote_spent, tokens, recipients, buy_sig)
        values (${new Date(now - r * H - 22 * M)}, ${fees.toString()}, ${(fees - raw(3)).toString()}, ${recipients}, null) returning id`;
      const delivered = r === 1 ? recipients - 7 : recipients;
      for (let i = 0; i < recipients; i++)
        await sql`insert into payouts (kind, ref, from_wallet, mint, owner, amount, status)
          values ('airdrop', ${String(row.id)}, ${wallets.airdropWallet.address}, ${addr()}, ${addr()}, '1000000', ${i < delivered ? "paid" : "pending"})`;
    }

    const avgEntry = 0.01612;
    overview = () => ({
      at: Date.now(), dryRun: false, mint: addr(), quoteMint: "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn",
      devWallet: dev.publicKey.toBase58(), launchTime: now - 3 * 24 * H,
      market: { price, quoteUsd, mcapUsd: price * 1e9 * quoteUsd, venue: "curve" },
      wallets, pendingPayouts: 7, treasury: { quote: raw(4_100).toString() },
      volume: {
        quote: raw(1_240_000).toString(), volume: raw(18_420_000).toString(), cycles: 412, activeSubs: 1,
        activeSub, cyclesDone: 3, nextCycleAt: Date.now() + 41_000, cyclesPerWallet: 6, everyMs: 90_000, maxImpactPct: 0.01,
      },
      bot: {
        quote: raw(862_000).toString(), tokens: raw(66_340_000).toString(), avgEntry, ladderStep: 1,
        nextSellAt: avgEntry * 2, topStepPct: 0.5, anchor, anchorHours: 6,
        tranches: DEFAULT_TRANCHES.map((t, i) => ({ below: t.below, weight: t.weight, armed: i !== 1, price: anchor * (1 - t.below) })),
        order: null, pausedUntil: 0, maxImpactPct: 0.02,
        lastDecision: { action: "hold", reason: "inside the band", at: Date.now() - 12_000 },
      },
      airdrop: {
        quote: raw(2_140_000).toString(), tokens: "0", pot: raw(38_400).toString(), pool: addr(), lastClaimAt: now - 6 * M,
        halfWidth: 34, tiers: DEFAULT_TIERS, minAgeMs: H, everyMs: H, sliceGapMs: 5 * M, lastAt: now - 22 * M, nextAt: now + 38 * M,
      },
    });
  }
  await db.setKv(sql, "overview", overview());
  setInterval(() => db.setKv(sql, "overview", overview()).catch(() => {}), 10_000);

  const cfg = {
    port: PORT, tickMs: 30_000, treasury, volumeWallet, botWallet, airdropWallet, devWallet: dev.publicKey,
    airdrop: { tiers: DEFAULT_TIERS, minBalance: 1_000_000n },
  } as unknown as Parameters<typeof serve>[0];
  serve(cfg, sql);
  console.log(`preview (${PRELAUNCH ? "pre-launch" : "sample data"}): http://localhost:${PORT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
