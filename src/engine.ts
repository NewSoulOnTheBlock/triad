import type { Keypair } from "@solana/web3.js";
import type { Config } from "./config.js";
import type { Chain } from "./chain.js";
import * as db from "./db.js";
import { settle } from "./settle.js";
import { applySnapshot, rankByAge, snapshotLooksTruncated, type Holder } from "./logic/holders.js";
import { milestoneReached, nextLadder, splitEven } from "./logic/prize.js";
import { applyBuy, applySell, decide, nextSellTrigger } from "./logic/bot.js";
import { airdropEligible, allocate } from "./logic/airdrop.js";

const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

type Market = { price: number; quoteUsd: number; mcapUsd: number; venue: string };

export class Engine {
  private engineWallets: Set<string>;
  private prizeExclude: Set<string>;
  private backoffUntil = new Map<string, number>();
  private gas = new Map<string, number>(); // lamports per engine wallet, refreshed each tick

  constructor(private cfg: Config, private chain: Chain, private sql: db.Sql) {
    this.engineWallets = new Set([cfg.treasury, cfg.botWallet, cfg.airdropWallet].map((k) => k.publicKey.toBase58()));
    this.prizeExclude = new Set([...this.engineWallets, cfg.devWallet.toBase58()]);
  }

  private get mint() { return this.cfg.mint.toBase58(); }
  private get quote() { return this.cfg.quoteMint.toBase58(); }

