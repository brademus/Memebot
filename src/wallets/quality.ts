import { env } from '../config';
import { heliusTxsToCreation } from '../helius';

// WALLET QUALITY ANALYZER — judge a wallet on ITS OWN record, not just overlap
// with our winners. This breaks the circular blind spot: discovery can only find
// wallets that were early on coins WE already logged as winners, so a great trader
// who bought a 20x we never saw is invisible. By scoring a candidate's independent
// memecoin P&L from its raw Helius history, we can (a) reject wallets that merely
// got lucky on one of our winners, and (b) admit wallets surfaced by weaker signals
// (co-buying) if their own record is strong.

const WSOL = 'So11111111111111111111111111111111111111112';

export interface WalletQuality {
  wallet: string;
  tokensTraded: number;
  roundTrips: number;
  winRate: number;
  medianHoldMin: number | null;
  flags: string[];
  verdict: 'ELITE' | 'GOOD' | 'MARGINAL' | 'REJECT';
}

export interface WalletDayPerformance {
  wallet: string;
  windowHours: number;
  sampledTransactions: number;
  buys: number;
  sells: number;
  measuredRoundTrips: number;
  wins: number;
  realizedPnlSol: number;
  netSolFlow: number;
  measured: boolean;
}

export async function analyzeWallet(wallet: string, maxPages = 6): Promise<WalletQuality> {
  const txs = await heliusTxsToCreation(wallet, maxPages);
  const q: WalletQuality = {
    wallet, tokensTraded: 0, roundTrips: 0, winRate: 0,
    medianHoldMin: null, flags: [], verdict: 'REJECT',
  };
  if (txs.length < 8) { q.flags.push('thin_history'); return q; }

  const perMint = new Map<string, {
    solIn: number; solOut: number; tokIn: number; tokOut: number;
    firstAt: number; lastSellAt: number | null; firstBuyHadSol: boolean;
  }>();

  for (const tx of txs) {
    const ts = (tx.timestamp || 0) * 1000;
    let solMovedForWallet = 0;
    for (const nt of tx.nativeTransfers || []) {
      if (nt.fromUserAccount === wallet) solMovedForWallet -= (nt.amount || 0) / 1e9;
      if (nt.toUserAccount === wallet) solMovedForWallet += (nt.amount || 0) / 1e9;
    }
    for (const tt of tx.tokenTransfers || []) {
      if (tt.mint === WSOL || !tt.mint) continue;
      const isBuy = tt.toUserAccount === wallet;
      const isSell = tt.fromUserAccount === wallet;
      if (!isBuy && !isSell) continue;
      const m = perMint.get(tt.mint) || {
        solIn: 0, solOut: 0, tokIn: 0, tokOut: 0,
        firstAt: ts, lastSellAt: null, firstBuyHadSol: false,
      };
      const amt = tt.tokenAmount || 0;
      if (isBuy) {
        m.tokIn += amt;
        if (solMovedForWallet < 0) { m.solOut += -solMovedForWallet; m.firstBuyHadSol = true; }
        m.firstAt = Math.min(m.firstAt, ts);
      } else {
        m.tokOut += amt;
        if (solMovedForWallet > 0) m.solIn += solMovedForWallet;
        m.lastSellAt = Math.max(m.lastSellAt || 0, ts);
      }
      perMint.set(tt.mint, m);
    }
  }

  const holds: number[] = [];
  let wins = 0, roundTrips = 0, fast = 0, bags = 0;
  for (const [, m] of perMint) {
    if (m.tokIn <= 0) continue;
    q.tokensTraded++;
    const exitedFraction = m.tokOut / Math.max(m.tokIn, 1);
    if (exitedFraction >= 0.5 && m.firstBuyHadSol) {
      roundTrips++;
      const pnl = m.solIn - m.solOut;
      if (pnl > 0) wins++;
      if (m.lastSellAt && m.firstAt) {
        const holdMin = (m.lastSellAt - m.firstAt) / 60000;
        if (holdMin >= 0) holds.push(holdMin);
        if (holdMin < 10) fast++;
      }
    } else if (exitedFraction < 0.1 && m.firstBuyHadSol) {
      bags++;
    }
  }

  q.roundTrips = roundTrips;
  q.winRate = roundTrips > 0 ? wins / roundTrips : 0;
  if (holds.length) {
    holds.sort((a, b) => a - b);
    q.medianHoldMin = Math.round(holds[Math.floor(holds.length / 2)]);
  }
  if (fast > roundTrips * 0.6 && roundTrips >= 3) q.flags.push('fast_flipper');
  if (bags > q.tokensTraded * 0.5 && q.tokensTraded >= 4) q.flags.push('bag_holder');
  if (q.medianHoldMin !== null && q.medianHoldMin < 60) q.flags.push('early_buyer');

  if (roundTrips >= 8 && q.winRate >= 0.55 && !q.flags.includes('bag_holder')) q.verdict = 'ELITE';
  else if (roundTrips >= 5 && q.winRate >= 0.45) q.verdict = 'GOOD';
  else if (roundTrips >= 3 && q.winRate >= 0.35) q.verdict = 'MARGINAL';
  else q.verdict = 'REJECT';
  return q;
}

