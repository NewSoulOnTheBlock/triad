import { loadConfig } from "./config.js";
import { Chain } from "./chain.js";
import * as db from "./db.js";
import { Engine } from "./engine.js";
import { serve } from "./server.js";

async function main() {
  const cfg = loadConfig();
  const sql = db.connect(cfg.databaseUrl);
  await db.migrate(sql);
  const chain = await new Chain(cfg).init();
  const engine = new Engine(cfg, chain, sql);
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
