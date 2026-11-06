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
import { FakeChain, FakeLp, asChain } from "./fakechain.js";
import { DEFAULT_TRANCHES, sliceCap } from "../src/logic/bot.js";

const k = () => Keypair.generate();
const addr = (kp: Keypair) => kp.publicKey.toBase58();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const quiet = () => {};

let pg: PGlite, server: PGLiteSocketServer, sql: db.Sql;
let treasury: Keypair, buyer: Keypair, bot: Keypair, air: Keypair, dev: Keypair;
let MINT: string, QUOTE: string, fake: FakeChain, lp: FakeLp, cfg: any;

// mcap = price × 1e9 tokens × $1 → price 2.5e-5 is $25k
const mcapPrice = (usd: number) => usd / 1e9;

beforeEach(async () => {
  pg = await PGlite.create();
  // Windows reserves random blocks of ports (Hyper-V/WinNAT) and refuses them
  // with EACCES, so try a few until one binds.
  let port = 0;
  for (let i = 0; ; i++) {
    port = 56000 + Math.floor(Math.random() * 3000);
    server = new PGLiteSocketServer({ db: pg, port, host: "127.0.0.1" });
    try {
      await server.start();
      break;
    } catch (e) {
      if (i >= 20) throw e;
    }
  }
  sql = postgres(`postgres://postgres@127.0.0.1:${port}/postgres`, { max: 1, types: { bigint: postgres.BigInt }, onnotice: quiet }) as db.Sql;
  await db.migrate(sql);

  [treasury, buyer, bot, air, dev] = [k(), k(), k(), k(), k()];
  MINT = addr(k());
  QUOTE = addr(k());
  fake = new FakeChain(addr(treasury), QUOTE, MINT);
  lp = new FakeLp(fake, addr(air), QUOTE);
  fake.price = mcapPrice(10_000);
  cfg = {
    dryRun: false, mint: new PublicKey(MINT), quoteMint: new PublicKey(QUOTE), devWallet: dev.publicKey,
    launchTime: Date.now(), treasury, volumeWallet: buyer, botWallet: bot, airdropWallet: air,
    tickMs: 1000, claimEveryMs: 0, minSolLamports: 0, failBackoffMs: 0, priorityMicroLamports: 0,
    gasMinLamports: 0, gasTargetLamports: 0, // gas station off by default (0 >= 0 skips); a test raises these to exercise it
    volume: { everyMs: 1, timingJitter: 0, cyclesPerWallet: 2, fundPct: 1, fundJitter: 0, minQuote: 10n ** 30n, maxImpactPct: 1, subSolLamports: 1_000_000, slippagePct: 5 }, // off unless a test lowers minQuote
    bot: {
      tranches: DEFAULT_TRANCHES, rearmGap: 0.1, topStepPct: 0.5, sellFraction: 0.5, minSellPremium: 0.1, maxImpactPct: 0.02,
      sliceGapMs: 0, sliceJitter: 0, crashPct: 0.6, crashWindowMs: 15 * 60_000, pauseMs: 30 * 60_000,
      anchorWindowMs: 6 * 3_600_000, momentumMs: 10 * 60_000, minAnchorSamples: 1,
      minQuoteToBuy: 10n ** 30n, minTokensToSell: 10n ** 30n, slippagePct: 5,
    },
    airdrop: {
      tiers: [{ ms: 3_600_000, mult: 1 }], everyMs: 0, sliceGapMs: 1e9, maxImpactPct: 0.01,
      minBalance: 1n, minPayout: 1n, minQuote: 10n ** 30n,
    },
    // LP steps only run when fake.migratedFlag is on, which only the DLMM test sets.
    dlmm: { halfWidth: 10, keepWidth: true, minQuote: 1n, binStep: 100, baseFeeBps: 100, slippageBps: 50 },
  };
  console.log = quiet; // engine logs are noise here
}, 30_000);

afterEach(async () => {
  await sql.end({ timeout: 1 });
  await server.stop();
  await pg.close();
});

