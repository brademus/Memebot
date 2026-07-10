import { cfg } from '../config';
import { TokenRecord } from '../types';
import { fetchRugReport } from './rugcheck';
import { canSell } from './honeypot';
import { checkDeployer } from './deployer';

// Ordered hard gates. First failure kills the token — cheap checks first.
// Returns null on pass, or the fail reason string.
export async function runGates(t: TokenRecord): Promise<string | null> {
  const g = cfg().gates;

  // curve-stage tokens have liquidity locked in the bonding curve by the program
  // itself — LP-lock doesn't apply, and the liquidity floor is lower. IMPORTANT:
  // wallet-surfaced pump.fun tokens gate before enrichment sets t.dex, and gating
  // them as AMM counted the curve PDA as a 100% top holder — the report's largest
  // false-kill class (top_holder_100pct: 26/49 kills went 3x+). The 'pump' mint
  // suffix is pump.fun's vanity standard and identifies them regardless of t.dex.
  const onCurve = t.dex === 'pumpfun' || t.ca.endsWith('pump');

  // liquidity floor. On-curve: compare native SOL (price-independent). Post-grad: USD.
  if (onCurve) {
    if (t.curveSol < g.min_liquidity_sol_curve) return `curve_sol_${t.curveSol.toFixed(1)}`;
  } else {
    if (t.liquidityUsd < g.min_liquidity_usd) return `liq_below_min_${Math.round(t.liquidityUsd)}`;
  }
  if (t.mcapUsd > 0 && t.liquidityUsd / t.mcapUsd < g.liq_to_mcap_ratio_min)
    return `liq_mcap_ratio_${(t.liquidityUsd / t.mcapUsd).toFixed(3)}`;

  // deployer fingerprint — one Helius call
  const dep = await checkDeployer(t.creator);
  if (!dep.pass) return dep.reason;

  // social presence gate (optional): bare launches graduate at 0.11% vs 1.9% with
  // full socials — 17x differential. Off by default (metadata fetch can lag creates).
  if (g.require_social && t.socials.fetched && !t.socials.x && !t.socials.tg && !t.socials.web)
    return 'no_socials';

  // NOTE: the bundle/insider check is deliberately NOT here anymore. Report data
  // showed Helius has indexed ~nothing at gate time (21/9000 coverage), so the two
  // Helius calls it cost per mint bought no information. The 3-8min late re-check
  // in the scoring loop is the real insider gate — it runs once, when the data
  // actually exists, and its verdict is sticky (insiderKilled).

  // rugcheck — covers authorities, holders, LP, risk score.
  // On the bonding curve, pump.fun's program guarantees mint+freeze authority are
  // revoked and there's no pullable LP, so RugCheck having no data yet is EXPECTED,
  // not a red flag. We still check holder concentration if data exists, but tolerate
  // its absence on-curve. Post-graduation we enforce the full rug suite.
  const r = await fetchRugReport(t.ca, onCurve);
  if (!r.ok) {
    if (!onCurve) return 'rugcheck_unavailable';   // graduated token with no data = fail-closed
    // on-curve with no RugCheck data yet: allow through on curve guarantees
  } else {
    if (g.mint_authority_revoked && !r.mintAuthorityRevoked) return 'mint_authority_active';
    if (g.freeze_authority_inactive && !r.freezeAuthorityInactive) return 'freeze_authority_active';
    if (r.topHolderPct > g.hard_reject_top_holder_pct) return `top_holder_${r.topHolderPct.toFixed(0)}pct`;
    if (r.top3HolderPct > g.top3_holder_pct_max) return `top3_${r.top3HolderPct.toFixed(0)}pct`;
    if (!onCurve && g.lp_locked_or_burned && !r.lpLockedOrBurned) return 'lp_not_locked';
    if (r.riskScore > g.rugcheck_score_max) return `rugcheck_score_${r.riskScore}`;
  }

  // honeypot check — only meaningful post-graduation (AMM). On the curve you can
  // always sell back to the curve, so skip the Jupiter sell-sim while on-curve.
  if (!onCurve && g.honeypot_sim && !(await canSell(t.ca))) return 'sell_sim_failed';

  return null;
}
