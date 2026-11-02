import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import type { Config } from "./config.js";
import type { Chain } from "./chain.js";
import * as db from "./db.js";
import { settle } from "./settle.js";
import { applySnapshot, snapshotLooksTruncated, startRound, type Holder } from "./logic/holders.js";
import { planFunding, planCycleQuote, scheduleNextCycle, shouldRotate } from "./logic/volume.js";
import { applyBuy, applySell, consumeBuy, decide, nextSellTrigger, scheduleNext, trancheLine, type Market as BotMarket } from "./logic/bot.js";
import { airdropWeights, allocate } from "./logic/airdrop.js";
import { shouldRebalance, nextHalfWidth, planDeploy, type MeteoraLp } from "./logic/dlmm.js";

const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

type Market = { price: number; quoteUsd: number; mcapUsd: number; venue: string };

export class Engine {
  private engineWallets: Set<string>;
  private backoffUntil = new Map<string, number>();
  private gas = new Map<string, number>(); // lamports per engine wallet, refreshed each tick

  constructor(private cfg: Config, private chain: Chain, private sql: db.Sql, private lp: MeteoraLp | null = null) {
    this.engineWallets = new Set(this.wallets().map((k) => k.publicKey.toBase58()));
  }

  private wallets() { return [this.cfg.treasury, this.cfg.volumeWallet, this.cfg.botWallet, this.cfg.airdropWallet]; }
  private get mint() { return this.cfg.mint.toBase58(); }
  private get quote() { return this.cfg.quoteMint.toBase58(); }

  async tick() {
    const now = Date.now();
    const state = await db.loadState(this.sql);
    await this.step("gas", async () => {
      for (const k of this.wallets())
        this.gas.set(k.publicKey.toBase58(), await this.chain.solBalance(k.publicKey));
    });
    const holders = await this.step("holders", () => this.trackHolders(state, now));
    const market = await this.step("price", () => this.samplePrice());

    // Money steps. Each one persists its own state the moment it commits.
    await this.money("settle", [this.cfg.treasury, this.cfg.airdropWallet], () => this.settleAll());
    await this.money("claim", [this.cfg.treasury], () => this.claim(state, now));
    if (market) await this.money("volume", [this.cfg.volumeWallet], () => this.runVolume(state, market.price, now));
    if (market) await this.money("bot", [this.cfg.botWallet], () => this.runBot(state, market.price, now));
    if (holders) await this.money("dlmm", [this.cfg.airdropWallet], () => this.runDlmm(state, holders, now));
    await this.money("settle", [this.cfg.treasury, this.cfg.airdropWallet], () => this.settleAll());

    await db.saveState(this.sql, state);
    await this.step("overview", () => this.saveOverview(state, market));
  }

  private async step<T>(name: string, fn: () => Promise<T>): Promise<T | null> {
    try {
      return await fn();
    } catch (e) {
      log(`[${name}] failed:`, (e as Error).message);
      return null;
    }
  }

  // A step that can move funds: skipped while backing off from a failure, or
  // while one of its wallets is too low on SOL to pay fees.
  private async money(name: string, wallets: Keypair[], fn: () => Promise<unknown>) {
    if ((this.backoffUntil.get(name) ?? 0) > Date.now()) return;
    const broke = wallets.find((w) => (this.gas.get(w.publicKey.toBase58()) ?? Infinity) < this.cfg.minSolLamports);
    if (broke && !this.cfg.dryRun) return log(`[${name}] skipped: ${broke.publicKey.toBase58()} is low on SOL`);
    try {
      await fn();
    } catch (e) {
      this.backoffUntil.set(name, Date.now() + this.cfg.failBackoffMs);
      log(`[${name}] failed, backing off ${this.cfg.failBackoffMs / 1000}s:`, (e as Error).message);
    }
  }

  // ---- holders & price ----

  private async trackHolders(state: db.State, now: number) {
    const prev = await db.loadHolders(this.sql);
    const scan = await this.chain.scanSellers(state.lastSig, state.lastSigVenue);
    const snap = await this.chain.snapshotHolders();
    if (snapshotLooksTruncated(prev.size, snap.size))
      throw new Error(`snapshot has ${snap.size} holders vs ${prev.size} last tick; refusing it (RPC returned a partial list?)`);
    const next = applySnapshot(prev, snap, now, scan.sellers);
    await db.saveHolders(this.sql, next);
    state.lastSig = scan.newest;
    state.lastSigVenue = scan.venue;
    await db.saveState(this.sql, state);
    return next;
  }

