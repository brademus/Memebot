import { TokenRecord } from '../types';

export type TradeStreamMode = 'full' | 'lite';

type TradeWindowToken = Pick<TokenRecord, 'dex' | 'recentTrades' | 'buys5m' | 'sells5m'>;

/**
 * Prune expired direct trade events without destroying the aggregate market window.
 *
 * In full mode, PumpPortal websocket events are canonical and buys/sells are rebuilt
 * from the exact five-minute sequence. In lite mode, Dexscreener aggregates are the
 * only live transaction window, so they must remain untouched after pruning stale
 * direct events.
 */
export function refreshTradeWindow(
  token: TradeWindowToken,
  now = Date.now(),
  streamMode: TradeStreamMode = 'lite',
): void {
  const cutoff = now - 5 * 60_000;
  while (token.recentTrades.length && token.recentTrades[0].at < cutoff) token.recentTrades.shift();

  if (token.dex === 'pumpfun' && streamMode === 'full') {
    token.buys5m = token.recentTrades.filter(trade => trade.buy).length;
    token.sells5m = token.recentTrades.length - token.buys5m;
  }
}
