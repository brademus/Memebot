export type QuotePhase = 'legacy' | 'shadow' | 'pre_key' | 'post_key';

export function quotePhase(status: string | null | undefined, keyPresent: boolean | null | undefined): QuotePhase {
  const value = String(status || 'unknown');
  if (value === 'legacy_mark') return 'legacy';
  if (value === 'shadow_raw_no_execution') return 'shadow';
  if (value === 'jupiter_api_key_missing' || keyPresent === false) return 'pre_key';
  return 'post_key';
}

export function quoteCategory(status: string | null | undefined): string {
  const value = String(status || 'unknown');
  if (value === 'legacy_mark') return 'legacy';
  if (value === 'shadow_raw_no_execution') return 'research_only';
  if (value === 'executable_quote' || value === 'executable_simulated' || value === 'executable_exit_simulated') return 'simulated_executable';
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
