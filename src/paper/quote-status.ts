export type QuotePhase = 'legacy' | 'shadow' | 'pre_key' | 'post_key';

export function quotePhase(status: string | null | undefined, keyPresent: boolean | null | undefined): QuotePhase {
  const value = String(status || 'unknown');
  if (value === 'legacy_mark') return 'legacy';
  if (value === 'shadow_raw_no_execution' || value === 'pregrad_observation_only') return 'shadow';
  if (value.startsWith('curve_')) return 'post_key';   // curve venue needs no Jupiter key
  if (value === 'jupiter_api_key_missing' || keyPresent === false) return 'pre_key';
  return 'post_key';
}

export function quoteCategory(status: string | null | undefined): string {
  const value = String(status || 'unknown');
  if (value === 'legacy_mark') return 'legacy';
  if (value === 'shadow_raw_no_execution' || value === 'pregrad_observation_only') return 'research_only';
  if (value === 'executable_quote' || value === 'executable_simulated' || value === 'executable_exit_simulated') return 'simulated_executable';
  // Curve evidence is unpriced: route/build/sim proof without a measured fill. It is
  // deliberately NOT an executable bucket. Old names retained for rows written 2026-07-28.
  if (value === 'curve_entry_simulated_unpriced' || value === 'curve_entry_built_unpriced'
    || value === 'curve_executable_simulated' || value === 'curve_executable_built') return 'curve_evidence_unpriced';
  if (value === 'curve_sim_blocked_shadow_unfunded') return 'sim_blocked_unfunded';
  if (value === 'curve_shadow_wallet_missing') return 'missing_simulation_wallet';
  if (value === 'curve_rpc_missing') return 'missing_rpc';
  if (value === 'execution_notional_price_missing' || value === 'execution_notional_price_stale') return 'sizing_price_unavailable';
  if (value === 'curve_probe_disabled') return 'research_only';
  if (value === 'curve_probe_rate_limited' || /http_429/.test(value)) return 'rate_limited';
  if (value.startsWith('curve_build_') || value === 'curve_sell_build_failed') return 'curve_build_failed';
  if (value === 'quote_pending') return 'pending';
  if (value === 'jupiter_api_key_missing') return 'missing_key';
  if (value === 'simulation_wallet_missing') return 'missing_simulation_wallet';
  if (value === 'solana_rpc_missing') return 'missing_rpc';
  if (/jupiter_(exit_)?http_(401|403)/.test(value)) return 'unauthorized';
  if (/jupiter_(exit_)?http_429/.test(value)) return 'rate_limited';
  if (value.includes('no_route')) return 'no_route';
  if (value.includes('transaction_not_built')) return 'transaction_not_built';
  if (value.includes('simulation_failed') || value.includes('simulation_rpc')) return 'simulation_failed';
  if (value.includes('route_unstable')) return 'route_unstable';
  if (value.includes('execution_score_too_low')) return 'execution_quality';
  if (value.includes('price_impact_too_high')) return 'price_impact';
  if (value.includes('timeout')) return 'timeout';
  if (value === 'token_not_in_memory') return 'token_missing';
  if (value.includes('invalid') || value === 'invalid_mark') return 'invalid_quote';
  if (value.includes('position_')) return 'position_size';
  if (value.includes('error')) return 'provider_error';
  return 'other';
}
