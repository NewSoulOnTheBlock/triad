// An in-memory stand-in for Chain. Instructions are plain objects; submit()
// applies them to a balance sheet. Failure knobs let tests break things at
// exactly the moments that matter.

import { Keypair, PublicKey } from "@solana/web3.js";
import type { Prepared } from "../src/chain.js";

type Ix =
  | { kind: "claim" }
  | { kind: "buy"; user: string; quote: bigint }
  | { kind: "sell"; user: string; tokens: bigint }
  | { kind: "transfer"; from: string; mint: string; items: { owner: string; amount: bigint }[] };

export class FakeChain {
  balances = new Map<string, bigint>(); // `${owner}|${mint}`
  holders = new Map<string, bigint>();
  pendingFees = 0n;
  price = 1; // quote per token
  quoteUsdPrice = 1;
  supply = 1_000_000_000_000_000n;
  height = 100;
  landed = new Map<string, "landed" | "failed">();
  submits = 0;
  /** throw before broadcasting (like a failed simulation) */
  failBeforeSend = 0;
  /** broadcast + land, then throw (like the process dying mid-confirm) */
  crashAfterLand = 0;
  private prepared = new Map<string, Ix[]>();
  private n = 0;

  constructor(readonly treasury: string, readonly quoteMint: string, readonly mint: string) {}

  key = (o: string, m: string) => `${o}|${m}`;
  bal = (o: string, m: string) => this.balances.get(this.key(o, m)) ?? 0n;
  add(o: string, m: string, d: bigint) {
    const v = this.bal(o, m) + d;
    if (v < 0n) throw new Error(`insufficient ${m} for ${o}`);
    this.balances.set(this.key(o, m), v);
    if (m === this.mint) this.holders.set(o, v);
  }

  // ---- reads ----
  async solBalance() { return 1e9; }
  async migrated() { return false; }
  async price_() { return this.price; }
  async quoteUsd() { return this.quoteUsdPrice; }
  async totalSupply() { return this.supply; }
  async snapshotHolders() { return new Map([...this.holders].filter(([, v]) => v > 0n)); }
  async scanSellers(untilSig: string | null) { return { sellers: new Set<string>(), newest: untilSig ?? "s0", venue: "curve" }; }
  async quoteBalance(o: PublicKey) { return this.bal(o.toBase58(), this.quoteMint); }
  async tokenBalance(o: PublicKey) { return this.bal(o.toBase58(), this.mint); }
  async blockHeight() { return this.height; }
  async sigOutcomes(sigs: string[]) { return new Map(sigs.map((s) => [s, this.landed.get(s) ?? ("unknown" as const)])); }

  // ---- builders ----
  async claimIxs() { return [{ kind: "claim" }] as any[]; }
  async buyIxs(user: PublicKey, quote: bigint) { return [{ kind: "buy", user: user.toBase58(), quote }] as any[]; }
  async sellIxs(user: PublicKey, tokens: bigint) { return [{ kind: "sell", user: user.toBase58(), tokens }] as any[]; }
  transferIxs(from: PublicKey, mint: PublicKey, items: { owner: string; amount: bigint }[]) {
    return [{ kind: "transfer", from: from.toBase58(), mint: mint.toBase58(), items }] as any[];
  }

  // ---- sending ----
  async prepare(ixs: Ix[], _signer: Keypair): Promise<Prepared> {
    const sig = `sig${++this.n}`;
    this.prepared.set(sig, ixs);
    return { sig, raw: Buffer.alloc(0), blockhash: "bh", lastValidBlockHeight: this.height + 150 };
  }

  async submit(p: Prepared) {
    if (this.failBeforeSend > 0) {
      this.failBeforeSend--;
      throw new Error("simulation failed");
    }
    this.submits++;
    for (const ix of this.prepared.get(p.sig)!) this.apply(ix);
    this.landed.set(p.sig, "landed");
    if (this.crashAfterLand > 0) {
      this.crashAfterLand--;
      throw new Error("connection lost while confirming");
    }
    return p.sig;
  }

  private apply(ix: Ix) {
    if (ix.kind === "claim") {
      this.add(this.treasury, this.quoteMint, this.pendingFees);
      this.pendingFees = 0n;
    } else if (ix.kind === "buy") {
      this.add(ix.user, this.quoteMint, -ix.quote);
      this.add(ix.user, this.mint, BigInt(Math.floor(Number(ix.quote) / this.price)));
    } else if (ix.kind === "sell") {
      this.add(ix.user, this.mint, -ix.tokens);
      this.add(ix.user, this.quoteMint, BigInt(Math.floor(Number(ix.tokens) * this.price)));
    } else {
      for (const it of ix.items) {
        this.add(ix.from, ix.mint, -it.amount);
        this.add(it.owner, ix.mint, it.amount);
      }
    }
  }
}

// Chain exposes price() as { price, venue }; adapt the fake.
export function asChain(f: FakeChain): any {
  return new Proxy(f, {
    get(t, p) {
      if (p === "price") return async () => ({ price: t.price, venue: "curve" });
      const v = (t as any)[p];
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
}