  private async samplePrice(): Promise<Market> {
    const [{ price, venue }, quoteUsd, supply] = await Promise.all([this.chain.price(), this.chain.quoteUsd(), this.chain.totalSupply()]);
    const mcapUsd = price * (Number(supply) / 1e6) * quoteUsd;
    await this.sql`insert into price_samples (price, quote_usd, mcap_usd, venue) values (${price}, ${quoteUsd}, ${mcapUsd}, ${venue})`;
    return { price, quoteUsd, mcapUsd, venue };
  }

  // ---- delivery ----

  private async settleAll() {
    if (this.cfg.dryRun) return;
    for (const w of [this.cfg.treasury, this.cfg.airdropWallet]) {
      const r = await settle(this.sql, this.chain, w, log);
      if (r.paid) log(`[settle] ${w.publicKey.toBase58().slice(0, 6)} delivered ${r.paid} payouts, ${r.pending} pending`);
    }
  }

  // ---- bucket split ----

  // Claim, then split whatever the treasury holds that is not already spoken
  // for (undelivered payouts). Measuring "unallocated" instead of
  // the claim's before/after delta means a crash right after a claim is
  // simply split on the next run, never lost or double counted.
  private async claim(state: db.State, now: number) {
    if (now - state.lastClaimAt < this.cfg.claimEveryMs) return;
    let sig: string | null = null;
    if (!this.cfg.dryRun) sig = await this.chain.submit(await this.chain.prepare(await this.chain.claimIxs(), this.cfg.treasury));
    state.lastClaimAt = now;

    const t = this.cfg.treasury.publicKey.toBase58();
    const balance = await this.chain.quoteBalance(this.cfg.treasury.publicKey);
    const unallocated = balance - (await db.owed(this.sql, t, this.quote));
    if (unallocated <= 0n || this.cfg.dryRun) {
      await db.saveState(this.sql, state);
      return log(`[claim] nothing new to split${this.cfg.dryRun ? " (dry run)" : ""}`);
    }
    const third = unallocated / 3n;
    await this.sql.begin(async (tx) => {
      const [c] = await tx<{ id: number }[]>`insert into fee_claims (amount, per_bucket, sig) values (${unallocated.toString()}, ${third.toString()}, ${sig}) returning id`;
      // Rounding dust stays in the treasury, unallocated, and is split with the next claim.
      await db.enqueuePayouts(tx, "split", String(c.id), t, this.quote, [
        { owner: this.cfg.volumeWallet.publicKey.toBase58(), amount: third },
        { owner: this.cfg.botWallet.publicKey.toBase58(), amount: third },
        { owner: this.cfg.airdropWallet.publicKey.toBase58(), amount: third },
      ]);
      await db.saveState(tx, state);
    });
    log(`[claim] split ${unallocated} three ways`);
  }

  // ---- bucket 1: volume bot ----

  // Prints two-sided volume through rotating throwaway sub-wallets. Each sub is
  // funded from the bucket, runs N atomic buy+sell cycles (one tx each, so it
  // never holds the coin across a slot), then is drained back to the bucket and
  // a fresh one takes over. Every sub's secret is stored before it is funded,
  // so a crash can always finish draining it — funds are never stranded.
  private volumeSubs = new Set<string>(); // live (not drained) sub pubkeys, for the airdrop exclusion

  private async runVolume(state: db.State, price: number, now: number) {
    await this.resolveSentCycles();

    // A. Drain every sub that is no longer the active trader (retired, or
    //    orphaned by a crash). Re-entrant: each step checks balances first.
    const live = await db.liveVolumeWallets(this.sql);
    this.volumeSubs = new Set(live.map((r) => r.pubkey));
    for (const row of live) {
      if (row.pubkey === state.volume.sub && row.status === "active") continue;
      await this.drainSub(row, state);
    }

    // B. Rotate in a fresh sub when there's none, or the active one hit its cap.
    if (shouldRotate(state.volume, this.cfg.volume)) {
      if (state.volume.sub) {
        await db.setVolumeStatus(this.sql, state.volume.sub, "draining"); // drained on the next pass (A)
        state.volume.sub = null;
      }
      if (!(await this.spawnSub(state, now))) return; // bucket below minimum
    }

    // C. Cycle timing, then one atomic buy+sell on the active sub.
    if (now < state.volume.nextCycleAt) return;
    await this.cycleOnce(state, price, now);
  }

