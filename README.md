# Triad

A pump.fun coin quoted in **$PUMP** with a **3% creator fee**, run by an engine that splits every fee into three 1% buckets:

| Bucket | What it does |
|---|---|
| **1 · Longest-holder prize** | Paid at every $25K of market cap ($25K, $50K, $75K…). Goes to the wallet that has held the longest (dev excluded). If the same wallet is #1 again at the next milestone, the prize splits between the top 2, then top 3, and so on, until a different wallet is #1. Then it resets to one winner. |
| **2 · Dip/top bot** | Its own wallet (never the dev's). Buys with the **whole** bucket when price is 20% under the 24h high. Sells **half** its bag each time price clears the next rung (+50%, +100%, …) over its average entry. |
| **3 · 1h+ airdrop** | Accrues until the first hour after launch. Then each round buys back the coin with the whole bucket and airdrops it **pro-rata by balance** to every wallet holding for 1h+, **dev included**. |

The dashboard shows the longest-holder ranking, the airdrop-eligible wallets, and every bot buy and sell, plus payout delivery status and wallet gas.

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
npm run keygen               # keys/treasury.json, keys/bot.json, keys/airdrop.json (gitignored)
cp .env.example .env         # fill in RPC_URL, DATABASE_URL, DEV_KEYPAIR, TOKEN_*
```

Fund each wallet:
- **treasury**: ~0.05 SOL. It also pays ATA rent (~0.002 SOL) the first time a prize winner receives $PUMP.
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

**Deploying (Render + Neon).** Run it as a background worker or web service with `npm run engine`. Pass the three keypairs as their JSON byte arrays in env secrets (the loader accepts a path or the array itself). Point `DATABASE_URL` at Neon.

## How it stays correct

- **Payout ledger.** Every transfer is a `payouts` row before it is a transaction. A transaction is signed first and its signature is written to the row, **then** it is broadcast. After a crash or a half-sent batch, rows are settled by checking that signature on chain. A row is retried only once its blockhash has expired, so a payout can't be sent twice.
- **Nothing is double-allocated.** Funds already promised to undelivered payouts are subtracted before splitting a claim, paying a pot, or sizing an airdrop. A claim that lands while the process dies is picked up as "unallocated" and split exactly once.
- **Two hold clocks.** `heldSince` (any balance) drives the airdrop. `qualifiedSince` drives the prize, and only runs while the wallet holds ≥ `PRIZE_MIN_BALANCE`. A dust buy at launch that is topped up later earns no seniority.
- **Sells between snapshots are caught.** Every curve/pool trade since the last tick (Jupiter-routed ones included) is scanned for balance drops.
- **Refuses bad data.** A holder snapshot that suddenly loses most known holders (an RPC returning a partial list) is rejected, not used to reset everyone's clock.
- **No wick payouts.** A milestone fires only after market cap holds it for `MILESTONE_CONFIRM_SAMPLES` ticks in a row.
- **No retry storms.** Transactions are simulated before sending. A failed money step backs off. A wallet under `MIN_SOL_LAMPORTS` pauses its bucket and the dashboard shows a warning.

## Tests

```bash
npm test          # 26 tests: rules + money flows on real Postgres (PGlite) with crash injection
npm run typecheck
```

## Known limits

- A wallet that transfers out and back **within one tick** (default 30s), without trading through the curve or pool, isn't caught. Sells are always caught.
- The pool price reads the vault balance, which includes fees waiting to be swept. That skews it by well under 1%.
- The bot's average entry is in-memory state plus the database. After a crash mid-buy, the next fill re-averages from the live bag.
