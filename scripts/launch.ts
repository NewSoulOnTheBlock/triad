// Launch the coin on pump.fun: quoted in $PUMP, 2.1% creator fee (0.7% per bucket) to the
// treasury wallet, optional dev buy in the same transaction.
//
//   npm run launch                  preflight + simulation + size check. Spends nothing.
//   npm run launch -- --rehearse    also creates the lookup table (~0.003 SOL, reclaimable)
//                                   and simulates the exact launch transaction against it.
//   npm run launch -- --send        rehearse, upload metadata, launch, verify on chain.
//
// Env: RPC_URL, DEV_KEYPAIR, TREASURY_KEYPAIR, TOKEN_NAME, TOKEN_SYMBOL,
// TOKEN_IMAGE (+ TOKEN_DESCRIPTION, TWITTER, TELEGRAM, WEBSITE) or METADATA_URI.
// Optional: DEV_BUY_PUMP (whole $PUMP, e.g. 50000), MINT_KEYPAIR (vanity),
// CREATOR_FEE_BPS (default 210 = 2.1% total, 0.7% per bucket), LOOKUP_TABLE (reuse one from a rehearsal).

import "dotenv/config";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import {
  AddressLookupTableAccount,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { PUMP_SDK, bondingCurvePda } from "@pump-fun/pump-sdk";
import { PUMP_MINT, loadKeypair } from "../src/config";
import { buildLaunch, createLookupTable, staticAccounts, tableForSizing, type LaunchParams } from "../src/launch";

const need = (k: string): string => {
  const v = process.env[k];
  if (!v) {
    console.error(`missing env ${k}`);
    process.exit(1);
  }
  return v;
};

async function uploadMetadata(): Promise<string> {
  if (process.env.METADATA_URI) return process.env.METADATA_URI;
  const image = need("TOKEN_IMAGE");
  const form = new FormData();
  form.append("file", new Blob([readFileSync(image)]), basename(image));
  form.append("name", need("TOKEN_NAME"));
  form.append("symbol", need("TOKEN_SYMBOL"));
  form.append("description", process.env.TOKEN_DESCRIPTION ?? "");
  for (const k of ["twitter", "telegram", "website"]) if (process.env[k.toUpperCase()]) form.append(k, process.env[k.toUpperCase()]!);
  form.append("showName", "true");
  const r = await fetch("https://pump.fun/api/ipfs", { method: "POST", body: form });
  if (!r.ok) throw new Error(`metadata upload failed ${r.status}: ${await r.text()}`);
  return ((await r.json()) as { metadataUri: string }).metadataUri;
}

async function legacyTx(conn: Connection, ixs: TransactionInstruction[], signers: Keypair[]) {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: signers[0].publicKey, blockhash, lastValidBlockHeight }).add(...ixs);
  tx.sign(...signers);
  return tx;
}

async function v0Tx(conn: Connection, ixs: TransactionInstruction[], signers: Keypair[], table: AddressLookupTableAccount) {
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({ payerKey: signers[0].publicKey, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message([table]);
  const tx = new VersionedTransaction(msg);
  tx.sign(signers);
  return tx;
}

async function simulateOrDie(conn: Connection, tx: Transaction | VersionedTransaction) {
  const sim = tx instanceof VersionedTransaction ? await conn.simulateTransaction(tx) : await conn.simulateTransaction(tx);
  if (sim.value.err) throw new Error(`simulation FAILED: ${JSON.stringify(sim.value.err)}\n${(sim.value.logs ?? []).slice(-6).join("\n")}`);
  console.log(`simulation ok (${sim.value.unitsConsumed} CU)`);
}

async function sendAndVerify(conn: Connection, tx: Transaction | VersionedTransaction, p: LaunchParams) {
  const bh = await conn.getLatestBlockhash("confirmed");
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 5 });
  const res = await conn.confirmTransaction({ signature: sig, ...bh }, "confirmed");
  if (res.value.err) throw new Error(`launch failed on chain: ${JSON.stringify(res.value.err)} (${sig})`);
  const curve = PUMP_SDK.decodeBondingCurveNullable((await conn.getAccountInfo(bondingCurvePda(p.mint)))!)!;
  const verified =
    curve.creator.equals(p.treasury) && curve.creatorFeeBps.toNumber() === p.creatorFeeBps &&
    curve.quoteMint.equals(p.quoteMint) && !(curve as { isHolderReward?: boolean }).isHolderReward;
  console.log(`launched  https://solscan.io/tx/${sig}`);
  console.log(`verified  creator=${curve.creator.toBase58()} fee=${curve.creatorFeeBps.toString()}bps quote=${curve.quoteMint.toBase58()} → ${verified ? "OK" : "MISMATCH — stop and check before running the engine"}`);
  console.log(`\nadd to .env:\nMINT=${p.mint.toBase58()}\nLAUNCH_TIME=${new Date().toISOString()}\nDEV_WALLET=${p.dev.toBase58()}`);
}

