import { env } from '../config';
import { heliusTxsToCreation } from '../helius';

// WALLET QUALITY ANALYZER — judge a wallet on ITS OWN record, not just overlap
// with our winners. This breaks the circular blind spot: discovery can only find
// wallets that were early on coins WE already logged as winners, so a great trader
// who bought a 20x we never saw is invisible. By scoring a candidate's independent
// memecoin P&L from its raw Helius history, we can (a) reject wallets that merely
// got lucky on one of our winners, and (b) admit wallets surfaced by weaker signals
// (co-buying) if their own record is strong.
//
// Method: reconstruct per-token buy/sell flows from enhanced transfers. For each
// SPL mint the wallet touched, net the tokens in vs out and the SOL out vs in.
// A wallet that repeatedly buys early and exits into strength has a signature the
// raw win/loss ledger reveals — without any paid wallet-intelligence API.

const WSOL = 'So11111111111111111111111111111111111111112';

export interface WalletQuality {
  wallet: string;
  tokensTraded: number;       // distinct SPL mints with a real position
  roundTrips: number;         // positions both entered AND (partly) exited — measurable outcomes
  winRate: number;            // fraction of round-trips that netted positive SOL
  medianHoldMin: number | null;
  flags: string[];            // 'early_buyer' | 'fast_flipper' | 'bag_holder' | 'thin_history'
  verdict: 'ELITE' | 'GOOD' | 'MARGINAL' | 'REJECT';
}

interface Leg { mint: string; solDelta: number; tokenDelta: number; at: number }

export async function analyzeWallet(wallet: string, maxPages = 6): Promise<WalletQuality> {
  const txs = await heliusTxsToCreation(wallet, maxPages);
  const q: WalletQuality = {
    wallet, tokensTraded: 0, roundTrips: 0, winRate: 0,
    medianHoldMin: null, flags: [], verdict: 'REJECT',
  };
  if (txs.length < 8) { q.flags.push('thin_history'); return q; }

  // per-mint legs: net SOL and token flow, with timestamps
  const perMint = new Map<string, { solIn: number; solOut: number; tokIn: number; tokOut: number; firstAt: number; lastSellAt: number | null; firstBuyHadSol: boolean }>();
  for (const tx of txs) {
    const ts = (tx.timestamp || 0) * 1000;
    let solMovedForWallet = 0;
    // native SOL delta for the wallet in this tx (approx cost/proceeds)
    for (const nt of tx.nativeTransfers || []) {
      if (nt.fromUserAccount === wallet) solMovedForWallet -= (nt.amount || 0) / 1e9;
      if (nt.toUserAccount === wallet) solMovedForWallet += (nt.amount || 0) / 1e9;
    }
    for (const tt of tx.tokenTransfers || []) {
      if (tt.mint === WSOL || !tt.mint) continue;
      const isBuy = tt.toUserAccount === wallet;
      const isSell = tt.fromUserAccount === wallet;
      if (!isBuy && !isSell) continue;
      const m = perMint.get(tt.mint) || { solIn: 0, solOut: 0, tokIn: 0, tokOut: 0, firstAt: ts, lastSellAt: null, firstBuyHadSol: false };
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
    if (m.tokIn <= 0) continue;                       // never actually held it
    q.tokensTraded++;
    const exitedFraction = m.tokOut / Math.max(m.tokIn, 1);
    if (exitedFraction >= 0.5 && m.firstBuyHadSol) {  // a real, measurable round-trip
      roundTrips++;
      const pnl = m.solIn - m.solOut;                 // SOL proceeds minus SOL cost
      if (pnl > 0) wins++;
      if (m.lastSellAt && m.firstAt) {
        const holdMin = (m.lastSellAt - m.firstAt) / 60000;
        if (holdMin >= 0) holds.push(holdMin);
        if (holdMin < 10) fast++;
      }
    } else if (exitedFraction < 0.1 && m.firstBuyHadSol) {
      bags++;                                          // bought and still holding / rugged
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

  // verdict — needs a REAL sample of measurable outcomes, not one lucky hit
  if (roundTrips >= 8 && q.winRate >= 0.55 && !q.flags.includes('bag_holder')) q.verdict = 'ELITE';
  else if (roundTrips >= 5 && q.winRate >= 0.45) q.verdict = 'GOOD';
  else if (roundTrips >= 3 && q.winRate >= 0.35) q.verdict = 'MARGINAL';
  else q.verdict = 'REJECT';
  return q;
}

export const hasHelius = () => !!env.HELIUS_API_KEY;