  // Generate a sub, persist its secret BEFORE funding, then seed it with SOL
  // (gas + ATA rent) and the quote working capital in a single transfer tx.
  private async spawnSub(state: db.State, now: number): Promise<boolean> {
    const funder = this.cfg.volumeWallet;
    const [bucket, reserves] = await Promise.all([this.chain.quoteBalance(funder.publicKey), this.chain.reserves()]);
    const seed = planFunding({ bucketQuote: bucket, reserves, config: this.cfg.volume, rand: Math.random() });
    if (seed <= 0n) return false;

    const sub = Keypair.generate();
    const pub = sub.publicKey.toBase58();
    await db.insertVolumeWallet(this.sql, pub, bs58.encode(sub.secretKey), seed);
    state.volume = { sub: pub, cyclesDone: 0, nextCycleAt: now };
    await db.saveState(this.sql, state);

    if (this.cfg.dryRun) { log(`[volume] DRY spawn ${pub.slice(0, 6)} seed ${seed}`); return true; }
    const ixs = [
      ...this.chain.solTransferIxs(funder.publicKey, sub.publicKey, BigInt(this.cfg.volume.subSolLamports)),
      ...this.chain.transferIxs(funder.publicKey, this.cfg.quoteMint, [{ owner: pub, amount: seed }]),
    ];
    await this.chain.submit(await this.chain.prepare(ixs, funder));
    log(`[volume] spawned ${pub.slice(0, 6)} seeded ${seed} ${this.quote.slice(0, 4)}`);
    return true;
  }

  private async cycleOnce(state: db.State, price: number, now: number) {
    const [row] = await this.sql<{ secret: string }[]>`select secret from volume_wallets where pubkey = ${state.volume.sub} and status = 'active'`;
    if (!row) { state.volume.sub = null; return; } // vanished (drained elsewhere): rotate next tick
    const sub = Keypair.fromSecretKey(bs58.decode(row.secret));
    const [subQuote, reserves] = await Promise.all([this.chain.quoteBalance(sub.publicKey), this.chain.reserves()]);
    const quote = planCycleQuote({ subQuote, reserves, config: this.cfg.volume });

    // Gap and the cycle counter advance even if this cycle holds or fails: no retry storms, and the sub still rotates.
    state.volume.nextCycleAt = scheduleNextCycle(now, this.cfg.volume, Math.random());
    state.volume.cyclesDone += 1;
    if (quote <= 0n) { await db.saveState(this.sql, state); return log(`[volume] skip: sub below minimum`); }
    if (this.cfg.dryRun) { await db.saveState(this.sql, state); return log(`[volume] DRY cycle ${quote} on ${state.volume.sub!.slice(0, 6)}`); }

    const p = await this.chain.prepare(await this.chain.volumeCycleIxs(sub.publicKey, quote), sub);
    const [c] = await this.sql<{ id: number }[]>`
      insert into volume_cycles (sub, quote, price, sig, status) values (${sub.publicKey.toBase58()}, ${quote.toString()}, ${price}, ${p.sig}, 'sent') returning id`;
    await db.saveState(this.sql, state);
    await this.chain.submit(p); // on error the row stays 'sent' and resolveSentCycles settles it from the chain
    await this.sql`update volume_cycles set status = 'done' where id = ${c.id}`;
    log(`[volume] cycle ${quote} on ${sub.publicKey.toBase58().slice(0, 6)} (${state.volume.cyclesDone}/${this.cfg.volume.cyclesPerWallet})`);
  }

