# Dashboard and wallet intelligence

## Dashboard lifecycle

The public dashboard is intentionally organized around one decision lifecycle:

1. **Watchlist** — every live token that passed the bot's gates.
2. **Convictions** — high-quality Best Buys candidates that have not produced a buy alert.
3. **Current Calls** — open `trigger` or `conviction` alerts, marked from their first stored alert entry.
4. **Wins & Losses** — resolved calls, classified by actual stored exit versus entry.
5. **Admin** — authenticated reports and diagnostic actions.

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

After promotion, every detected buy from the wallet is surfaced into the existing token pipeline. The token still has to pass the same safety gates, scoring, model, timing, and conviction logic as every other source.
