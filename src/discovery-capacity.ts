const defaults: Record<string, string> = {
  // PumpPortal charges 0.01 SOL per 10,000 trade messages. These defaults cap
  // metered data at 0.03 SOL/day and 0.21 SOL per rolling week equivalent.
  PUMPPORTAL_DAILY_PAID_EVENT_LIMIT: '30000',
  PUMPPORTAL_ROLLING_14D_EVENT_LIMIT: '420000',
  PUMPPORTAL_MAX_ACTIVE_TOKENS: '70',
  PUMPPORTAL_MAX_PENDING_TOKENS: '250',
  PUMPPORTAL_QUIET_SLOT_LEASE_MS: '90000',
  PUMPPORTAL_ACTIVE_IDLE_LEASE_MS: '300000',
  PUMPPORTAL_ROTATION_INTERVAL_MS: '15000',

  // Keep enhanced address-history and cheap JSON-RPC accounting independent.
  // These are internal safety ceilings, not promises that provider-plan credits
  // exist. Helius's own quota and the existing 429 circuit remain authoritative.
  HELIUS_DAILY_CREDITS: '50000',
  HELIUS_DAILY_RPC_CREDITS: '100000',
};

for (const [name, value] of Object.entries(defaults)) {
  if (!String(process.env[name] || '').trim()) process.env[name] = value;
}

export function discoveryCapacityDefaults(): Readonly<Record<string, string>> {
  return Object.freeze({ ...defaults });
}

console.log('[discovery-capacity] quality funnel capacity defaults installed');