  // Empty a retired sub back to the bucket: sell any residual coin, sweep the
  // quote, close both ATAs (reclaims rent), then sweep the remaining SOL last
  // (the sub pays its own gas for the earlier steps). Re-entrant after a crash.
  private async drainSub(row: db.VolumeWalletRow, _state: db.State) {
    const funder = this.cfg.volumeWallet.publicKey;
    const sub = Keypair.fromSecretKey(bs58.decode(row.secret));
    if (this.cfg.dryRun) { await db.setVolumeStatus(this.sql, row.pubkey, "drained"); return log(`[volume] DRY drain ${row.pubkey.slice(0, 6)}`); }
    if (row.status !== "draining") await db.setVolumeStatus(this.sql, row.pubkey, "draining");

    const coin = await this.chain.tokenBalance(sub.publicKey);
    if (coin > 0n) await this.chain.submit(await this.chain.prepare(await this.chain.sellIxs(sub.publicKey, coin), sub));

    const pump = await this.chain.quoteBalance(sub.publicKey);
    const sweep: Parameters<Chain["prepare"]>[0] = [];
    if (pump > 0n) sweep.push(...this.chain.transferIxs(sub.publicKey, this.cfg.quoteMint, [{ owner: funder.toBase58(), amount: pump }]));
    sweep.push(...(await this.chain.closeAtaIxs(sub.publicKey, this.cfg.mint)));
    sweep.push(...(await this.chain.closeAtaIxs(sub.publicKey, this.cfg.quoteMint)));
    if (sweep.length) await this.chain.submit(await this.chain.prepare(sweep, sub));

    const sol = BigInt(await this.chain.solBalance(sub.publicKey));
    const fee = 5000n;
    if (sol > fee) await this.chain.submit(await this.chain.prepare(this.chain.solTransferIxs(sub.publicKey, funder, sol - fee), sub));
    await db.setVolumeStatus(this.sql, row.pubkey, "drained");
    this.volumeSubs.delete(row.pubkey);
    log(`[volume] drained ${row.pubkey.slice(0, 6)} -> bucket`);
  }

  // Cycle rows left `sent` by an error or crash: settle from the chain. A sig
  // still unknown after 10 minutes had its blockhash expire, so it never
  // landed. A landed cycle is a completed round trip; balances are re-read each
  // tick, so there is nothing to reconcile beyond the public log.
  private async resolveSentCycles() {
    const open = await this.sql<{ id: number; sig: string; old: boolean }[]>`
      select id, sig, ts < now() - interval '10 minutes' as old from volume_cycles where status = 'sent'`;
    if (!open.length) return;
    const outcomes = await this.chain.sigOutcomes(open.map((o) => o.sig));
    for (const o of open) {
      const r = outcomes.get(o.sig);
      const status = r === "landed" ? "done" : r === "failed" || o.old ? "failed" : null;
      if (status) await this.sql`update volume_cycles set status = ${status} where id = ${o.id}`;
    }
  }

  // ---- bucket 2: price stabilizer ----

  // Everything the stabilizer looks at, from the price samples written each tick.
  private async botMarket(price: number): Promise<BotMarket> {
    const b = this.cfg.bot;
    const secs = (ms: number) => ms / 1000;
    const [[a], [h], [ago], reserves] = await Promise.all([
      this.sql<{ anchor: number | null; n: number }[]>`
        select avg(price) as anchor, count(*)::int as n from price_samples
        where ts > now() - (${secs(b.anchorWindowMs)} * interval '1 second') and price > 0`,
      this.sql<{ high: number | null }[]>`
        select max(price) as high from price_samples where ts > now() - (${secs(b.crashWindowMs)} * interval '1 second')`,
      this.sql<{ price: number }[]>`
        select price from price_samples where ts <= now() - (${secs(b.momentumMs)} * interval '1 second') and price > 0
        order by ts desc limit 1`,
      this.chain.reserves(),
    ]);
    // Samples are evenly spaced (one per tick), so their plain average is the TWAP.
    return {
      price,
      anchor: a?.anchor ?? price,
      anchorSamples: a?.n ?? 0,
      recentHigh: h?.high ?? price,
      priceAgo: ago?.price ?? price,
      reserves: reserves ? { quote: reserves.quote, base: reserves.base } : null,
    };
  }

