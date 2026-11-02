import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config.js";
import * as db from "./db.js";
import { airdropWeights, multiplier, nextTier } from "./logic/airdrop.js";
import type { Holder } from "./logic/holders.js";

const json = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));

export function serve(cfg: Config, sql: db.Sql) {
  const engine = new Set([cfg.treasury, cfg.volumeWallet, cfg.botWallet, cfg.airdropWallet].map((k) => k.publicKey.toBase58()));
  const dev = cfg.devWallet.toBase58();
  const page = join(__dirname, "..", "web", "index.html");
  const firstTierMs = cfg.airdrop.tiers[0].ms;
  const weights = (hs: Holder[], now: number) =>
    airdropWeights(hs, now, { tiers: cfg.airdrop.tiers, exclude: engine, minBalance: cfg.airdrop.minBalance });
  const pct = (part: bigint, whole: bigint) => (whole > 0n ? Number((part * 1_000_000n) / whole) / 10_000 : 0);

  async function state() {
    const now = Date.now();
    const [holders, [ov], cycles, trades, airdrops, prices] = await Promise.all([
      db.loadHolders(sql),
      sql<{ v: any }[]>`select v from kv where k = 'overview'`,
      sql`select ts, sub, quote::text, price, sig, status from volume_cycles order by id desc limit 100`,
      sql`select ts, side, quote::text, tokens::text, price, reason, sig, status from bot_trades order by id desc limit 100`,
      sql`
        select a.id, a.ts, a.quote_spent::text, a.tokens::text, a.recipients, a.buy_sig,
          (select count(*) from payouts p where p.kind = 'airdrop' and p.ref = a.id::text and p.status = 'paid')::int as delivered
        from airdrops a order by a.id desc limit 20`,
      sql`select ts, price, mcap_usd from price_samples where ts > now() - interval '24 hours' order by ts`,
    ]);

    const people = [...holders.values()].filter((h) => !engine.has(h.owner));
    const elig = weights(people, now).sort((a, b) => (b.weight > a.weight ? 1 : b.weight < a.weight ? -1 : 0));
    const weight = elig.reduce((t, h) => t + h.weight, 0n);

    const stride = Math.max(1, Math.ceil(prices.length / 240)); // plenty for a sparkline
    return {
      overview: ov?.v ?? null,
      holderCount: people.length,
      cycles,
      airdropEligible: elig.slice(0, 250).map((h) => ({
        owner: h.owner, balance: h.balance, counted: h.counted, mult: h.mult, since: now - h.heldMs, isDev: h.owner === dev,
        sharePct: pct(h.weight, weight),
      })),
      airdropEligibleCount: elig.length,
      airdropPendingCount: people.filter((h) => now - h.heldSince < firstTierMs).length,
      airdrops,
      trades,
      prices: prices.filter((_, i) => i % stride === 0 || i === prices.length - 1),
    };
  }

  // One wallet's standing in the loyalty airdrop: what it earns now, what the
  // next tier is worth, and what selling would cost it.
  async function wallet(address: string) {
    const now = Date.now();
    const [holders, [ov]] = await Promise.all([db.loadHolders(sql), sql<{ v: any }[]>`select v from kv where k = 'overview'`]);
    const h = holders.get(address);
    if (engine.has(address)) return { address, status: "engine", note: "Engine wallets never receive airdrops." };
    if (!h) return { address, status: "none", note: "This wallet holds none of the coin (or hasn't been seen by a snapshot yet)." };
    const heldMs = now - h.heldSince;
    const all = weights([...holders.values()], now);
    const total = all.reduce((t, x) => t + x.weight, 0n);
    const me = all.find((x) => x.owner === address);
    const next = nextTier(heldMs, cfg.airdrop.tiers);
    const bought = BigInt(ov?.v?.airdrop?.tokens ?? "0"); // tokens bought toward the coming round so far
    return {
      address,
      status: me ? "eligible" : heldMs < firstTierMs ? "too-new" : "below-minimum",
      balance: h.balance,
      counted: h.minSinceRound < h.balance ? h.minSinceRound : h.balance, // lowest balance this round
      heldMs,
      mult: multiplier(heldMs, cfg.airdrop.tiers),
      next: next ? { mult: next.mult, inMs: next.inMs } : null,
      eligibleInMs: heldMs < firstTierMs ? firstTierMs - heldMs : 0,
      sharePct: me ? pct(me.weight, total) : 0,
      projectedTokens: me && total > 0n ? (bought * me.weight) / total : 0n,
      nextRoundAt: ov?.v?.airdrop?.nextAt ?? null,
      // Selling or sending any amount out restarts the clock: multiplier to 0,
      // eligible again after the first tier, back to today's multiplier after heldMs.
      ifSold: { mult: 0, eligibleAgainInMs: firstTierMs, regainCurrentInMs: heldMs },
    };
  }

  const server = createServer(async (req, res) => {
    try {
      if (req.method !== "GET") return res.writeHead(405).end();
      const url = new URL(req.url ?? "/", "http://local");
      // The API is public, read-only JSON, so any site may embed the dashboard
      // (otcmarketpf.com/engine reads it cross-origin when not proxied).
      const api = { "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*" };
      if (url.pathname === "/api/wallet") {
        const address = (url.searchParams.get("address") ?? "").trim();
        if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) return res.writeHead(400, api).end("bad address");
        res.writeHead(200, api);
        return res.end(json(await wallet(address)));
      }
      if (url.pathname === "/api/state") {
        res.writeHead(200, api);
        return res.end(json(await state()));
      }
      if (req.url === "/healthz") {
        const [ov] = await sql<{ v: any }[]>`select v from kv where k = 'overview'`;
        const fresh = !!ov && Date.now() - ov.v.at < cfg.tickMs * 5;
        return res.writeHead(fresh ? 200 : 503).end(fresh ? "ok" : "stale");
      }
      // Dashboard art (mecha + HUD glyphs). The name pattern rules out path traversal.
      const asset = url.pathname.match(/^\/assets\/([a-z0-9-]+)\.(svg|webp|png)$/);
      if (asset) {
        const type = { svg: "image/svg+xml", webp: "image/webp", png: "image/png" }[asset[2]]!;
        const body = await readFile(join(__dirname, "..", "web", "assets", `${asset[1]}.${asset[2]}`)).catch(() => null);
        if (!body) return res.writeHead(404).end("not found");
        res.writeHead(200, { "content-type": type, "cache-control": "public, max-age=86400" });
        return res.end(body);
      }
      if (url.pathname === "/logo.png") {
        res.writeHead(200, { "content-type": "image/png", "cache-control": "public, max-age=86400" });
        return res.end(await readFile(join(__dirname, "..", "web", "logo.png")));
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
