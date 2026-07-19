# MEMEWATCH

Solana memecoin watchlist bot. Ingests every pump.fun launch, kills rugs at the gate, scores survivors, tracks state transitions (HEATING → TRIGGER → EXTENDED/DYING), and feeds a live ranked dashboard. Telegram backup alerts on TRIGGER.

**Alert-only. No execution. You make the call.**

## Deploy to Railway (10 minutes)

1. Push this folder to a GitHub repo
2. Railway → New Project → Deploy from GitHub repo
3. Add plugin: **PostgreSQL** (Railway auto-injects `DATABASE_URL`)
4. Service → Variables → add:
   - `TELEGRAM_BOT_TOKEN` — from @BotFather
   - `TELEGRAM_CHAT_ID` — from @userinfobot
   - `HELIUS_API_KEY` — optional in Phase 1; enables deployer fingerprint gate
5. Service → Settings → Networking → Generate Domain
6. Open the domain → that's your dashboard. Hit SOUND ON.

Runs without Postgres (memory-only) but outcomes won't log — and the outcomes DB is the whole Phase 4 edge. Add the plugin.

## Local dev

```
npm install
cp .env.example .env   # fill in what you have
npm run dev
# dashboard at localhost:3000
```

## Tuning

Everything lives in `config.yaml` — thresholds hot-reload every 60s, no redeploy needed. Start defaults are conservative. After 2–3 days of watching what it kills vs passes, tune:

- `min_liquidity_usd` / `liq_to_mcap_ratio_min` — your exit-safety floor
- `states.trigger_score_min` — raise if too noisy, lower if too quiet
- `weights` — hand-set for now; replace with fitted weights once `outcomes` table has ~300 rows

## What's wired

| Source | Used for | Status |
|---|---|---|
| PumpPortal WS (free) | pump.fun new mints | ✅ tested live |
| Dexscreener API (free) | price/liq/mcap/txns enrichment | ✅ tested live |
| RugCheck API (free) | authorities, holders, LP, risk score | ✅ tested live |
| Jupiter lite-api (free) | sell-simulation (honeypot gate) | ✅ tested live |
| Helius RPC | deployer fingerprint | optional, degrades gracefully |
| Telegram | TRIGGER backup alerts | needs your token |

## Architecture

```
pumpfun WS ──┐
             ├─► in-memory store ─► gates ─► score ─► state machine ─► SSE dashboard
dexscreener ─┘        │                                    │
  (10s poll)          ▼                                    ▼
                  Postgres (outcomes @ 1h/4h/24h)      Telegram (TRIGGER)
```

Gate order (cheap → expensive): liquidity math → deployer fingerprint → RugCheck (mint/freeze auth, top-3 holders, LP lock, risk score) → Jupiter sell-sim. Fail-closed: no RugCheck data = no pass. Deployers of tokens that round-trip to zero get auto-blacklisted after 2 rugs.

## Phase 3 next (smart money)

`smart_wallets` table already exists in the schema. Plan: seed from GMGN/Nansen → manually re-validate → Helius wallet webhooks → `smart_money` weight into `config.yaml` (rebalance to 30) → anti-trap checks (CA verification vs dust poisoning, cluster detection, latency flag).

## Phase 4 (the real edge)

Once `outcomes` has data:
- `SELECT ca FROM outcomes WHERE multiple_from_first >= 10` → walk back first buyers via Helius → wallets appearing on multiple winners = your proprietary list
- Fit weights via logistic regression on gated-token outcomes

## v2 additions

**Curve-aware gates (bug fix):** bonding-curve tokens have no LP token — liquidity is locked in pump.fun's curve contract. The LP-lock and liq:mcap gates now only apply post-graduation (PumpSwap/Raydium). Curve tokens use a lower liquidity floor (`min_liquidity_usd_curve`). This is why the feed was empty before — every curve token was dying on `lp_not_locked`.

**Smart-money wallet tracker** (`src/ingest/wallets.ts`): add wallets via the API, tracker polls their swaps via Helius. A tracked wallet buying a token adds a `smart_money` signal (weight 20). Only `type:SWAP` counts — dust transfers are ignored (anti-poisoning). Wallets a tracked wallet buys that we haven't seen become discovery sources.

Admin-key authentication is intentionally disabled during the current private-use phase. Dashboard operations and wallet-admin API requests do not require an authorization header:

```
curl -X POST https://YOUR-APP.up.railway.app/api/wallets \
  -H "content-type: application/json" \
  -d '{"wallet":"WALLET_ADDRESS","type":"sniper"}'
```

The routes are still rate-limited. Re-enable authentication before making the deployment available to untrusted users.

**AI analyst** (`src/ai/analyst.ts`): on TRIGGER, Claude Haiku writes a 2-3 sentence thesis — strongest reason it passed, biggest risk, entry-quality GOOD/MIXED/LATE. Shows on the dashboard under the token row and in the Telegram alert. Needs `ANTHROPIC_API_KEY`. Costs ~$0.001 per note.

**Full history tab:** the dashboard's FULL HISTORY tab pages through every token ever logged in Postgres, with each one's 4h outcome multiple. Winners (≥2x) highlighted. This is the raw record behind the autotuner.

**Autotune** (`src/tuning/autotune.ts`): nightly, joins passed tokens with 4h outcomes, measures how well each sub-score separated winners (≥2x) from losers, and suggests new weights at `/api/tuning`. **Suggest-only** — you apply changes to `config.yaml` yourself. Needs 50+ outcomes and 10+ winners before it says anything; until then it reports how many more it needs.

## New env vars
- `ANTHROPIC_API_KEY` — AI analyst notes (optional)
