# Triad

A pump.fun coin quoted in **$PUMP** with a **2.1% creator fee**, run by an engine that splits every fee into three 0.7% buckets:

| Bucket | What it does |
|---|---|
| **1 · Volume bot** | Its own wallet. Prints **two-sided volume** through rotating throwaway sub-wallets: it funds a fresh sub from the bucket, runs a handful of **atomic buy+sell cycles** (each a single transaction, so the sub never holds the coin across a slot), then drains the sub back to the bucket and rotates to a new one (anti-cluster). Timing and size jittered; no buy moves price more than 1%. Every cycle is on the dashboard; the only net cost is the pump fee on each leg. |
| **2 · Price stabilizer** | Its own wallet (never the dev's). Trades around a slow **anchor** (6h time-weighted average price). Buys dips in **tranches**: 10% of the bucket at −15%, 20% at −25%, 30% at −35%, 40% at −50%; each re-arms once price recovers. Sells **half** its bag each time price clears the next rung (+50%, +100%, …) over its average entry, only above the anchor and while rising, never under entry. Every order is **sliced** so no swap moves price more than 2%. A fast 60% crash pauses buying for 30 min. It dampens swings; it cannot hold a floor against sustained selling. |
| **3 · DLMM liquidity + loyalty fee airdrop** | Post-migration the bucket turns its $PUMP into a **Meteora DLMM** position on the coin/$PUMP pair (the engine creates the pool) and keeps it **in range** — when the active bin leaves the position it removes, re-centres on the active bin, and re-adds. The $PUMP is LP **principal** (it compounds as more fee flows in); the position's **earned trading fees** are claimed, converted to $PUMP, and airdropped each hourly round to holders of 1h+, weighted by **lowest balance held this round × loyalty multiplier**: 1× at 1h, 1.5× at 24h, 2× at 3d, 3× from 7d. Selling or sending out **any** amount resets the multiplier to zero. **Dev included**, engine wallets excluded. Anyone can paste a wallet on the dashboard to see its multiplier, share of the next drop, and what selling would cost. Pre-migration the bucket just accrues $PUMP. |

The dashboard shows every volume cycle, every stabilizer buy and sell, the DLMM position and fee-airdrop rounds, the eligible wallets, plus payout delivery status and wallet gas.

## Why $PUMP

pump.fun only honours a custom `creator_fee_bps` on **custom-pair** coins, meaning coins quoted in something other than SOL or USDC. $PUMP is in pump.fun's on-chain `QuoteControl` list, so it qualifies. Verified on mainnet (2026-10-14):

- `Global.max_configurable_creator_fee_bps = 300`. A create at 300 bps simulates OK; 301 bps fails with `CreatorFeeBpsOutOfRange` (6078).
- **The fee survives graduation.** Graduated 300-bps $PUMP coins have `pool.creatorFeeBps = 300` on PumpSwap.
- ~28.8K curves were already $PUMP-quoted, many at 300 bps.
- The engine's real claim, buy, sell and both payout batches simulate cleanly against live coins, both on the curve and in the pool.

The fee is charged on curve and pool trades only. Wallet-to-wallet transfers are free. That's why the holder clock also resets on transfers out, not only on sells.

## Runbook

```bash
npm install
npm run keygen               # keys/treasury.json, buyer.json, bot.json, airdrop.json (gitignored)
cp .env.example .env         # fill in RPC_URL, DATABASE_URL, DEV_KEYPAIR, TOKEN_*
```

Fund each wallet:
- **treasury**: ~0.05 SOL.
- **volume**: ~0.2 SOL. It seeds each throwaway sub with ~0.01 SOL (recovered on drain) and sends a cycle every ~90s, so it turns over gas fastest; keep it funded.
- **bot** and **airdrop**: ~0.05 SOL each.
- **dev**: SOL, plus the $PUMP for `DEV_BUY_PUMP`.

```bash
npm run launch               # preflight + simulation + size check. Spends nothing.
npm run launch -- --rehearse # creates the lookup table, simulates the exact launch tx
npm run launch -- --send     # uploads metadata, launches, verifies creator/fee/quote on chain
```

Copy `MINT`, `LAUNCH_TIME` and `DEV_WALLET` from the launch output into `.env`, then:

```bash
npm run engine               # DRY_RUN=true first: watch the dashboard make decisions
# then DRY_RUN=false and restart
```

Dashboard: `http://localhost:8787` · health check: `/healthz` (503 if the engine stopped ticking).

**Deploying (Render + Neon).** Run it as a background worker or web service with `npm run engine`. Pass the four keypairs as their JSON byte arrays in env secrets (the loader accepts a path or the array itself). Point `DATABASE_URL` at Neon.

## How it stays correct

- **Payout ledger.** Every transfer is a `payouts` row before it is a transaction. A transaction is signed first and its signature is written to the row, **then** it is broadcast. After a crash or a half-sent batch, rows are settled by checking that signature on chain. A row is retried only once its blockhash has expired, so a payout can't be sent twice.
- **Nothing is double-allocated.** Funds already promised to undelivered payouts are subtracted before splitting a claim or sizing an airdrop. A claim that lands while the process dies is picked up as "unallocated" and split exactly once.
- **Volume never strands funds.** Each throwaway sub's secret is written to the database *before* it is funded, so a crash can always finish draining it back to the bucket. Buy and sell are one atomic transaction, so a sub is never left holding the coin; a cycle left `sent` by a crash is settled from its signature, and a retired sub's residual coin, quote and SOL are swept home (its ATAs closed to reclaim rent) re-entrantly.
- **LP principal is never airdropped.** Bucket 3's claimed fees are tracked as a `pot` apart from the LP principal; only the pot is ever airdropped, and never more than the wallet's un-promised balance. LP steps (pool create, deploy, re-centre, claim) re-read the position from chain each tick, so a crash mid-rebalance is simply retried; the fee airdrop runs through the same crash-safe payout ledger as everything else.
- **Hold clock.** `heldSince` (any balance) drives the airdrop and restarts on any sell or transfer out.
- **Sells between snapshots are caught.** Every curve/pool trade since the last tick (Jupiter-routed ones included) is scanned for balance drops.
- **Refuses bad data.** A holder snapshot that suddenly loses most known holders (an RPC returning a partial list) is rejected, not used to reset everyone's clock.
- **No retry storms.** Transactions are simulated before sending. A failed money step backs off. A wallet under `MIN_SOL_LAMPORTS` pauses its bucket and the dashboard shows a warning.

## Tests

```bash
npm test          # 40 tests: rules + money flows on real Postgres (PGlite) with crash injection
npm run typecheck
```

## Known limits

- A wallet that transfers out and back **within one tick** (default 30s), without trading through the curve or pool, isn't caught. Sells are always caught.
- The pool price reads the vault balance, which includes fees waiting to be swept. That skews it by well under 1%.
- The bot's average entry is in-memory state plus the database. After a crash mid-buy, the next fill re-averages from the live bag.