  private async runBot(state: db.State, price: number, now: number) {
    await this.resolveBotTrades(state);
    const wallet = this.cfg.botWallet;
    const [quoteBalance, tokens, market] = await Promise.all([
      this.chain.quoteBalance(wallet.publicKey),
      this.chain.tokenBalance(wallet.publicKey),
      this.botMarket(price),
    ]);
    if (!this.cfg.dryRun) state.bot.tokens = tokens; // the chain is the source of truth for the bag
    const { state: planned, decision: d } = decide({ market, quoteBalance, state: state.bot, now, config: this.cfg.bot });
    state.lastDecision = { action: d.action, reason: d.reason, at: now };
    if (this.cfg.dryRun) return d.action === "hold" ? undefined : log(`[bot] DRY ${d.action}: ${d.reason}`);
    state.bot = planned; // arming, orders and pauses stick even when this tick holds
    if (d.action === "hold") return;

    const ixs = d.action === "buy" ? await this.chain.buyIxs(wallet.publicKey, d.quote) : await this.chain.sellIxs(wallet.publicKey, d.tokens);
    const p = await this.chain.prepare(ixs, wallet);
    const planQuote = d.action === "buy" ? d.quote : 0n;
    const planTokens = d.action === "sell" ? d.tokens : 0n;
    // Written down before broadcast, so a crash can't lose a trade.
    const [row] = await this.sql<{ id: number }[]>`
      insert into bot_trades (side, quote, tokens, price, reason, sig, status)
      values (${d.action}, ${planQuote.toString()}, ${planTokens.toString()}, ${price}, ${d.reason}, ${p.sig}, 'sent') returning id`;
    state.bot = scheduleNext(state.bot, now, this.cfg.bot, Math.random()); // gap starts even if it fails: no retry storms
    await db.saveState(this.sql, state);
    try {
      await this.chain.submit(p);
    } catch (e) {
      await this.sql`update bot_trades set status = 'failed' where id = ${row.id}`;
      throw e;
    }
    const [q2, t2] = await Promise.all([this.chain.quoteBalance(wallet.publicKey), this.chain.tokenBalance(wallet.publicKey)]);
    if (d.action === "buy") {
      const got = t2 - tokens;
      state.bot = applyBuy({ ...state.bot, tokens }, d.quote, got, now);
      await this.sql`update bot_trades set status = 'done', tokens = ${got.toString()} where id = ${row.id}`;
    } else {
      state.bot = applySell({ ...state.bot, tokens }, d.tokens);
      await this.sql`update bot_trades set status = 'done', quote = ${(q2 - quoteBalance).toString()} where id = ${row.id}`;
    }
    await db.saveState(this.sql, state);
    log(`[bot] ${d.action}: ${d.reason}`);
  }

  // Trades left `sent` by a crash: settle them from the chain.
  private async resolveBotTrades(state: db.State) {
    const open = await this.sql<{ id: number; side: string; quote: string; tokens: string; sig: string }[]>`
      select id, side, quote::text, tokens::text, sig from bot_trades where status = 'sent'`;
    if (!open.length) return;
    const outcomes = await this.chain.sigOutcomes(open.map((o) => o.sig));
    for (const o of open) {
      const r = outcomes.get(o.sig);
      if (r === "unknown") continue;
      await this.sql`update bot_trades set status = ${r === "landed" ? "done" : "failed"} where id = ${o.id}`;
      if (r === "landed" && o.side === "sell") state.bot = applySell(state.bot, BigInt(o.tokens));
      // A landed buy's fill size is unknown here; the bag itself is re-read from chain every tick.
      if (r === "landed" && o.side === "buy") state.bot = consumeBuy(state.bot, BigInt(o.quote));
    }
  }

  // ---- bucket 3: DLMM liquidity + loyalty fee airdrop ----

  // When the coming round pays out: one interval after the last, and never
  // before the first wallets can have reached the first tier.
  private roundEnd(state: db.State) {
    return Math.max(state.lastAirdropAt + this.cfg.airdrop.everyMs, this.cfg.launchTime + this.cfg.airdrop.tiers[0].ms);
  }

  private async dlog(kind: string, detail: string, quote: bigint | null = null, sig: string | null = null) {
    await this.sql`insert into dlmm_log (kind, detail, quote, sig) values (${kind}, ${detail}, ${quote === null ? null : quote.toString()}, ${sig})`;
  }