  async tick() {
    const now = Date.now();
    const state = await db.loadState(this.sql);
    await this.step("gas", async () => {
      for (const k of [this.cfg.treasury, this.cfg.botWallet, this.cfg.airdropWallet])
        this.gas.set(k.publicKey.toBase58(), await this.chain.solBalance(k.publicKey));
    });
    const holders = await this.step("holders", () => this.trackHolders(state, now));
    const market = await this.step("price", () => this.samplePrice());

    // Money steps. Each one persists its own state the moment it commits.
    await this.money("settle", [this.cfg.treasury, this.cfg.airdropWallet], () => this.settleAll());
    await this.money("claim", [this.cfg.treasury], () => this.claim(state, now));
    if (holders && market) await this.money("prize", [this.cfg.treasury], () => this.prize(state, holders));
    if (market) await this.money("bot", [this.cfg.botWallet], () => this.runBot(state, market.price, now));
    if (holders) await this.money("airdrop", [this.cfg.airdropWallet], () => this.airdrop(state, holders, now));
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
    const next = applySnapshot(prev, snap, now, scan.sellers, this.cfg.prize.minBalance);
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
  // for (prize pot + undelivered payouts). Measuring "unallocated" instead of
  // the claim's before/after delta means a crash right after a claim is
  // simply split on the next run, never lost or double counted.
  private async claim(state: db.State, now: number) {
    if (now - state.lastClaimAt < this.cfg.claimEveryMs) return;
    let sig: string | null = null;
    if (!this.cfg.dryRun) sig = await this.chain.submit(await this.chain.prepare(await this.chain.claimIxs(), this.cfg.treasury));
    state.lastClaimAt = now;

    const t = this.cfg.treasury.publicKey.toBase58();
    const balance = await this.chain.quoteBalance(this.cfg.treasury.publicKey);
    const unallocated = balance - state.prizePot - (await db.owed(this.sql, t, this.quote));
    if (unallocated <= 0n || this.cfg.dryRun) {
      await db.saveState(this.sql, state);
      return log(`[claim] nothing new to split${this.cfg.dryRun ? " (dry run)" : ""}`);
    }
    const third = unallocated / 3n;
    await this.sql.begin(async (tx) => {
      const [c] = await tx<{ id: number }[]>`insert into fee_claims (amount, per_bucket, sig) values (${unallocated.toString()}, ${third.toString()}, ${sig}) returning id`;
      await db.enqueuePayouts(tx, "split", String(c.id), t, this.quote, [
        { owner: this.cfg.botWallet.publicKey.toBase58(), amount: third },
        { owner: this.cfg.airdropWallet.publicKey.toBase58(), amount: third },
      ]);
      state.prizePot += unallocated - 2n * third; // the prize third keeps the rounding dust
      await db.saveState(tx, state);
    });
    log(`[claim] split ${unallocated} three ways`);
  }

  // ---- bucket 1: longest-holder prize ----

  private async prize(state: db.State, holders: Map<string, Holder>) {
    // The level must hold for N ticks running: one wick can't fire a payout.
    const recent = await this.sql<{ mcap_usd: number }[]>`
      select mcap_usd from price_samples order by ts desc limit ${this.cfg.prize.confirmSamples}`;
    if (recent.length < this.cfg.prize.confirmSamples) return;
    const confirmed = Math.min(...recent.map((r) => r.mcap_usd));
    const level = milestoneReached(confirmed, this.cfg.prize.stepUsd, state.lastPaidLevel);
    if (level === null) return;

    const ranked = rankByAge(holders.values(), { exclude: this.prizeExclude }).map((h) => h.owner);
    const round = nextLadder(ranked, state.ladder);
    const t = this.cfg.treasury.publicKey.toBase58();
    const free = (await this.chain.quoteBalance(this.cfg.treasury.publicKey)) - (await db.owed(this.sql, t, this.quote));
    const pot = state.prizePot < free ? state.prizePot : free;
    const amounts = round ? splitEven(pot > 0n ? pot : 0n, round.winners.length) : [];
    const payouts = round ? round.winners.map((owner, i) => ({ owner, amount: amounts[i] })) : [];
    const usd = level * this.cfg.prize.stepUsd;
    if (this.cfg.dryRun) return log(`[prize] DRY $${usd}:`, payouts.map((p) => `${p.owner.slice(0, 6)}=${p.amount}`).join(" ") || "no winners");

    await this.sql.begin(async (tx) => {
      state.lastPaidLevel = level;
      if (round && pot > 0n) {
        await tx`insert into milestones (level, mcap_usd, pot, winners) values (
          ${level}, ${confirmed}, ${pot.toString()}, ${tx.json(payouts.map((p) => ({ owner: p.owner, amount: p.amount.toString() })))})`;
        await db.enqueuePayouts(tx, "prize", String(level), t, this.quote, payouts);
        state.prizePot -= pot;
        state.ladder = round.state;
      }
      await db.saveState(tx, state);
    });
    // No pot or nobody qualified: the level still counts as reached and the pot rolls on.
    log(round && pot > 0n ? `[prize] $${usd} reached: ${pot} to ${payouts.length} wallet(s)` : `[prize] $${usd} reached, nothing to pay`);
  }

  // ---- bucket 2: dip/top bot ----

  private async runBot(state: db.State, price: number, now: number) {
    await this.resolveBotTrades(state);
    const wallet = this.cfg.botWallet;
    const [quoteBalance, tokens, [{ high }]] = await Promise.all([
      this.chain.quoteBalance(wallet.publicKey),
      this.chain.tokenBalance(wallet.publicKey),
      this.sql<{ high: number | null }[]>`select max(price) as high from price_samples where ts > now() - interval '24 hours'`,
    ]);
    if (!this.cfg.dryRun) state.bot.tokens = tokens; // the chain is the source of truth for the bag
    const d = decide({ price, high24: high ?? price, quoteBalance, state: state.bot, now, config: this.cfg.bot });
    state.lastDecision = { action: d.action, reason: d.reason, at: now };
    if (d.action === "hold") return;
    if (this.cfg.dryRun) return log(`[bot] DRY ${d.action}: ${d.reason}`);

    const ixs = d.action === "buy" ? await this.chain.buyIxs(wallet.publicKey, d.quote) : await this.chain.sellIxs(wallet.publicKey, d.tokens);
    const p = await this.chain.prepare(ixs, wallet);
    const planQuote = d.action === "buy" ? d.quote : 0n;
    const planTokens = d.action === "sell" ? d.tokens : 0n;
    // Written down before broadcast, so a crash can't lose a trade.
    const [row] = await this.sql<{ id: number }[]>`
      insert into bot_trades (side, quote, tokens, price, reason, sig, status)
      values (${d.action}, ${planQuote.toString()}, ${planTokens.toString()}, ${price}, ${d.reason}, ${p.sig}, 'sent') returning id`;
    if (d.action === "buy") state.bot.lastBuyAt = now; // cooldown starts even if it fails: no retry storms
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
    const open = await this.sql<{ id: number; side: string; tokens: string; sig: string }[]>`
      select id, side, tokens::text, sig from bot_trades where status = 'sent'`;
    if (!open.length) return;
    const outcomes = await this.chain.sigOutcomes(open.map((o) => o.sig));
    for (const o of open) {
      const r = outcomes.get(o.sig);
      if (r === "unknown") continue;
      await this.sql`update bot_trades set status = ${r === "landed" ? "done" : "failed"} where id = ${o.id}`;
      if (r === "landed" && o.side === "sell") state.bot = applySell(state.bot, BigInt(o.tokens));
      // A landed buy's fill size is unknown here; the bag itself is re-read from chain every tick.
    }
  }

  // ---- bucket 3: 1h+ holder airdrop ----

  // Accrues until the first wallets cross the 1h mark. Then on each interval:
  // buy back with the whole bucket and airdrop pro-rata by balance.
  private async airdrop(state: db.State, holders: Map<string, Holder>, now: number) {
    const a = this.cfg.airdrop;
    if (now < this.cfg.launchTime + a.minAgeMs || now - state.lastAirdropAt < a.everyMs) return;
    const recipients = airdropEligible(holders.values(), now, { minAgeMs: a.minAgeMs, exclude: this.engineWallets, minBalance: a.minBalance });
    if (recipients.length === 0) return;
    const wallet = this.cfg.airdropWallet;
    const w = wallet.publicKey.toBase58();
    const quote = await this.chain.quoteBalance(wallet.publicKey);
    if (quote < a.minQuote) return;
    if (this.cfg.dryRun) {
      state.lastAirdropAt = now;
      return log(`[airdrop] DRY buy with ${quote} → ${recipients.length} holders`);
    }

    const sig = await this.chain.submit(await this.chain.prepare(await this.chain.buyIxs(wallet.publicKey, quote), wallet));
    // Everything in the wallet that isn't already promised: this round's buy
    // plus any leftover dust or a previous round interrupted mid-way.
    const free = (await this.chain.tokenBalance(wallet.publicKey)) - (await db.owed(this.sql, w, this.mint));
    const { payouts } = allocate(free, recipients, a.minPayout);
    await this.sql.begin(async (tx) => {
      const [r] = await tx<{ id: number }[]>`
        insert into airdrops (quote_spent, tokens, recipients, buy_sig) values (${quote.toString()}, ${free.toString()}, ${payouts.length}, ${sig}) returning id`;
      await db.enqueuePayouts(tx, "airdrop", String(r.id), w, this.mint, payouts);
      state.lastAirdropAt = now;
      await db.saveState(tx, state);
    });
    log(`[airdrop] bought with ${quote} $PUMP, ${free} tokens queued to ${payouts.length} holders`);
  }

  // ---- dashboard cache ----

  private async saveOverview(state: db.State, market: Market | null) {
    const k = (kp: Keypair) => kp.publicKey;
    const [botQuote, botTokens, airdropQuote, airdropTokens, treasuryQuote] = await Promise.all([
      this.chain.quoteBalance(k(this.cfg.botWallet)),
      this.chain.tokenBalance(k(this.cfg.botWallet)),
      this.chain.quoteBalance(k(this.cfg.airdropWallet)),
      this.chain.tokenBalance(k(this.cfg.airdropWallet)),
      this.chain.quoteBalance(k(this.cfg.treasury)),
    ]);
    const [pending] = await this.sql<{ n: number }[]>`select count(*)::int as n from payouts where status <> 'paid'`;
    const wallets = Object.fromEntries(
      (["treasury", "botWallet", "airdropWallet"] as const).map((name) => {
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
      stepUsd: this.cfg.prize.stepUsd,
      nextMilestoneUsd: (state.lastPaidLevel + 1) * this.cfg.prize.stepUsd,
      wallets,
      pendingPayouts: pending.n,
      prize: { pot: state.prizePot.toString(), treasury: treasuryQuote.toString(), ladder: state.ladder, lastPaidLevel: state.lastPaidLevel, minBalance: this.cfg.prize.minBalance.toString(), confirmSamples: this.cfg.prize.confirmSamples },
      bot: {
        quote: botQuote.toString(),
        tokens: botTokens.toString(),
        avgEntry: state.bot.avgEntry,
        ladderStep: state.bot.ladderStep,
        nextSellAt: nextSellTrigger(state.bot, this.cfg.bot),
        dipPct: this.cfg.bot.dipPct,
        topStepPct: this.cfg.bot.topStepPct,
        lastDecision: state.lastDecision,
      },
      airdrop: { quote: airdropQuote.toString(), tokens: airdropTokens.toString(), minAgeMs: this.cfg.airdrop.minAgeMs, everyMs: this.cfg.airdrop.everyMs, lastAt: state.lastAirdropAt },
    });
  }
}
