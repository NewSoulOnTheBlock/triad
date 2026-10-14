// Delivers the payout ledger for one wallet. Safe to run any number of times,
// including after a crash at any point:
//
//   1. Rows marked `sent` are checked against the chain by signature:
//        landed  → paid
//        failed  → back to pending
//        unknown → back to pending only once the blockhash has expired
//                  (it can never land after that), otherwise left alone.
//   2. Pending rows are signed in batches, marked `sent` WITH the signature,
//      and only then broadcast. A crash after that is resolved by step 1.

import type { Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import * as db from "./db.js";
import { TRANSFERS_PER_TX, type Prepared } from "./chain.js";
import { PublicKey as PK } from "@solana/web3.js";

export interface SettleChain {
  sigOutcomes(sigs: string[]): Promise<Map<string, "landed" | "failed" | "unknown">>;
  blockHeight(): Promise<number>;
  transferIxs(from: PublicKey, mint: PublicKey, items: { owner: string; amount: bigint }[]): TransactionInstruction[];
  prepare(ixs: TransactionInstruction[], signer: Keypair): Promise<Prepared>;
  submit(p: Prepared): Promise<string>;
}

export async function settle(sql: db.Sql, chain: SettleChain, signer: Keypair, log: (...a: unknown[]) => void) {
  const from = signer.publicKey.toBase58();
  let rows = await db.openPayouts(sql, from);
  if (rows.length === 0) return { paid: 0, pending: 0 };

  // 1. resolve anything already broadcast (or that might have been)
  const sent = new Map<string, number>();
  for (const r of rows) if (r.status === "sent" && r.sig) sent.set(r.sig, Number(r.last_valid_height ?? 0));
  if (sent.size) {
    const [outcomes, height] = await Promise.all([chain.sigOutcomes([...sent.keys()]), chain.blockHeight()]);
    for (const [sig, lastValid] of sent) {
      const o = outcomes.get(sig);
      if (o === "landed") await db.markPaid(sql, sig);
      else if (o === "failed" || height > lastValid) await db.markRetry(sql, sig);
    }
    rows = await db.openPayouts(sql, from);
  }

  // 2. send what is pending, batched per mint
  const pending = rows.filter((r) => r.status === "pending");
  const byMint = new Map<string, db.PayoutRow[]>();
  for (const r of pending) byMint.set(r.mint, [...(byMint.get(r.mint) ?? []), r]);
  let paid = 0;
  for (const [mint, list] of byMint) {
    for (let i = 0; i < list.length; i += TRANSFERS_PER_TX) {
      const chunk = list.slice(i, i + TRANSFERS_PER_TX);
      const ixs = chain.transferIxs(signer.publicKey, new PK(mint), chunk.map((r) => ({ owner: r.owner, amount: BigInt(r.amount) })));
      const p = await chain.prepare(ixs, signer);
      await db.markSent(sql, chunk.map((r) => r.id), p.sig, p.lastValidBlockHeight);
      try {
        await chain.submit(p);
        await db.markPaid(sql, p.sig);
        paid += chunk.length;
      } catch (e) {
        // Left as `sent`; the next run resolves it by signature.
        log(`[settle] batch ${p.sig.slice(0, 8)} not confirmed: ${(e as Error).message}`);
        return { paid, pending: pending.length - paid };
      }
    }
  }
  return { paid, pending: pending.length - paid };
}
