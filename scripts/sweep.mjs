// Sweep bucket wallets: every token balance + all SOL -> one destination.
//
//   node scripts/sweep.mjs <DEST> <ENV_KEY> [<ENV_KEY> ...]           simulate only
//   node scripts/sweep.mjs <DEST> <ENV_KEY> [<ENV_KEY> ...] --send    broadcast
//
// Flags: --env <file>   read keys/RPC from this env file instead of .env (e.g. .env.otc)
//        --tokens-only  transfer every token balance but leave SOL and the token
//                       accounts in place, so the engine can be restarted later
//
// ENV_KEY names a keypair in the env file (JSON byte array, base58, or a path to either).
// Per wallet: tx 1 creates the destination ATAs (idempotent), transfers every
// token balance in full and closes the emptied accounts (rent -> DEST);
// tx 2 then sends the remaining SOL. Prints a plan and simulation results first.
import fs from "node:fs";
import { createRequire } from "node:module";

const req = createRequire(process.cwd() + "/package.json");
const web3 = req("@solana/web3.js");
const spl = req("@solana/spl-token");
const bs58 = req("bs58").default ?? req("bs58");
const { Connection, Keypair, PublicKey, SystemProgram, Transaction, ComputeBudgetProgram } = web3;

const args = process.argv.slice(2);
const SEND = args.includes("--send");
const TOKENS_ONLY = args.includes("--tokens-only");
const envIdx = args.indexOf("--env");
const ENV_FILE = envIdx >= 0 ? args[envIdx + 1] : ".env";
const positional = args.filter((a, i) => a !== "--send" && a !== "--tokens-only" && a !== "--env" && i !== envIdx + 1);
const [destArg, ...keyNames] = positional;
const DEST = new PublicKey(destArg);
const LABEL = { pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn: "PUMP", GLPbc2tSS844kLztd4Zj1NTSy8zjvHsFud75jnGZpump: "pENGINE", BX4GPRFgtmQp9W8e6goFr7xq9Tks4xK9C1ouXHCPpump: "pFUEL", "7rkqDbQgTtvqJg4Q5z3BS4pDZgZdXx7gysENetRppump": "OTC" };

const env = Object.fromEntries(fs.readFileSync(ENV_FILE, "utf8").split(/\r?\n/).filter((l) => /^[A-Z0-9_]+=/.test(l))
  .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).replace(/\s+#.*$/, "").trim().replace(/^"|"$/g, "")]));
const conn = new Connection(env.RPC_URL, "confirmed");

function loadKey(name) {
  let v = env[name];
  if (!v) throw new Error(`${name} not set in ${ENV_FILE}`);
  if (fs.existsSync(v)) v = fs.readFileSync(v, "utf8").trim();
  return Keypair.fromSecretKey(v.startsWith("[") ? Uint8Array.from(JSON.parse(v)) : bs58.decode(v));
}

async function tokenAccounts(owner) {
  const out = [];
  for (const program of [spl.TOKEN_PROGRAM_ID, spl.TOKEN_2022_PROGRAM_ID]) {
    const res = await conn.getParsedTokenAccountsByOwner(owner, { programId: program });
    for (const a of res.value) {
      const i = a.account.data.parsed.info;
      out.push({ address: a.pubkey, program, mint: new PublicKey(i.mint), amount: BigInt(i.tokenAmount.amount), decimals: i.tokenAmount.decimals, ui: i.tokenAmount.uiAmountString, frozen: i.state === "frozen" });
    }
  }
  return out;
}

async function run(tx, signer, what) {
  tx.feePayer = signer.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
  tx.sign(signer);
  const sim = await conn.simulateTransaction(tx);
  if (sim.value.err) throw new Error(`${what}: simulation failed ${JSON.stringify(sim.value.err)}\n${(sim.value.logs || []).slice(-8).join("\n")}`);
  console.log(`  simulate ${what}: OK`);
  if (!SEND) return null;
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await conn.confirmTransaction(sig, "confirmed");
  console.log(`  sent ${what}: https://solscan.io/tx/${sig}`);
  return sig;
}

console.log(`${SEND ? "SENDING" : "SIMULATION ONLY"}${TOKENS_ONLY ? " (tokens only; SOL and accounts stay)" : ""} -> ${DEST.toBase58()}  [${ENV_FILE}]\n`);
for (const name of keyNames) {
  const kp = loadKey(name);
  const owner = kp.publicKey;
  const all = await tokenAccounts(owner);
  for (const a of all.filter((a) => a.frozen)) console.log(`  skip frozen account: ${a.ui} ${LABEL[a.mint.toBase58()] ?? a.mint.toBase58()}`);
  const accts = all.filter((a) => !a.frozen && (a.amount > 0n || !TOKENS_ONLY));
  const lamports = await conn.getBalance(owner);
  console.log(`${name}  ${owner.toBase58()}  ${lamports / 1e9} SOL`);
  for (const a of accts) console.log(`  ${a.ui} ${LABEL[a.mint.toBase58()] ?? a.mint.toBase58()}`);

  if (accts.length) {
    const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 60_000 * accts.length + 20_000 }));
    for (const a of accts) {
      if (a.amount > 0n) {
        const destAta = spl.getAssociatedTokenAddressSync(a.mint, DEST, true, a.program);
        tx.add(spl.createAssociatedTokenAccountIdempotentInstruction(owner, destAta, DEST, a.mint, a.program));
        tx.add(spl.createTransferCheckedInstruction(a.address, a.mint, destAta, owner, a.amount, a.decimals, [], a.program));
      }
      if (!TOKENS_ONLY) tx.add(spl.createCloseAccountInstruction(a.address, DEST, owner, [], a.program));
    }
    if (tx.instructions.length > 1) await run(tx, kp, "tokens"); else console.log("  nothing to transfer");
  }
  if (TOKENS_ONLY) { console.log(""); continue; }

  // SOL: whatever is left after the token tx, minus this tx's fee.
  const left = SEND ? await conn.getBalance(owner) : lamports;
  const fee = 5000;
  if (left > fee) {
    const amount = SEND ? left - fee : Math.max(0, left - fee - 2_100_000 * accts.filter((a) => a.amount > 0n).length);
    const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: owner, toPubkey: DEST, lamports: amount }));
    await run(tx, kp, `SOL ${(amount / 1e9).toFixed(6)}`).catch((e) => {
      if (SEND) throw e;
      console.log(`  simulate SOL: depends on tx 1 landing first (${e.message.split("\n")[0]})`);
    });
  }
  console.log("");
}