async function main() {
  const send = process.argv.includes("--send");
  const rehearse = send || process.argv.includes("--rehearse");
  const conn = new Connection(need("RPC_URL"), "confirmed");
  const dev = loadKeypair(need("DEV_KEYPAIR"));
  const treasury = loadKeypair(need("TREASURY_KEYPAIR"));
  const mint = process.env.MINT_KEYPAIR ? loadKeypair(process.env.MINT_KEYPAIR) : Keypair.generate();
  const devBuyQuote = BigInt(Math.round(Number(process.env.DEV_BUY_PUMP ?? 0) * 1e6));
  if (!process.env.TOKEN_IMAGE && !process.env.METADATA_URI) need("TOKEN_IMAGE");

  const params: LaunchParams = {
    conn, mint: mint.publicKey, dev: dev.publicKey, treasury: treasury.publicKey, quoteMint: PUMP_MINT,
    name: need("TOKEN_NAME"), symbol: need("TOKEN_SYMBOL"),
    uri: process.env.METADATA_URI ?? "https://example.invalid/placeholder.json", // replaced by the real upload on --send
    creatorFeeBps: Number(process.env.CREATOR_FEE_BPS ?? 210), devBuyQuote,
  };
  const built = await buildLaunch(params);
  for (const [label, ok] of built.checks) console.log(ok ? "  ok  " : "  FAIL", label);

  const pumpAccts = await conn.getTokenAccountsByOwner(dev.publicKey, { mint: PUMP_MINT });
  const pumpBal = pumpAccts.value.length ? BigInt((await conn.getTokenAccountBalance(pumpAccts.value[0].pubkey)).value.amount) : 0n;
  const solBal = await conn.getBalance(dev.publicKey);
  console.log(`
  mint      ${mint.publicKey.toBase58()}
  creator   ${treasury.publicKey.toBase58()}  (treasury: receives the fee)
  dev       ${dev.publicKey.toBase58()}  (pays, first buyer) · ${(solBal / 1e9).toFixed(4)} SOL · ${(Number(pumpBal) / 1e6).toLocaleString()} $PUMP
  quote     $PUMP ${PUMP_MINT.toBase58()}
  fee       ${params.creatorFeeBps} bps
  dev buy   ${devBuyQuote > 0n ? `${Number(devBuyQuote) / 1e6} $PUMP → ~${(Number(built.expectedTokens) / 1e6).toLocaleString()} tokens` : "none"}
`);
  if (solBal < 50_000_000) throw new Error("dev wallet needs at least 0.05 SOL");
  if (pumpBal < devBuyQuote) throw new Error("dev wallet holds less $PUMP than DEV_BUY_PUMP");
  const signers = [dev, mint];

  // No dev buy: the create fits a plain transaction.
  if (devBuyQuote === 0n) {
    await simulateOrDie(conn, await legacyTx(conn, built.ixs, signers));
    if (!send) return console.log("\nnothing sent. re-run with --send to launch.");
    const real = await buildLaunch({ ...params, uri: await uploadMetadata() });
    const tx = await legacyTx(conn, real.ixs, signers);
    await simulateOrDie(conn, tx);
    return sendAndVerify(conn, tx, params);
  }

  // With a dev buy: one v0 transaction through a lookup table.
  const statics = await staticAccounts(params, built.ixs);
  const size = new VersionedTransaction(
    new TransactionMessage({ payerKey: dev.publicKey, recentBlockhash: PublicKey.default.toBase58(), instructions: built.ixs })
      .compileToV0Message([tableForSizing(statics, dev.publicKey)]),
  ).serialize().length;
  console.log(`launch tx through a lookup table: ${size} / 1232 bytes (${statics.length} accounts in the table)`);
  if (size > 1232) throw new Error("launch transaction too large even with a lookup table");
  if (!rehearse) return console.log("\nnothing sent. --rehearse creates the lookup table and simulates the real transaction; --send launches.");

  const table = process.env.LOOKUP_TABLE
    ? (await conn.getAddressLookupTable(new PublicKey(process.env.LOOKUP_TABLE))).value
    : await createLookupTable(conn, dev, statics);
  if (!table) throw new Error("LOOKUP_TABLE not found");
  console.log(`lookup table ${table.key.toBase58()} (set LOOKUP_TABLE=${table.key.toBase58()} to reuse it)`);
  await simulateOrDie(conn, await v0Tx(conn, built.ixs, signers, table));
  if (!send) return console.log("\nrehearsal passed. nothing launched. re-run with --send.");

  const real = await buildLaunch({ ...params, uri: await uploadMetadata() });
  const tx = await v0Tx(conn, real.ixs, signers, table);
  await simulateOrDie(conn, tx);
  await sendAndVerify(conn, tx, params);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
