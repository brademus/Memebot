import { cfg } from '../config';
import { TokenRecord } from '../types';
import { fetchRugReport } from './rugcheck';
import { canSell } from './honeypot';
import { checkDeployer } from './deployer';

// Ordered hard gates. First failure kills the token — cheap checks first.
// Returns null on pass, or the fail reason string.
export async function runGates(t: TokenRecord): Promise<string | null> {
  const g = cfg().gates;

  // liquidity math first — free, uses Dexscreener data already on the record
  if (t.liquidityUsd < g.min_liquidity_usd) return `liq_below_min_${Math.round(t.liquidityUsd)}`;
  if (t.mcapUsd > 0 && t.liquidityUsd / t.mcapUsd < g.liq_to_mcap_ratio_min)
    return `liq_mcap_ratio_${(t.liquidityUsd / t.mcapUsd).toFixed(3)}`;

  // deployer fingerprint — one Helius call
  const dep = await checkDeployer(t.creator);
  if (!dep.pass) return dep.reason;

  // rugcheck — covers authorities, holders, LP, risk score
  const r = await fetchRugReport(t.ca);
  if (!r.ok) return 'rugcheck_unavailable';   // fail-closed: no data = no pass
  if (g.mint_authority_revoked && !r.mintAuthorityRevoked) return 'mint_authority_active';
  if (g.freeze_authority_inactive && !r.freezeAuthorityInactive) return 'freeze_authority_active';
  if (r.topHolderPct > g.hard_reject_top_holder_pct) return `top_holder_${r.topHolderPct.toFixed(0)}pct`;
  if (r.top3HolderPct > g.top3_holder_pct_max) return `top3_${r.top3HolderPct.toFixed(0)}pct`;
  if (g.lp_locked_or_burned && !r.lpLockedOrBurned) return 'lp_not_locked';
  if (r.riskScore > g.rugcheck_score_max) return `rugcheck_score_${r.riskScore}`;

  // honeypot last — Jupiter quote
  if (g.honeypot_sim && !(await canSell(t.ca))) return 'sell_sim_failed';

  return null;
}