const engine = () => new Engine(cfg, asChain(fake), sql, lp);
describe("fee split", () => {
  it("splits each claim 1/1/1 and never re-splits", async () => {
    fake.pendingFees = 900n;
    await engine().tick();
    expect(fake.bal(addr(buyer), QUOTE)).toBe(300n);
    expect(fake.bal(addr(bot), QUOTE)).toBe(300n);
    expect(fake.bal(addr(air), QUOTE)).toBe(300n);
    await engine().tick(); // nothing new
    expect(fake.bal(addr(bot), QUOTE)).toBe(300n);
    expect(fake.bal(addr(buyer), QUOTE)).toBe(300n);
  });

  it("a claim that lands but crashes before the split is split exactly once later", async () => {
    fake.pendingFees = 600n;
    fake.crashAfterLand = 1; // claim lands, then the confirm "dies"
    await engine().tick();
    expect(fake.bal(addr(treasury), QUOTE)).toBe(600n);
    expect(fake.bal(addr(bot), QUOTE)).toBe(0n);
    await engine().tick();
    await engine().tick();
    expect(fake.bal(addr(buyer), QUOTE)).toBe(200n);
    expect(fake.bal(addr(bot), QUOTE)).toBe(200n);
    expect(fake.bal(addr(air), QUOTE)).toBe(200n);
    expect(fake.bal(addr(treasury), QUOTE)).toBe(0n);
  });

  it("rounding dust stays in the treasury and joins the next split", async () => {
    fake.pendingFees = 1001n;
    await engine().tick();
    expect(fake.bal(addr(bot), QUOTE)).toBe(333n);
    expect(fake.bal(addr(treasury), QUOTE)).toBe(2n);
    fake.pendingFees = 1n; // 2 dust + 1 new = 3: splits evenly
    await engine().tick();
    expect(fake.bal(addr(bot), QUOTE)).toBe(334n);
    expect(fake.bal(addr(treasury), QUOTE)).toBe(0n);
  });

  it("gasses a low treasury from the claim before splitting (it has no bucket to sell)", async () => {
    cfg.gasMinLamports = 20_000_000; // 0.02 SOL floor
    cfg.gasTargetLamports = 50_000_000; // 0.05 SOL target
    fake.addSol(addr(treasury), 10_000_000n); // 0.01 SOL: below the floor
    fake.pendingFees = 90_000_000n;
    await engine().tick();
    // topped to target: the 0.04 SOL deficit was bought with 40,000,000 of the claimed quote
    expect(await fake.solBalance(treasury.publicKey)).toBe(50_000_000);
    // only what remains after the gas top-up is split three ways
    const third = (90_000_000n - 40_000_000n) / 3n; // 16,666,666
    expect(fake.bal(addr(buyer), QUOTE)).toBe(third);
    expect(fake.bal(addr(bot), QUOTE)).toBe(third);
    expect(fake.bal(addr(air), QUOTE)).toBe(third);
  });

  it("leaves the split untouched when the treasury already has gas", async () => {
    cfg.gasMinLamports = 20_000_000;
    cfg.gasTargetLamports = 50_000_000;
    fake.addSol(addr(treasury), 60_000_000n); // above the floor: no top-up
    fake.pendingFees = 900n;
    await engine().tick();
    expect(await fake.solBalance(treasury.publicKey)).toBe(60_000_000); // unchanged
    expect(fake.bal(addr(buyer), QUOTE)).toBe(300n); // full 1/1/1 split
    expect(fake.bal(addr(bot), QUOTE)).toBe(300n);
    expect(fake.bal(addr(air), QUOTE)).toBe(300n);
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

describe("volume bot", () => {
  const cycles = () => sql`select sub, quote::text, status from volume_cycles order by id`;
  const subs = () => sql`select pubkey, status from volume_wallets order by created_at`;
  // $PUMP held across the bucket wallet and every sub that hasn't drained yet.
  const live = async () => {
    const owners = [addr(buyer), ...(await subs()).map((r: any) => r.pubkey)];
    return owners.reduce((t, o) => t + fake.bal(o, QUOTE), 0n);
  };

  it("funds a throwaway sub, runs atomic cycles, then drains it back to the bucket", async () => {
    Object.assign(cfg.volume, { minQuote: 1n }); // on (fundPct 1, cap off, cyclesPerWallet 2 from defaults)
    cfg.claimEveryMs = 1e12; // no claims; fund the bucket directly
    fake.add(addr(buyer), QUOTE, 1000n); // bucket holds 1,000 $PUMP
    fake.addSol(addr(buyer), 1_000_000_000n); // SOL to seed subs

    await engine().tick(); // spawn a sub (seeded 1,000) + cycle #1
    const s1 = await subs();
    expect(s1.length).toBe(1);
    expect(s1[0].status).toBe("active");
    expect(fake.bal(addr(buyer), QUOTE)).toBe(0n); // seeded into the sub
    expect(fake.bal(s1[0].pubkey, QUOTE)).toBe(1000n);
    expect((await cycles()).length).toBe(1);
    expect(await live()).toBe(1000n); // conserved

    await sleep(5);
    await engine().tick(); // cycle #2: hits cyclesPerWallet
    expect((await cycles()).filter((c: any) => c.status === "done").length).toBe(2);

    await sleep(5);
    await engine().tick(); // cap reached -> retire the sub (mark draining); bucket empty, no new sub
    await sleep(5);
    await engine().tick(); // drain the retired sub back; a fresh sub takes over

    expect((await subs()).some((r: any) => r.status === "drained")).toBe(true);
    expect(await live()).toBe(1000n); // every lamport of $PUMP still accounted for
    expect(fake.volCycles).toBeGreaterThanOrEqual(2);
  });

  it("settles a cycle left 'sent' by a crash from the chain", async () => {
    // volume stays off (minQuote huge), so nothing spawns; only resolveSentCycles runs.
    await sql`insert into volume_cycles (sub, quote, price, sig, status) values ('subX', 100, 1, 'volsig', 'sent')`;
    fake.landed.set("volsig", "landed");
    await engine().tick();
    const [r] = await sql`select status from volume_cycles where sig = 'volsig'`;
    expect(r.status).toBe("done");
  });

  it("a cycle that lands but dies mid-confirm is settled, not lost or repeated", async () => {
    Object.assign(cfg.volume, { minQuote: 1n });
    cfg.claimEveryMs = 1e12;
    fake.add(addr(buyer), QUOTE, 1000n);
    fake.addSol(addr(buyer), 1_000_000_000n);
    fake.crashAfterLand = 2; // the fund tx lands then "dies"; the retry re-funds; the cycle also crashes

    await engine().tick(); // spawn (crash on fund) — state still consistent
    await sleep(5);
    await engine().tick(); // recovers; funds + cycles
    await sleep(5);
    await engine().tick();
    expect(await live()).toBe(1000n); // no $PUMP lost despite the crashes
    const sent = (await cycles()).filter((c: any) => c.status === "sent").length;
    expect(sent).toBe(0); // every cycle row resolved
  });
});

describe("DLMM fee airdrop (bucket 3)", () => {
  it("deploys principal to the LP, claims fees, and airdrops the fee pot in $PUMP by lowest balance x multiplier (dev in, newcomers and top-ups out)", async () => {
    fake.migratedFlag = true; // DLMM activity is post-migration only
    cfg.claimEveryMs = 0; // claim fees every tick
    cfg.airdrop.tiers = [{ ms: 1500, mult: 1 }, { ms: 1e9, mult: 3 }];
    cfg.launchTime = Date.now();
    const [a, late, topper] = [k(), k(), k()];
    fake.add(addr(a), MINT, 300n);
    fake.add(addr(dev), MINT, 100n);
    fake.add(addr(topper), MINT, 1n);
    fake.add(addr(air), QUOTE, 2000n); // bucket-3 principal, to be deployed as LP
    lp.fee = 1_000_000n; // the position's earned fees, in $PUMP, to be airdropped

    await engine().tick(); // ensurePool + deploy the 2000 principal (opens the position)
    expect(lp.pool).toBe("FAKEPOOL");
    expect(lp.position).toBe(true);
    await engine().tick(); // position now exists: claim fees into the pot
    expect(fake.bal(addr(air), QUOTE)).toBe(1_000_000n); // principal deployed; only the fee pot stays in the wallet

    await sleep(Math.max(0, cfg.launchTime + 1600 - Date.now()));
    fake.add(addr(late), MINT, 1000n); // arrives now: too new
    fake.add(addr(topper), MINT, 10_000n); // tops up right before the round
    await engine().tick(); // round end: airdrop the pot in $PUMP

    // weights 300 : 100 : 1 (the topper counts its lowest balance this round), pot 1,000,000
    expect(fake.bal(addr(a), QUOTE)).toBe(748_129n);
    expect(fake.bal(addr(dev), QUOTE)).toBe(249_376n);
    expect(fake.bal(addr(topper), QUOTE)).toBe(2_493n);
    expect(fake.bal(addr(late), QUOTE)).toBe(0n); // too new
    const holders = await db.loadHolders(sql);
    expect(holders.get(addr(topper))!.minSinceRound).toBe(10_001n);
  });

  it("re-centers the position when the active bin leaves its range", async () => {
    fake.migratedFlag = true;
    cfg.claimEveryMs = 1e12; // no claims this test
    cfg.launchTime = Date.now() + 1e9; // round far off: isolate the LP behaviour
    fake.add(addr(air), QUOTE, 5000n);
    await engine().tick(); // ensurePool + open the position (range -10..10 around active 0)
    expect(lp.position).toBe(true);
    expect(lp.rebalances).toBe(0);
    lp.activeBinId = 500; // price ran well past the range
    await engine().tick();
    expect(lp.rebalances).toBe(1);
  });

  it("does nothing on-chain before migration (bucket just accrues $PUMP)", async () => {
    fake.migratedFlag = false;
    cfg.launchTime = Date.now() + 1e9;
    fake.add(addr(air), QUOTE, 5000n);
    await engine().tick();
    expect(lp.pool).toBeNull(); // no pool created
    expect(lp.position).toBe(false);
    expect(fake.bal(addr(air), QUOTE)).toBe(5000n); // untouched
  });
});

describe("price stabilizer", () => {
  it("scales into a dip under the anchor, then sells half at the first rung", async () => {
    cfg.bot.minQuoteToBuy = 1n;
    cfg.bot.minTokensToSell = 1n;
    fake.price = 1e-5;
    fake.pendingFees = 30_000n; // bot gets 10,000 $PUMP
    for (let i = 0; i < 4; i++) await engine().tick(); // anchor settles at 1e-5
    fake.price = 0.8e-5; // anchor now 0.96e-5: 17% under, first tranche only
    await engine().tick();
    expect(fake.bal(addr(bot), QUOTE)).toBe(9_000n); // 10% of the bucket
    const bag = fake.bal(addr(bot), MINT);
    expect(bag).toBeGreaterThan(0n);

    fake.price = 0.8e-5 * 1.45; // +45% over entry: under the first rung, holds
    await engine().tick();
    expect(fake.bal(addr(bot), MINT)).toBe(bag);
    fake.price = 0.8e-5 * 1.55; // past +50% and well above the anchor: sells half
    await engine().tick();
    expect(fake.bal(addr(bot), MINT)).toBe(bag - bag / 2n);
    const trades = await sql`select side, status from bot_trades order by id`;
    expect(trades.map((t: any) => `${t.side}:${t.status}`)).toEqual(["buy:done", "sell:done"]);
  });

  it("slices a big buy across ticks on a thin curve", async () => {
    cfg.bot.minQuoteToBuy = 1n;
    cfg.bot.crashPct = 0.9; // this test is about slicing, not the crash pause
    fake.price = 1e-5;
    fake.pendingFees = 30_000n;
    for (let i = 0; i < 4; i++) await engine().tick();
    fake.price = 0.4e-5; // through every tranche: the whole 10,000 is ordered
    fake.reserves = { quote: 40_000n, base: 10_000_000_000n };
    const cap = sliceCap("buy", fake.reserves, 0.02);
    for (let i = 0; i < 3; i++) await engine().tick();
    const buys = await sql`select quote::text as q from bot_trades where side = 'buy' and status = 'done' order by id`;
    expect(buys.map((b: any) => BigInt(b.q))).toEqual([cap, cap, cap]);
    expect(fake.bal(addr(bot), QUOTE)).toBe(10_000n - 3n * cap);
    const s = await db.loadState(sql);
    expect(s.bot.order?.remaining).toBe(10_000n - 3n * cap); // the order survives a save/load round trip
  });
});

describe("gas station", () => {
  beforeEach(() => {
    cfg.gasMinLamports = 20_000_000; // 0.02 SOL floor
    cfg.gasTargetLamports = 50_000_000; // 0.05 SOL target
  });

  it("sells a low wallet's $PUMP for SOL up to the target", async () => {
    fake.addSol(addr(buyer), 10_000_000n); // 0.01 SOL: below the floor
    fake.add(addr(buyer), QUOTE, 1_000_000_000n); // has $PUMP to sell
    await engine().tick();
    // topped to the target; the 0.04 SOL deficit was paid in $PUMP (rate 1)
    expect(await fake.solBalance(buyer.publicKey)).toBe(50_000_000);
    expect(fake.bal(addr(buyer), QUOTE)).toBe(1_000_000_000n - 40_000_000n);
  });

  it("leaves a wallet already above the floor untouched", async () => {
    fake.addSol(addr(air), 60_000_000n); // above floor and target
    fake.add(addr(air), QUOTE, 500_000_000n);
    await engine().tick();
    expect(await fake.solBalance(air.publicKey)).toBe(60_000_000);
    expect(fake.bal(addr(air), QUOTE)).toBe(500_000_000n); // nothing sold
  });

  it("does nothing when a low wallet holds no $PUMP", async () => {
    fake.addSol(addr(bot), 5_000_000n); // below the floor, but no $PUMP to sell
    await engine().tick();
    expect(await fake.solBalance(bot.publicKey)).toBe(5_000_000); // unchanged
  });
});
