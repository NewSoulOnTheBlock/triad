import { loadConfig } from "./config.js";
import { Chain } from "./chain.js";
import * as db from "./db.js";
import { Engine } from "./engine.js";
import { serve } from "./server.js";

async function main() {
  const cfg = loadConfig();
  const sql = db.connect(cfg.databaseUrl);
  await db.migrate(sql);
  if (!cfg.prelaunch && (!process.env.DEV_WALLET || !process.env.LAUNCH_TIME)) throw new Error("MINT is set: DEV_WALLET and LAUNCH_TIME are required too");
  if (cfg.prelaunch) {
    serve(cfg, sql);
    const wallets = Object.fromEntries((["treasury", "volumeWallet", "botWallet", "airdropWallet"] as const).map((n) => [n, { address: cfg[n].publicKey.toBase58(), sol: null, low: false }]));
    const overview = () => ({ at: Date.now(), prelaunch: true, dryRun: cfg.dryRun, wallets, volume: { everyMs: cfg.volume.everyMs, cyclesPerWallet: cfg.volume.cyclesPerWallet, maxImpactPct: cfg.volume.maxImpactPct } });
    await db.setKv(sql, "overview", overview());
    console.log("pre-launch: no MINT set. Serving the dashboard only; nothing will tick or send.");
    // keep the heartbeat fresh so /healthz stays green
    setInterval(() => db.setKv(sql, "overview", overview()).catch(() => {}), cfg.tickMs);
    return;
  }
  const chain = await new Chain(cfg).init();
  const { DlmmLp } = await import("./meteora.js");
  const lp = new DlmmLp(chain.conn, cfg, cfg.airdropWallet, chain.quoteTokenProgram, async () => (await chain.price()).price);
  const engine = new Engine(cfg, chain, sql, lp);
  serve(cfg, sql);

  console.log(`engine up — mint ${cfg.mint.toBase58()} quote ${cfg.quoteMint.toBase58()} ${cfg.dryRun ? "[DRY RUN]" : "[LIVE]"}`);
  for (;;) {
    const started = Date.now();
    await engine.tick().catch((e) => console.error("tick failed:", e));
    await new Promise((r) => setTimeout(r, Math.max(0, cfg.tickMs - (Date.now() - started))));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
