// End-to-end money flows against a real Postgres (embedded PGlite) and the
// in-memory FakeChain. These are the scenarios where real funds get lost or
// paid twice if the bookkeeping is wrong.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import postgres from "postgres";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import * as db from "../src/db.js";
import { Engine } from "../src/engine.js";
import { settle } from "../src/settle.js";
import { FakeChain, asChain } from "./fakechain.js";

const k = () => Keypair.generate();
const addr = (kp: Keypair) => kp.publicKey.toBase58();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const quiet = () => {};

let pg: PGlite, server: PGLiteSocketServer, sql: db.Sql;
let treasury: Keypair, bot: Keypair, air: Keypair, dev: Keypair;
let MINT: string, QUOTE: string, fake: FakeChain, cfg: any;

// mcap = price × 1e9 tokens × $1 → price 2.5e-5 is $25k
const mcapPrice = (usd: number) => usd / 1e9;

beforeEach(async () => {
  const port = 56000 + Math.floor(Math.random() * 3000);
  pg = await PGlite.create();
  server = new PGLiteSocketServer({ db: pg, port, host: "127.0.0.1" });
  await server.start();
  sql = postgres(`postgres://postgres@127.0.0.1:${port}/postgres`, { max: 1, types: { bigint: postgres.BigInt }, onnotice: quiet }) as db.Sql;
  await db.migrate(sql);

  [treasury, bot, air, dev] = [k(), k(), k(), k()];
  MINT = addr(k());
  QUOTE = addr(k());
  fake = new FakeChain(addr(treasury), QUOTE, MINT);
  fake.price = mcapPrice(10_000);
  cfg = {
    dryRun: false, mint: new PublicKey(MINT), quoteMint: new PublicKey(QUOTE), devWallet: dev.publicKey,
    launchTime: Date.now(), treasury, botWallet: bot, airdropWallet: air,
    tickMs: 1000, claimEveryMs: 0, minSolLamports: 0, failBackoffMs: 0, priorityMicroLamports: 0,
    prize: { stepUsd: 25_000, confirmSamples: 1, minBalance: 10n },
    bot: { dipPct: 0.2, topStepPct: 0.5, sellFraction: 0.5, cooldownMs: 0, minQuoteToBuy: 10n ** 30n, minTokensToSell: 10n ** 30n, slippagePct: 5 },
    airdrop: { minAgeMs: 3_600_000, everyMs: 0, minBalance: 1n, minPayout: 1n, minQuote: 1n },
  };
  console.log = quiet; // engine logs are noise here
}, 30_000);

afterEach(async () => {
  await sql.end({ timeout: 1 });
  await server.stop();
  await pg.close();
});

const engine = () => new Engine(cfg, asChain(fake), sql);
const pot = async () => (await db.loadState(sql)).prizePot;

describe("fee split", () => {
  it("splits each claim 1/1/1 and never re-splits", async () => {
    fake.pendingFees = 900n;
    await engine().tick();
    expect(fake.bal(addr(bot), QUOTE)).toBe(300n);
    expect(fake.bal(addr(air), QUOTE)).toBe(300n);
    expect(await pot()).toBe(300n);
    await engine().tick(); // nothing new
    expect(fake.bal(addr(bot), QUOTE)).toBe(300n);
    expect(await pot()).toBe(300n);
  });

  it("a claim that lands but crashes before the split is split exactly once later", async () => {
    fake.pendingFees = 600n;
    fake.crashAfterLand = 1; // claim lands, then the confirm "dies"
    await engine().tick();
    expect(fake.bal(addr(treasury), QUOTE)).toBe(600n);
    expect(fake.bal(addr(bot), QUOTE)).toBe(0n);
    await engine().tick();
    await engine().tick();
    expect(fake.bal(addr(bot), QUOTE)).toBe(200n);
    expect(fake.bal(addr(air), QUOTE)).toBe(200n);
    expect(await pot()).toBe(200n);
    expect(fake.bal(addr(treasury), QUOTE)).toBe(200n); // only the pot remains
  });

  it("rounding dust goes to the prize third", async () => {
    fake.pendingFees = 1001n;
    await engine().tick();
    expect(fake.bal(addr(bot), QUOTE)).toBe(333n);
    expect(await pot()).toBe(335n);
  });
});

describe("payout ledger", () => {
  const fund = (n: bigint) => fake.add(addr(treasury), QUOTE, n);
  const people = Array.from({ length: 10 }, () => addr(k()));

  it("a batch that lands but dies mid-confirm is never paid twice", async () => {
    fund(1000n);
    await db.enqueuePayouts(sql, "prize", "1", addr(treasury), QUOTE, people.map((owner) => ({ owner, amount: 10n })));
    fake.crashAfterLand = 1;
    await settle(sql, asChain(fake), treasury, quiet); // first 8 land, "crash"
    await settle(sql, asChain(fake), treasury, quiet); // resolves them by signature, sends the last 2
    for (const p of people) expect(fake.bal(p, QUOTE)).toBe(10n);
    expect(fake.submits).toBe(2);
    expect(await db.owed(sql, addr(treasury), QUOTE)).toBe(0n);
  });

  it("a send that never left is retried only once its blockhash has expired", async () => {
    fund(100n);
    await db.enqueuePayouts(sql, "prize", "1", addr(treasury), QUOTE, [{ owner: people[0], amount: 7n }]);
    fake.failBeforeSend = 1;
    await settle(sql, asChain(fake), treasury, quiet);
    await settle(sql, asChain(fake), treasury, quiet); // could still be in flight: hands off
    expect(fake.submits).toBe(0);
    fake.height += 200; // blockhash expired: it can never land now
    await settle(sql, asChain(fake), treasury, quiet);
    expect(fake.bal(people[0], QUOTE)).toBe(7n);
    expect(fake.submits).toBe(1);
  });

  it("promised-but-undelivered funds are not counted as free", async () => {
    fund(500n);
    await db.enqueuePayouts(sql, "split", "1", addr(treasury), QUOTE, [{ owner: people[0], amount: 200n }]);
    expect(await db.owed(sql, addr(treasury), QUOTE)).toBe(200n);
  });
});

