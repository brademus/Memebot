import { TokenRecord } from '../types';
import { cfg } from '../config';

// Buy-quality rank shown per token. This is a COMPOSITE of what's measurable now,
// with an explicit confidence flag — NOT a prediction that a coin will pump.
// It answers "how well does this fit our filter right now" not "will this 10x".
//
// Grade reflects two things the dashboard shows separately:
//   - score: the weighted signal sum (0-100)
//   - conviction: how much evidence backs it (data completeness + smart money)
//   - timing: whether you'd be early or already-late (from state machine)
export interface Rank {
  grade: string;          // A+ / A / B / C / D
  label: string;          // human summary of the buy setup
  timing: string;         // EARLY / FAIR / LATE / STALE
  cautions: string[];     // concrete risks visible in the data
  confidence: 'low' | 'medium' | 'high';
}

export function rankToken(t: TokenRecord): Rank {
  const cautions: string[] = [];

  // ---- play-type classification (research strategy modes b/c/d) ----
  const bonded = Math.max(0, t.curveSol - 30);
  if (t.dex === 'pumpswap') {
    t.playType = 'GRADUATION';
    // research: most graduates retrace hard; buying the migration candle = late
    const moved0 = t.firstScorePrice && t.priceUsd ? ((t.priceUsd / t.firstScorePrice) - 1) * 100 : 0;
    if (moved0 < -30) t.playType = 'DIP';
  } else if (t.dex === 'pumpfun' && bonded / 55 > 0.85) {
    t.playType = 'GRADUATION';
  } else if (t.dex === 'pumpfun') {
    t.playType = 'MOMENTUM';
  }

  // ---- timing from state + how far it's moved since we first scored it ----
  const moved = t.firstScorePrice && t.priceUsd
    ? ((t.priceUsd / t.firstScorePrice) - 1) * 100 : 0;
  const extensionCeiling = cfg().states.extended_pct;
  let timing: Rank['timing'] = 'FAIR';
  if (t.state === 'EXTENDED' || moved >= extensionCeiling) {
    timing = 'LATE';
    cautions.push(`already +${moved.toFixed(0)}% since first signal`);
  } else if (t.state === 'DYING') {
    timing = 'STALE';
    cautions.push('momentum rolling over');
  } else if (t.state === 'HEATING' || t.state === 'TRIGGER') timing = 'EARLY';

  // ---- concrete data-driven cautions ----
  if (t.socials.tg && t.socials.tgMembers !== null && t.socials.tgMembers < 25)
    cautions.push(`TG is a ${t.socials.tgMembers}-member shell`);
  if (t.bundle && t.bundle.insiderPct > 15) cautions.push(`${t.bundle.insiderPct.toFixed(0)}% insider-held`);
  if (t.bundle && t.bundle.fundedSnipers > 0) cautions.push(`${t.bundle.fundedSnipers} deployer-linked snipers`);
  const buyRatio = t.sells5m > 0 ? t.buys5m / t.sells5m : (t.buys5m || 0);
  if (buyRatio < 1 && t.buys5m + t.sells5m > 5) cautions.push('sells outpacing buys');
  if (t.liquidityUsd > 0 && t.mcapUsd > 0 && t.liquidityUsd / t.mcapUsd < 0.05) cautions.push('thin liquidity vs mcap');
  if (t.socials.fetched && !t.socials.x && !t.socials.tg && !t.socials.web)
    cautions.push('no socials (bare launches graduate 17x less)');
  if (t.devBuyPct > 7) cautions.push(`dev holds ${t.devBuyPct.toFixed(1)}% (dump risk)`);
  if (t.dex === 'pumpswap') cautions.push('post-graduation: most graduates retrace hard');
  const spread = t.totalBuys > 5 ? t.uniqueBuyers.length / t.totalBuys : 1;
  if (t.totalBuys > 10 && spread < 0.3) cautions.push('bot-churn pattern (few wallets, many trades)');
  if (t.earlyBuyers.length >= 5) {
    const exited = t.earlyExited.length;
    if (exited / t.earlyBuyers.length > 0.35)
      cautions.push(`snipers exiting (${exited}/${t.earlyBuyers.length} early buyers sold)`);
  }
  if (t.dex === 'pumpfun' && t.peakCurveSol > 34 && t.curveSol < t.peakCurveSol * 0.9)
    cautions.push('SOL leaving the curve');

  // ---- confidence: how much do we actually KNOW about this token ----
  const smart = new Set(t.smartHits.map(h => h.wallet)).size;
  const ageMin = (Date.now() - t.firstSeen) / 60000;
  let confidence: Rank['confidence'] = 'low';
  if (t.bundle !== null && smart >= 1 && ageMin >= 3) confidence = 'high';
  else if (t.bundle !== null || ageMin >= 5) confidence = 'medium';

  // The prior B floor of 58 silently overrode the configurable Convictions floor.
  // A score of 50 can now be B-grade, but low evidence still caps the grade and the
  // queue continues to require independent confirmation, flow, dev, bundle and timing checks.
  let base: number;
  if (t.score >= 80) base = 4;
  else if (t.score >= 70) base = 3;
  else if (t.score >= 50) base = 2;
  else if (t.score >= 44) base = 1;
  else base = 0;

  if (timing === 'LATE' || timing === 'STALE') base = Math.min(base, 1);
  if (confidence === 'low') base = Math.min(base, 2);
  if (confidence === 'medium') base = Math.min(base, 3);
  if (smart >= 2 && timing === 'EARLY' && confidence === 'high') base = Math.min(4, base + 1);

  const grade = ['D', 'C', 'B', 'A', 'A+'][base];
  const label = buildLabel(grade, timing, smart, cautions.length);
  return { grade, label, timing, cautions, confidence };
}

function buildLabel(grade: string, timing: string, smart: number, nCautions: number): string {
  if (grade === 'A+' || grade === 'A')
    return smart >= 2 ? `strong setup, ${smart} smart wallets in, ${timing.toLowerCase()} entry`
                      : `strong signals, ${timing.toLowerCase()} entry`;
  if (grade === 'B') return `decent setup${nCautions ? `, ${nCautions} caution${nCautions > 1 ? 's' : ''}` : ''}`;
  if (grade === 'C') return timing === 'LATE' ? 'signals ok but entry is late' : 'marginal, watch only';
  return 'weak — below buy threshold';
}
