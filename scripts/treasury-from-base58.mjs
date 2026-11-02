// Writes keys/otc/treasury.json from a base58 secret key typed into YOUR terminal.
// Run it yourself (not through Claude): `node scripts/treasury-from-base58.mjs`
// The key is read with echo off, never printed, never logged. The file is
// refused unless the key is the coin's creator of record.
import { existsSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

const CREATOR = "CHw1UCpgE3A6DTJjK14stHq3kQjh9CMK7Yd1B4aagdPQ";
const OUT = "keys/otc/treasury.json";

if (existsSync(OUT)) {
  console.log(`${OUT} already exists; delete it first if you mean to replace it.`);
  process.exit(1);
}

const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
process.stdout.write("Paste the treasury secret key (base58, hidden): ");
rl._writeToOutput = () => {}; // echo off
rl.question("", (line) => {
  rl.close();
  process.stdout.write("\n");
  let kp;
  try {
    kp = Keypair.fromSecretKey(bs58.decode(line.trim()));
  } catch {
    console.error("That is not a valid base58 secret key.");
    process.exit(1);
  }
  if (kp.publicKey.toBase58() !== CREATOR) {
    console.error(`Refused: that key is ${kp.publicKey.toBase58()}, not the creator ${CREATOR}.`);
    process.exit(1);
  }
  writeFileSync(OUT, JSON.stringify([...kp.secretKey]), { mode: 0o600 });
  console.log(`wrote ${OUT} for ${CREATOR}`);
});
