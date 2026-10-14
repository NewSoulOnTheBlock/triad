import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config.js";
import * as db from "./db.js";
import { rankByAge } from "./logic/holders.js";
import { nextLadder } from "./logic/prize.js";
import { airdropEligible } from "./logic/airdrop.js";

const json = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));

export function serve(cfg: Config, sql: db.Sql) {
  const engine = new Set([cfg.treasury, cfg.botWallet, cfg.airdropWallet].map((k) => k.publicKey.toBase58()));
  const dev = cfg.devWallet.toBase58();
  const page = join(__dirname, "..", "web", "index.html");

  async function state() {
    const now = Date.now();
    const [holders, s, [ov], milestones, trades, airdrops, prices] = await Promise.all([
      db.loadHolders(sql),
      db.loadState(sql),
      sql<{ v: any }[]>`select v from kv where k = 'overview'`,
      sql`
        select m.level, m.ts, m.mcap_usd, m.pot::text, m.winners,
          (select count(*) from payouts p where p.kind = 'prize' and p.ref = m.level::text and p.status = 'paid')::int as delivered,
          (select min(p.sig) from payouts p where p.kind = 'prize' and p.ref = m.level::text and p.status = 'paid') as sig
        from milestones m order by m.level desc limit 50`,
      sql`select ts, side, quote::text, tokens::text, price, reason, sig, status from bot_trades order by id desc limit 100`,
      sql`
        select a.id, a.ts, a.quote_spent::text, a.tokens::text, a.recipients, a.buy_sig,
          (select count(*) from payouts p where p.kind = 'airdrop' and p.ref = a.id::text and p.status = 'paid')::int as delivered
        from airdrops a order by a.id desc limit 20`,
      sql`select ts, price, mcap_usd from price_samples where ts > now() - interval '24 hours' order by ts`,
    ]);

    const ranked = rankByAge(holders.values(), { exclude: new Set([...engine, dev]) });
    const preview = nextLadder(ranked.map((h) => h.owner), s.ladder);
    const winnersIfHitNow = new Set(preview?.winners ?? []);

    const people = [...holders.values()].filter((h) => !engine.has(h.owner));
    const elig = airdropEligible(people, now, { minAgeMs: cfg.airdrop.minAgeMs, exclude: engine, minBalance: cfg.airdrop.minBalance })
      .sort((a, b) => (b.balance > a.balance ? 1 : b.balance < a.balance ? -1 : 0));
    const weight = elig.reduce((t, h) => t + h.balance, 0n);

    const stride = Math.max(1, Math.ceil(prices.length / 240)); // plenty for a sparkline
    return {
      overview: ov?.v ?? null,
      holderCount: people.length,
      longest: ranked.slice(0, 50).map((h, i) => ({
        rank: i + 1, owner: h.owner, balance: h.balance, since: h.qualifiedSince, nextRoundWinner: winnersIfHitNow.has(h.owner),
      })),
      qualifiedCount: ranked.length,
      nextRoundSize: preview?.winners.length ?? 0,
      milestones,
      airdropEligible: elig.slice(0, 250).map((h) => ({
        owner: h.owner, balance: h.balance, since: h.heldSince, isDev: h.owner === dev,
        sharePct: weight > 0n ? Number((h.balance * 1_000_000n) / weight) / 10_000 : 0,
      })),
      airdropEligibleCount: elig.length,
      airdropPendingCount: people.filter((h) => now - h.heldSince < cfg.airdrop.minAgeMs).length,
      airdrops,
      trades,
      prices: prices.filter((_, i) => i % stride === 0 || i === prices.length - 1),
    };
  }

  const server = createServer(async (req, res) => {
    try {
      if (req.method !== "GET") return res.writeHead(405).end();
      if (req.url === "/api/state") {
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        return res.end(json(await state()));
      }
      if (req.url === "/healthz") {
        const [ov] = await sql<{ v: any }[]>`select v from kv where k = 'overview'`;
        const fresh = !!ov && Date.now() - ov.v.at < cfg.tickMs * 5;
        return res.writeHead(fresh ? 200 : 503).end(fresh ? "ok" : "stale");
      }
      if (req.url === "/" || req.url === "/index.html") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end(await readFile(page));
      }
      res.writeHead(404).end("not found");
    } catch (e) {
      console.error("[http]", (e as Error).message);
      res.writeHead(500).end("error");
    }
  });
  server.listen(cfg.port, () => console.log(`dashboard on http://localhost:${cfg.port}`));
  return server;
}
