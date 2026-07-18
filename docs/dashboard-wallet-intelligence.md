# Dashboard and wallet intelligence

## Dashboard lifecycle

The dashboard and worker use one enforced decision lifecycle:

1. **Watchlist** — every live token that passed the bot's safety gates.
2. **Convictions** — candidates the backend has selected for a future buy alert, but whose entry timing is not ready.
3. **Current Calls** — open buy alerts marked from the exact stored alert price.
4. **Wins & Losses** — resolved calls classified by stored exit versus entry.
5. **Admin** — authenticated reports and diagnostic actions.

A Watchlist token cannot emit a buy alert directly. It must first be admitted to a conviction lane. Organic convictions are observed for 120 seconds, smart-wallet convictions for up to 60 seconds, and pre-graduation or second-wave convictions for up to 90 seconds. After that hold, the entry gate still requires:

- the lane's score floor;
- at least a 1.3 buy-to-sell ratio;
- sufficient trade and buyer evidence;
- buyer persistence and no material curve outflow;
- a five-minute move no hotter than the configured 45% chase ceiling;
- an entry below the 75% extension ceiling; and
- continued source and model eligibility.

Only then does the worker emit one **BUY ALERT**, record the alert price, and move the token into Current Calls. There is no second post-buy conviction alert.

Call performance uses a normalized hypothetical **$100 per call**. This is not an executed portfolio claim. Calls closed because price tracking was lost are shown as unresolved and excluded from aggregate P&L and win rate.

## Pump.fun wallet lifecycle

Wallet discovery has two lanes:

- **Winner-first:** early buyers of large movers are nominated and independently vetted.
- **Activity-first:** wallets with at least 18 captured Pump.fun trades, 10 buys, and 5 distinct tokens in six hours are nominated.

Activity candidates are followed as observation-only wallets. They cannot create smart-money hits or inject unseen tokens into the bot's funnel. Promotion requires:

- at least 5 measured round trips;
- at least 0.15 SOL realized profit;
- at least 3% realized ROI; and
- a `GOOD` or `ELITE` quality verdict.

After promotion, every detected buy from the wallet is surfaced into the existing token pipeline and tagged as wallet-sourced. The token still has to pass the same safety gates, conviction selection, and entry-timing logic as every other source.

## Runtime requirements

- `DATABASE_URL` persists trade events, wallet candidates, paper calls, and outcomes.
- `PUMPPORTAL_API_KEY` enables the full Pump.fun token-trade stream used by activity discovery.
- `HELIUS_API_KEY` supplies wallet history and active/candidate wallet webhooks.
- `ADMIN_KEY` protects weekly reports and diagnostic controls.

When PumpPortal is in lite mode, new-token and migration monitoring still work, but activity-first wallet discovery will not have the full trade-event feed it needs.
