import postgres from "postgres";
import type { Holder } from "./logic/holders.js";
import { EMPTY_LADDER, type LadderState } from "./logic/prize.js";
import { INITIAL_BOT, type BotState } from "./logic/bot.js";

export type Sql = ReturnType<typeof postgres>;
// Anything that can run a query: the pool or a transaction handle.
export type Q = Sql | postgres.TransactionSql;

export const connect = (url: string) =>
  postgres(url, { max: Number(process.env.DB_POOL_MAX ?? 5), types: { bigint: postgres.BigInt }, onnotice: () => {} });

export async function migrate(sql: Sql) {
  await sql`
    create table if not exists holders (
      owner text primary key,
      balance numeric not null,
      held_since timestamptz not null,
      qualified_since timestamptz,
      updated_at timestamptz not null default now()
    )`;
  await sql`create table if not exists kv (k text primary key, v jsonb not null)`;
  await sql`
    create table if not exists price_samples (
      ts timestamptz primary key default now(),
      price double precision not null,
      quote_usd double precision,
      mcap_usd double precision,
      venue text
    )`;
  await sql`
    create table if not exists fee_claims (
      id serial primary key, ts timestamptz not null default now(),
      amount numeric not null, per_bucket numeric not null, sig text
    )`;
  await sql`
    create table if not exists milestones (
      level int primary key, ts timestamptz not null default now(),
      mcap_usd double precision not null, pot numeric not null,
      winners jsonb not null
    )`;
  await sql`
    create table if not exists bot_trades (
      id serial primary key, ts timestamptz not null default now(),
      side text not null, quote numeric not null, tokens numeric not null,
      price double precision not null, reason text not null,
      sig text, status text not null default 'sent'
    )`;
  await sql`
    create table if not exists airdrops (
      id serial primary key, ts timestamptz not null default now(),
      quote_spent numeric not null, tokens numeric not null,
      recipients int not null, buy_sig text
    )`;
  // The payout ledger. Every outgoing transfer is a row here before it is a
  // transaction, so a crash or a half-failed batch can never pay twice.
  await sql`
    create table if not exists payouts (
      id bigserial primary key,
      kind text not null,
      ref text not null,
      from_wallet text not null,
      mint text not null,
      owner text not null,
      amount numeric not null,
      status text not null default 'pending',
      sig text,
      last_valid_height bigint,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )`;
  await sql`create index if not exists payouts_open on payouts (from_wallet, status)`;
}

// ---- holders ----
export async function loadHolders(q: Q) {
  const rows = await q<{ owner: string; balance: string; held_since: Date; qualified_since: Date | null }[]>`
    select owner, balance::text, held_since, qualified_since from holders`;
  return new Map<string, Holder>(
    rows.map((r) => [
      r.owner,
      { owner: r.owner, balance: BigInt(r.balance), heldSince: r.held_since.getTime(), qualifiedSince: r.qualified_since?.getTime() ?? null },
    ]),
  );
}

export async function saveHolders(sql: Sql, next: Map<string, Holder>) {
  await sql.begin(async (tx) => {
    await tx`delete from holders`;
    const rows = [...next.values()].map((h) => ({
      owner: h.owner,
      balance: h.balance.toString(),
      held_since: new Date(h.heldSince),
      qualified_since: h.qualifiedSince === null ? null : new Date(h.qualifiedSince),
    }));
    for (let i = 0; i < rows.length; i += 1000) await tx`insert into holders ${tx(rows.slice(i, i + 1000))}`;
  });
}

// ---- engine state (bigints stored as strings) ----
type Stored = {
  ladder: LadderState;
  lastPaidLevel: number;
  prizePot: string;
  bot: Omit<BotState, "tokens"> & { tokens: string };
  lastClaimAt: number;
  lastAirdropAt: number;
  lastSig: string | null;
  lastSigVenue: string | null;
  lastDecision: unknown;
};
const DEFAULT: Stored = {
  ladder: EMPTY_LADDER,
  lastPaidLevel: 0,
  prizePot: "0",
  bot: { ...INITIAL_BOT, tokens: "0" },
  lastClaimAt: 0,
  lastAirdropAt: 0,
  lastSig: null,
  lastSigVenue: null,
  lastDecision: null,
};

export async function loadState(q: Q) {
  const [row] = await q<{ v: Stored }[]>`select v from kv where k = 'state'`;
  const s = { ...DEFAULT, ...(row?.v ?? {}) };
  return { ...s, prizePot: BigInt(s.prizePot), bot: { ...s.bot, tokens: BigInt(s.bot.tokens) } as BotState };
}
export type State = Awaited<ReturnType<typeof loadState>>;

export async function saveState(q: Q, s: State) {
  await setKv(q, "state", { ...s, prizePot: s.prizePot.toString(), bot: { ...s.bot, tokens: s.bot.tokens.toString() } });
}

export async function setKv(q: Q, k: string, v: unknown) {
  await q`insert into kv (k, v) values (${k}, ${q.json(v as any)}) on conflict (k) do update set v = excluded.v`;
}

// ---- payout ledger ----
export type PayoutRow = {
  id: string; kind: string; ref: string; from_wallet: string; mint: string;
  owner: string; amount: string; status: "pending" | "sent" | "paid"; sig: string | null; last_valid_height: string | null;
};

export async function enqueuePayouts(q: Q, kind: string, ref: string, from: string, mint: string, items: { owner: string; amount: bigint }[]) {
  const rows = items.filter((i) => i.amount > 0n).map((i) => ({ kind, ref, from_wallet: from, mint, owner: i.owner, amount: i.amount.toString() }));
  for (let i = 0; i < rows.length; i += 1000) await q`insert into payouts ${q(rows.slice(i, i + 1000))}`;
}

// What a wallet has promised but not yet delivered, per mint. Subtracted from
// its balance before anything new is allocated.
export async function owed(q: Q, from: string, mint: string): Promise<bigint> {
  const [r] = await q<{ s: string | null }[]>`
    select sum(amount)::text as s from payouts where from_wallet = ${from} and mint = ${mint} and status <> 'paid'`;
  return BigInt(r?.s ?? "0");
}

export const openPayouts = (q: Q, from: string) => q<PayoutRow[]>`
  select id::text, kind, ref, from_wallet, mint, owner, amount::text, status, sig, last_valid_height::text
  from payouts where from_wallet = ${from} and status <> 'paid' order by id`;

export async function markSent(q: Q, ids: string[], sig: string, lastValidHeight: number) {
  await q`update payouts set status = 'sent', sig = ${sig}, last_valid_height = ${lastValidHeight}, updated_at = now() where id in ${q(ids)}`;
}
export async function markPaid(q: Q, sig: string) {
  await q`update payouts set status = 'paid', updated_at = now() where sig = ${sig}`;
}
export async function markRetry(q: Q, sig: string) {
  await q`update payouts set status = 'pending', sig = null, last_valid_height = null, updated_at = now() where sig = ${sig} and status = 'sent'`;
}
