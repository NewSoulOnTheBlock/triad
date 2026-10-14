// Creates the three engine wallets under ./keys (gitignored). Never
// overwrites an existing file. Your dev wallet is NOT made here — use your own.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { Keypair } from "@solana/web3.js";

mkdirSync("keys", { recursive: true });
for (const name of ["treasury", "bot", "airdrop"]) {
  const path = `keys/${name}.json`;
  if (existsSync(path)) {
    console.log(`kept     ${path}`);
    continue;
  }
  const kp = Keypair.generate();
  writeFileSync(path, JSON.stringify([...kp.secretKey]), { mode: 0o600 });
  console.log(`created  ${path}  ${kp.publicKey.toBase58()}`);
}
console.log("\nFund each with ~0.05 SOL for fees. Back up ./keys somewhere safe.");
