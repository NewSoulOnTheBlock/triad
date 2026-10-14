// Finishes an airdrop round whose buy landed but whose tokens were never queued
// (the balance read right after the buy can lag the chain and come back 0).
// Allocates what the airdrop wallet holds beyond what it already owes to the
// wallets eligible now, writes the payouts into the ledger under that round,
// and leaves delivery to the engine's settle step. The airdrop clock is not
// touched, so the next regular round keeps its time.
//
//   npx tsx scripts/airdrop-now.ts           preview only
//   npx tsx scripts/airdrop-now.ts --send    queue the payouts

import { loadConfig } from "../src/config";
import { Chain } from "../src/chain";
import * as db from "../src/db";
import { airdropEligible, allocate } from "../src/logic/airdrop";

async function main() {
  const send = process.argv.includes("--send");
  const cfg = loadConfig();
  if (cfg.prelaunch) throw new Error("no MINT set");
  const sql = db.connect(cfg.databaseUrl);
  const chain = await new Chain(cfg).init();
  const wallet = cfg.airdropWallet.publicKey.toBase58();
  const mint = cfg.mint.toBase58();
  const engine = new Set([cfg.treasury, cfg.botWallet, cfg.airdropWallet].map((k) => k.publicKey.toBase58()));

  const [round] = await sql<{ id: number; ts: Date }[]>`
    select id, ts from airdrops a
    where recipients = 0 and not exists (select 1 from payouts p where p.kind = 'airdrop' and p.ref = a.id::text)
    order by id desc limit 1`;
  if (!round) {
    console.log("no unqueued airdrop round");
    return sql.end();
  }

  const free = (await chain.tokenBalance(cfg.airdropWallet.publicKey)) - (await db.owed(sql, wallet, mint));
  const holders = await db.loadHolders(sql);
  const recipients = airdropEligible(holders.values(), Date.now(), { minAgeMs: cfg.airdrop.minAgeMs, exclude: engine, minBalance: cfg.airdrop.minBalance });
  const { payouts, leftover } = allocate(free, recipients, cfg.airdrop.minPayout);
  console.log(`round #${round.id} (${round.ts.toISOString()}): ${free} tokens free -> ${payouts.length} of ${recipients.length} eligible holders, ${leftover} left over`);
  for (const p of payouts) console.log(`  ${p.owner}  ${p.amount}`);
  if (!send || !payouts.length) {
    console.log(send ? "nothing to queue" : "\npreview only. re-run with --send to queue these payouts.");
    return sql.end();
  }

  await sql.begin(async (tx) => {
    await tx`update airdrops set tokens = ${free.toString()}, recipients = ${payouts.length} where id = ${round.id}`;
    await db.enqueuePayouts(tx, "airdrop", String(round.id), wallet, mint, payouts);
  });
  console.log("queued. the engine's settle step delivers them on its next tick.");
  await sql.end();
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
