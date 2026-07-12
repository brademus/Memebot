import { cfg } from '../config';
import { TokenRecord } from '../types';
import { fetchRugReport } from './rugcheck';
import { canSell } from './honeypot';
import { checkDeployer } from './deployer';

// Ordered hard gates. First failure kills the token — cheap checks first.
// Returns null on pass, or the fail reason string.
export async function runGates(t: TokenRecord): Promise<string | null> {
  const g = cfg().gates;

  // A pump.fun mint keeps its "pump" suffix after graduation. The suffix is only a
  // fallback before enrichment; once a DEX is known, that explicit market state wins.
  // Without this distinction, graduated tokens could skip LP and sell-route checks.
  const onCurve = t.dex === 'pumpfun' || (t.dex == null && t.ca.endsWith('pump'));

  // Liquidity floor. On-curve: compare native SOL. Post-grad: compare executable USD
  // liquidity and pool depth relative to market cap.
  if (onCurve) {
    if (t.curveSol < g.min_liquidity_sol_curve) return `curve_sol_${t.curveSol.toFixed(1)}`;
  } else {
    if (t.liquidityUsd < g.min_liquidity_usd) return `liq_below_min_${Math.round(t.liquidityUsd)}`;
    if (t.mcapUsd > 0 && t.liquidityUsd / t.mcapUsd < g.liq_to_mcap_ratio_min)
      return `liq_mcap_ratio_${(t.liquidityUsd / t.mcapUsd).toFixed(3)}`;
  }

  // Deployer fingerprint — one Helius call.
  const dep = await checkDeployer(t.creator);
  if (!dep.pass) return dep.reason;

  // Social presence gate (optional). Metadata can lag, so only enforce after fetch.
  if (g.require_social && t.socials.fetched && !t.socials.x && !t.socials.tg && !t.socials.web)
    return 'no_socials';

  // Bundle/insider checks intentionally run later when Helius indexing is usable.

  // RugCheck covers authorities, holders, LP, and risk score. Curve-stage absence is
  // tolerated because the program controls the curve; post-grad absence fails closed.
  const r = await fetchRugReport(t.ca, onCurve);
  if (!r.ok) {
    if (!onCurve) return 'rugcheck_unavailable';
  } else {
    if (g.mint_authority_revoked && !r.mintAuthorityRevoked) return 'mint_authority_active';
    if (g.freeze_authority_inactive && !r.freezeAuthorityInactive) return 'freeze_authority_active';
    if (r.topHolderPct > g.hard_reject_top_holder_pct) return `top_holder_${r.topHolderPct.toFixed(0)}pct`;
    if (r.top3HolderPct > g.top3_holder_pct_max) return `top3_${r.top3HolderPct.toFixed(0)}pct`;
    if (!onCurve && g.lp_locked_or_burned && !r.lpLockedOrBurned) return 'lp_not_locked';
    if (r.riskScore > g.rugcheck_score_max) return `rugcheck_score_${r.riskScore}`;
  }

  // This is currently a Jupiter sell-route availability check, not a full transaction
  // simulation. It is still useful post-graduation and meaningless on the curve.
  if (!onCurve && g.honeypot_sim && !(await canSell(t.ca))) return 'sell_route_failed';

  return null;
}