  // Post-migration: the bucket's $PUMP is LP principal on the coin/$PUMP Meteora
  // DLMM pair (it compounds as more fee flows in); the position is kept in range
  // (remove + re-center + re-add when the active bin leaves it). The position's
  // *earned* trading fees are claimed, converted to $PUMP, and airdropped to
  // holders of 1h+ by lowest balance this round × loyalty multiplier.
  private async runDlmm(state: db.State, holders: Map<string, Holder>, now: number) {
    const d = this.cfg.dlmm;
    const wallet = this.cfg.airdropWallet;
    const w = wallet.publicKey.toBase58();

    // Pre-migration there's no real market to LP against; the bucket just accrues
    // $PUMP until the coin graduates. LP steps also need to send, so dry-run skips them.
    if (this.lp && !this.cfg.dryRun && (await this.chain.migrated())) {
      try {
        if (!state.dlmm.pool) {
          state.dlmm.pool = await this.lp.ensurePool();
          await this.dlog("pool", state.dlmm.pool);
          await db.saveState(this.sql, state);
        }
        const snap = await this.lp.snapshot();

        // Claim the position's fees into the pot (periodically), converted to $PUMP.
        if (snap?.position && now - state.dlmm.lastClaimAt >= this.cfg.claimEveryMs) {
          const got = await this.lp.claimFeesToQuote();
          state.dlmm.pot += got;
          state.dlmm.lastClaimAt = now;
          if (got > 0n) await this.dlog("claim", `${got} $PUMP of fees`, got);
          await db.saveState(this.sql, state);
        }

        // Deploy idle principal: wallet $PUMP minus the airdrop pot and anything owed.
        const owed = await db.owed(this.sql, w, this.quote);
        const idle = (await this.chain.quoteBalance(wallet.publicKey)) - state.dlmm.pot - owed;
        const deploy = planDeploy(idle, d.minQuote);
        if (deploy > 0n) {
          if (!snap?.position) await this.lp.openPosition(deploy, d.halfWidth);
          else await this.lp.addLiquidity(deploy);
          state.dlmm.lastDeployAt = now;
          await this.dlog(snap?.position ? "add" : "open", `${deploy} $PUMP`, deploy);
          await db.saveState(this.sql, state);
        }

        // Re-center on the active bin when it has left the position.
        if (snap?.position && shouldRebalance(snap.activeBinId, snap.lowerBinId, snap.upperBinId)) {
          const hw = nextHalfWidth({ halfWidth: d.halfWidth, keepWidth: d.keepWidth }, snap.lowerBinId, snap.upperBinId);
          await this.lp.rebalance(hw);
          await this.dlog("rebalance", `active ${snap.activeBinId} left [${snap.lowerBinId},${snap.upperBinId}]`);
        }
      } catch (e) {
        log(`[dlmm] LP step failed: ${(e as Error).message}`); // the fee airdrop below still runs
      }
    }

    // Airdrop the claimed-fee pot at the round's end. Reuses the loyalty weighting
    // and the crash-safe payout ledger; pays $PUMP, never touching LP principal.
    if (now < this.roundEnd(state)) return;
    const exclude = new Set([...this.engineWallets, ...this.volumeSubs]); // engine wallets + live volume subs never receive airdrops
    const recipients = airdropWeights(holders.values(), now, { tiers: this.cfg.airdrop.tiers, exclude, minBalance: this.cfg.airdrop.minBalance });
    if (recipients.length === 0) return;
    const payable = (await this.chain.quoteBalance(wallet.publicKey)) - (await db.owed(this.sql, w, this.quote));
    const pot = state.dlmm.pot < payable ? state.dlmm.pot : payable; // never over-promise, never airdrop principal
    if (pot <= 0n) return;
    if (this.cfg.dryRun) { state.lastAirdropAt = now; return log(`[dlmm] DRY airdrop ${pot} $PUMP -> ${recipients.length} holders`); }
    const { payouts } = allocate(pot, recipients, this.cfg.airdrop.minPayout);
    const paid = payouts.reduce((s, p) => s + p.amount, 0n);
    await this.sql.begin(async (tx) => {
      const [r] = await tx<{ id: number }[]>`
        insert into airdrops (quote_spent, tokens, recipients, buy_sig) values (${pot.toString()}, ${paid.toString()}, ${payouts.length}, null) returning id`;
      await db.enqueuePayouts(tx, "airdrop", String(r.id), w, this.quote, payouts);
      state.lastAirdropAt = now;
      state.dlmm.pot -= paid; // whatever rounding left behind rolls into the next round
      await db.saveState(tx, state);
    });
    // Every wallet's "lowest balance this round" window starts over now.
    await db.saveHolders(this.sql, startRound(holders));
    log(`[dlmm] airdropped ${paid} $PUMP of fees to ${payouts.length} holders`);
  }