// A cached, intentionally conservative 24-hour estimate for the dashboard.
// Only same-window round trips with a measurable SOL cost and proceeds contribute
// to realizedPnlSol. Open positions and sells whose cost basis predates the window
// are excluded instead of pretending they are pure profit.
const dayCache = new Map<string, { at: number; value: WalletDayPerformance }>();
const DAY_CACHE_MS = 3 * 60_000;

export async function analyzeWalletToday(wallet: string, maxPages = 3): Promise<WalletDayPerformance> {
  const cached = dayCache.get(wallet);
  if (cached && Date.now() - cached.at < DAY_CACHE_MS) return cached.value;

  const windowHours = 24;
  const since = Date.now() - windowHours * 3600_000;
  const txs = (await heliusTxsToCreation(wallet, maxPages, 'bg'))
    .filter((tx: any) => (tx.timestamp || 0) * 1000 >= since);

  const perMint = new Map<string, { tokIn: number; tokOut: number; solIn: number; solOut: number }>();
  let buys = 0, sells = 0, netSolFlow = 0;

  for (const tx of txs) {
    let solDelta = 0;
    for (const nt of tx.nativeTransfers || []) {
      if (nt.fromUserAccount === wallet) solDelta -= (nt.amount || 0) / 1e9;
      if (nt.toUserAccount === wallet) solDelta += (nt.amount || 0) / 1e9;
    }

    const touched = new Map<string, { inAmt: number; outAmt: number }>();
    for (const tt of tx.tokenTransfers || []) {
      if (!tt.mint || tt.mint === WSOL) continue;
      const isBuy = tt.toUserAccount === wallet;
      const isSell = tt.fromUserAccount === wallet;
      if (!isBuy && !isSell) continue;
      const leg = touched.get(tt.mint) || { inAmt: 0, outAmt: 0 };
      if (isBuy) leg.inAmt += Number(tt.tokenAmount || 0);
      if (isSell) leg.outAmt += Number(tt.tokenAmount || 0);
      touched.set(tt.mint, leg);
    }
    if (!touched.size) continue;
    netSolFlow += solDelta;

    for (const [mint, leg] of touched) {
      const m = perMint.get(mint) || { tokIn: 0, tokOut: 0, solIn: 0, solOut: 0 };
      if (leg.inAmt > 0) {
        buys++;
        m.tokIn += leg.inAmt;
        if (solDelta < 0) m.solOut += -solDelta;
      }
      if (leg.outAmt > 0) {
        sells++;
        m.tokOut += leg.outAmt;
        if (solDelta > 0) m.solIn += solDelta;
      }
      perMint.set(mint, m);
    }
  }

  let measuredRoundTrips = 0, wins = 0, realizedPnlSol = 0;
  for (const [, m] of perMint) {
    const exited = m.tokIn > 0 ? m.tokOut / m.tokIn : 0;
    if (m.solOut <= 0 || m.solIn <= 0 || exited < 0.5) continue;
    measuredRoundTrips++;
    const pnl = m.solIn - m.solOut;
    realizedPnlSol += pnl;
    if (pnl > 0) wins++;
  }

  const value: WalletDayPerformance = {
    wallet,
    windowHours,
    sampledTransactions: txs.length,
    buys,
    sells,
    measuredRoundTrips,
    wins,
    realizedPnlSol: +realizedPnlSol.toFixed(4),
    netSolFlow: +netSolFlow.toFixed(4),
    measured: measuredRoundTrips > 0,
  };
  dayCache.set(wallet, { at: Date.now(), value });
  return value;
}

export const hasHelius = () => !!env.HELIUS_API_KEY;
