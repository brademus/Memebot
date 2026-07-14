export type QuotePhase = 'legacy' | 'pre_key' | 'post_key';

export function quotePhase(status: string | null | undefined, keyPresent: boolean | null | undefined): QuotePhase {
  const value = String(status || 'unknown');
  if (value === 'legacy_mark') return 'legacy';
  if (value === 'jupiter_api_key_missing' || keyPresent === false) return 'pre_key';
  return 'post_key';
}

export function quoteCategory(status: string | null | undefined): string {
  const value = String(status || 'unknown');
  if (value === 'legacy_mark') return 'legacy';
  if (value === 'executable_quote') return 'executable';
  if (value === 'quote_pending') return 'pending';
  if (value === 'jupiter_api_key_missing') return 'missing_key';
  if (/jupiter_http_(401|403)/.test(value)) return 'unauthorized';
  if (/jupiter_http_429/.test(value)) return 'rate_limited';
  if (value.includes('no_route')) return 'no_route';
  if (value.includes('price_impact_too_high')) return 'price_impact';
  if (value.includes('timeout')) return 'timeout';
  if (value === 'token_not_in_memory') return 'token_missing';
  if (value.includes('invalid') || value === 'invalid_mark') return 'invalid_quote';
  if (value.startsWith('position_below_minimum')) return 'position_too_small';
  if (value.includes('error')) return 'provider_error';
  return 'other';
}