  // ---- dashboard cache ----

  private async saveOverview(state: db.State, market: Market | null) {
    const k = (kp: Keypair) => kp.publicKey;
    const [volumeQuote, botQuote, botTokens, airdropQuote, airdropTokens, treasuryQuote, [totals]] = await Promise.all([
      this.chain.quoteBalance(k(this.cfg.volumeWallet)),
      this.chain.quoteBalance(k(this.cfg.botWallet)),
      this.chain.tokenBalance(k(this.cfg.botWallet)),
      this.chain.quoteBalance(k(this.cfg.airdropWallet)),
      this.chain.tokenBalance(k(this.cfg.airdropWallet)),
      this.chain.quoteBalance(k(this.cfg.treasury)),
      this.sql<{ volume: string; cycles: number; subs: number }[]>`
        select coalesce((select sum(quote) from volume_cycles where status = 'done'), 0)::text as volume,
               (select count(*) from volume_cycles where status = 'done')::int as cycles,
               (select count(*) from volume_wallets where status <> 'drained')::int as subs`,
    ]);
    const [pending] = await this.sql<{ n: number }[]>`select count(*)::int as n from payouts where status <> 'paid'`;
    const botMarket = market && market.price > 0 ? await this.botMarket(market.price).catch(() => null) : null;
    const wallets = Object.fromEntries(
      (["treasury", "volumeWallet", "botWallet", "airdropWallet"] as const).map((name) => {
        const pk = this.cfg[name].publicKey.toBase58();
        const sol = this.gas.get(pk) ?? null;
        return [name, { address: pk, sol, low: sol !== null && sol < this.cfg.minSolLamports }];
      }),
    );
    await db.setKv(this.sql, "overview", {
      at: Date.now(),
      dryRun: this.cfg.dryRun,
      mint: this.mint,
      quoteMint: this.quote,
      devWallet: this.cfg.devWallet.toBase58(),
      launchTime: this.cfg.launchTime,
      market,
      wallets,
      pendingPayouts: pending.n,
      treasury: { quote: treasuryQuote.toString() },
      volume: {
        quote: volumeQuote.toString(), volume: totals.volume, cycles: totals.cycles, activeSubs: totals.subs,
        activeSub: state.volume.sub, cyclesDone: state.volume.cyclesDone, nextCycleAt: state.volume.nextCycleAt,
        cyclesPerWallet: this.cfg.volume.cyclesPerWallet, everyMs: this.cfg.volume.everyMs, maxImpactPct: this.cfg.volume.maxImpactPct,
      },
      bot: {
        quote: botQuote.toString(),
        tokens: botTokens.toString(),
        avgEntry: state.bot.avgEntry,
        ladderStep: state.bot.ladderStep,
        nextSellAt: nextSellTrigger(state.bot, this.cfg.bot),
        topStepPct: this.cfg.bot.topStepPct,
        anchor: botMarket?.anchor ?? null,
        anchorHours: this.cfg.bot.anchorWindowMs / 3_600_000,
        tranches: this.cfg.bot.tranches.map((t, i) => ({
          below: t.below, weight: t.weight, armed: state.bot.armed[i] ?? true,
          price: botMarket ? trancheLine(botMarket.anchor, t) : null,
        })),
        order: state.bot.order ? { ...state.bot.order, remaining: state.bot.order.remaining.toString() } : null,
        pausedUntil: state.bot.pausedUntil,
        maxImpactPct: this.cfg.bot.maxImpactPct,
        lastDecision: state.lastDecision,
      },
      airdrop: {
        quote: airdropQuote.toString(), tokens: airdropTokens.toString(), pot: state.dlmm.pot.toString(),
        pool: state.dlmm.pool, lastClaimAt: state.dlmm.lastClaimAt, halfWidth: this.cfg.dlmm.halfWidth,
        tiers: this.cfg.airdrop.tiers, minAgeMs: this.cfg.airdrop.tiers[0].ms, everyMs: this.cfg.airdrop.everyMs,
        sliceGapMs: this.cfg.airdrop.sliceGapMs, lastAt: state.lastAirdropAt, nextAt: this.roundEnd(state),
      },
    });
  }
}
