import postgres from "postgres";
import type { Holder } from "./logic/holders.js";
import { INITIAL_BOT, type BotState, type Order } from "./logic/bot.js";
import { INITIAL_VOLUME, type VolumeState } from "./logic/volume.js";

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
  await sql`alter table holders add column if not exists min_since_round numeric`;
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
  // Bucket 3: DLMM LP actions (pool create / deploy / rebalance / fee claim), for the dashboard.
  await sql`
    create table if not exists dlmm_log (
      id serial primary key, ts timestamptz not null default now(),
      kind text not null, detail text, quote numeric, sig text
    )`;
  // Bucket 1: throwaway volume sub-wallets. The secret is kept so a crash can
  // still drain funds back to the bucket; rows are deleted once fully drained.
  await sql`
    create table if not exists volume_wallets (
      pubkey text primary key,
      secret text not null,
      status text not null default 'active', -- active | draining | drained
      funded_quote numeric not null default 0,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )`;
  // Bucket 1: every atomic buy+sell cycle, written before it is sent.
  await sql`
    create table if not exists volume_cycles (
      id serial primary key, ts timestamptz not null default now(),
      sub text not null, quote numeric not null, price double precision not null,
      sig text, status text not null default 'sent'
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
  const rows = await q<{ owner: string; balance: string; held_since: Date; min_since_round: string | null }[]>`
    select owner, balance::text, held_since, min_since_round::text from holders`;
  return new Map<string, Holder>(
    rows.map((r) => [
      r.owner,
      { owner: r.owner, balance: BigInt(r.balance), heldSince: r.held_since.getTime(), minSinceRound: BigInt(r.min_since_round ?? r.balance) },
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
      min_since_round: h.minSinceRound.toString(),
    }));
    for (let i = 0; i < rows.length; i += 1000) await tx`insert into holders ${tx(rows.slice(i, i + 1000))}`;
  });
}

// ---- engine state (bigints stored as strings) ----
type Stored = {
  volume: VolumeState;
  bot: Omit<BotState, "tokens" | "order"> & { tokens: string; order: (Omit<Order, "remaining"> & { remaining: string }) | null };
  lastClaimAt: number;
  lastAirdropAt: number;
  // bucket 3 LP state. `pot` = $PUMP claimed from LP fees, owed to the next airdrop
  // (kept apart from LP principal, which is the rest of the wallet's $PUMP).
  dlmm: { pool: string | null; lastClaimAt: number; lastDeployAt: number; pot: string };
  lastSig: string | null;
  lastSigVenue: string | null;
  lastDecision: unknown;
};
const DEFAULT: Stored = {
  volume: INITIAL_VOLUME,
  bot: { ...INITIAL_BOT, tokens: "0", order: null },
  lastClaimAt: 0,
  lastAirdropAt: 0,
  dlmm: { pool: null, lastClaimAt: 0, lastDeployAt: 0, pot: "0" },
  lastSig: null,
  lastSigVenue: null,
  lastDecision: null,
};

export async function loadState(q: Q) {
  const [row] = await q<{ v: Stored }[]>`select v from kv where k = 'state'`;
  const { ladder: _l, lastPaidLevel: _p, prizePot: _pp, buyer: _b, airdropRound: _ar, ...v } = (row?.v ?? {}) as Stored & Record<string, unknown>; // retired prize/buyer/buyback fields
  const s = { ...DEFAULT, ...v };
  const b = { ...DEFAULT.bot, ...s.bot }; // state saved before a field existed gets its default
  const bot: BotState = { ...b, tokens: BigInt(b.tokens), order: b.order ? { ...b.order, remaining: BigInt(b.order.remaining) } : null };
  const d = { ...DEFAULT.dlmm, ...s.dlmm };
  return { ...s, volume: { ...INITIAL_VOLUME, ...s.volume }, bot, dlmm: { pool: d.pool, lastClaimAt: d.lastClaimAt, lastDeployAt: d.lastDeployAt, pot: BigInt(d.pot) } };
}
export type State = Awaited<ReturnType<typeof loadState>>;

export async function saveState(q: Q, s: State) {
  const order = s.bot.order ? { ...s.bot.order, remaining: s.bot.order.remaining.toString() } : null;
  const dlmm = { ...s.dlmm, pot: s.dlmm.pot.toString() };
  await setKv(q, "state", { ...s, bot: { ...s.bot, tokens: s.bot.tokens.toString(), order }, dlmm });
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

// ---- bucket 1: volume sub-wallets ----
export type VolumeWalletRow = { pubkey: string; secret: string; status: string; funded_quote: string };

export async function insertVolumeWallet(q: Q, pubkey: string, secret: string, fundedQuote: bigint) {
  await q`insert into volume_wallets (pubkey, secret, funded_quote) values (${pubkey}, ${secret}, ${fundedQuote.toString()})`;
}
export async function setVolumeStatus(q: Q, pubkey: string, status: "active" | "draining" | "drained") {
  await q`update volume_wallets set status = ${status}, updated_at = now() where pubkey = ${pubkey}`;
}
// Subs that still hold funds (active or mid-drain): the ones a restart must finish draining.
export async function liveVolumeWallets(q: Q): Promise<VolumeWalletRow[]> {
  return q<VolumeWalletRow[]>`select pubkey, secret, status, funded_quote::text from volume_wallets where status <> 'drained' order by created_at`;
}