describe("longest-holder prize", () => {
  const [a, b, c] = [k(), k(), k()];
  const hold = (kp: Keypair, n: bigint) => fake.add(addr(kp), MINT, n);

  it("pays the ladder: #1 alone, then top 2, then resets when #1 sells", async () => {
    hold(dev, 5000n); // oldest of all, but the dev never wins
    await engine().tick();
    hold(a, 100n);
    await engine().tick();
    hold(b, 100n);
    await engine().tick();
    hold(c, 100n);

    fake.pendingFees = 3000n; // → pot 1000
    fake.price = mcapPrice(30_000);
    await engine().tick();
    expect(fake.bal(addr(a), QUOTE)).toBe(1000n);
    expect(fake.bal(addr(dev), QUOTE)).toBe(0n);

    fake.pendingFees = 3000n;
    fake.price = mcapPrice(55_000);
    await engine().tick();
    expect(fake.bal(addr(a), QUOTE)).toBe(1500n);
    expect(fake.bal(addr(b), QUOTE)).toBe(500n);

    fake.add(addr(a), MINT, -1n); // a sells a little: clock restarts
    await engine().tick();
    fake.pendingFees = 3000n;
    fake.price = mcapPrice(80_000);
    await engine().tick();
    expect(fake.bal(addr(b), QUOTE)).toBe(1500n); // b is #1 now, alone
    expect(fake.bal(addr(a), QUOTE)).toBe(1500n);
    expect(fake.bal(addr(c), QUOTE)).toBe(0n);
  });

  it("a one-tick wick does not fire a milestone", async () => {
    cfg.prize.confirmSamples = 3;
    hold(a, 100n);
    fake.pendingFees = 3000n;
    await engine().tick();
    fake.price = mcapPrice(30_000);
    await engine().tick(); // spike
    fake.price = mcapPrice(10_000);
    await engine().tick();
    await engine().tick();
    expect(fake.bal(addr(a), QUOTE)).toBe(0n);
    fake.price = mcapPrice(30_000);
    for (let i = 0; i < 3; i++) await engine().tick();
    expect(fake.bal(addr(a), QUOTE)).toBe(1000n);
  });
});

describe("1h+ holder airdrop", () => {
  it("accrues before the hour, then buys back and splits pro-rata (dev in, newcomers out)", async () => {
    cfg.airdrop.minAgeMs = 80;
    cfg.launchTime = Date.now();
    const [a, late] = [k(), k()];
    fake.add(addr(a), MINT, 300n);
    fake.add(addr(dev), MINT, 100n);
    fake.pendingFees = 3_000_000n; // airdrop third: 1,000,000 $PUMP
    await engine().tick();
    expect(fake.bal(addr(air), QUOTE)).toBe(1_000_000n); // accruing, nothing bought yet

    await sleep(100);
    fake.add(addr(late), MINT, 1000n); // arrives now: under 1h
    fake.price = 1;
    await engine().tick();
    expect(fake.bal(addr(air), QUOTE)).toBe(0n); // whole bucket spent
    expect(fake.bal(addr(a), MINT) - 300n).toBe(750_000n); // 3 : 1
    expect(fake.bal(addr(dev), MINT) - 100n).toBe(250_000n);
    expect(fake.bal(addr(late), MINT)).toBe(1000n);
    expect(fake.bal(addr(air), MINT)).toBe(0n);
  });
});

describe("dip/top bot", () => {
  it("buys the dip with the whole bucket, then sells half at the first rung", async () => {
    cfg.bot.minQuoteToBuy = 1n;
    cfg.bot.minTokensToSell = 1n;
    fake.price = 1e-5;
    fake.pendingFees = 30_000n; // bot gets 10,000 $PUMP
    await engine().tick(); // sets the 24h high at 1e-5
    fake.price = 0.75e-5; // 25% under the high
    await engine().tick();
    expect(fake.bal(addr(bot), QUOTE)).toBe(0n);
    const bag = fake.bal(addr(bot), MINT);
    expect(bag).toBeGreaterThan(0n);

    fake.price = 0.75e-5 * 1.45; // +45%: under the first rung, holds
    await engine().tick();
    expect(fake.bal(addr(bot), MINT)).toBe(bag);
    fake.price = 0.75e-5 * 1.55; // past +50%: sells half
    await engine().tick();
    expect(fake.bal(addr(bot), MINT)).toBe(bag - bag / 2n);
    const trades = await sql`select side, status from bot_trades order by id`;
    expect(trades.map((t: any) => `${t.side}:${t.status}`)).toEqual(["buy:done", "sell:done"]);
  });
});
