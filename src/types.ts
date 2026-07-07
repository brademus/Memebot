export interface TokenRecord {
  ca: string;
  symbol: string;
  name: string;
  creator: string | null;
  source: 'pumpfun' | 'dexscreener' | 'wallet';
  firstSeen: number;                 // epoch ms
  // enrichment (Dexscreener)
  priceUsd: number;
  liquidityUsd: number;
  mcapUsd: number;
  vol5m: number;
  buys5m: number;
  sells5m: number;
  priceChange5m: number;
  pairAddress: string | null;
  dex: string | null;                // 'pumpfun' (bonding curve) | 'pumpswap' | 'raydium' | ...
  dexId: string | null;              // 'pumpfun' = still on bonding curve; 'pumpswap'/'raydium' = graduated
  // gate
  gated: boolean | null;             // null = pending
  gateFailReason: string | null;
  // scoring
  score: number;
  peakScore: number;
  firstScorePrice: number | null;
  subs: { freshness: number; liquidity: number; buyPressure: number; holderGrowth: number; smartMoney: number };
  // holder proxy tracking
  uniqueBuyerSamples: number[];      // rolling buys5m samples for growth calc
  bundle: { insiderPct: number; slot0Buyers: number; fundedSnipers: number } | null;
  aiNote: string | null;             // analyst thesis, generated once on TRIGGER
  smartHits: { wallet: string; at: number }[];
  ai: { verdict: string; confidence: number; thesis: string; risks: string } | null;
  // state machine
  state: 'PENDING' | 'WATCHING' | 'HEATING' | 'TRIGGER' | 'EXTENDED' | 'DYING' | 'DEAD';
  stateChangedAt: number;
  lastAlertScore: number;
}

export interface AppConfig {
  gates: {
    mint_authority_revoked: boolean;
    freeze_authority_inactive: boolean;
    top3_holder_pct_max: number;
    hard_reject_top_holder_pct: number;
    honeypot_sim: boolean;
    lp_locked_or_burned: boolean;
    liq_to_mcap_ratio_min: number;
    min_liquidity_usd: number;
    min_liquidity_usd_curve: number;
    curve_min_liquidity_usd: number;
    rugcheck_score_max: number;
  };
  deployer: {
    enabled: boolean;
    min_wallet_age_hours: number;
    max_prior_tokens_24h: number;
    blacklist_auto: boolean;
  };
  bundle: {
    enabled: boolean;
    max_insider_supply_pct: number;
    max_funded_snipers: number;
    count_all_slot0_as_insider: boolean;
    total_supply: number;
  };
  age: { max_token_age_minutes: number; freshness_half_life_minutes: number };
  weights: { freshness: number; liquidity_health: number; buy_pressure: number; holder_growth: number; smart_money: number };
  ai: { enabled: boolean; model: string };
  wallets: {
    enabled: boolean;
    discovery_min_multiple: number;
    wallet_min_winners: number;
    early_buyer_slot_window: number;
    max_tracked_wallets: number;
    hit_recency_hours: number;
  };
  states: {
    heating_score_min: number;
    trigger_score_min: number;
    trigger_buy_ratio_min: number;
    extended_pct: number;
    dying_score_drop: number;
    dying_buy_ratio_max: number;
  };
  alerts: { telegram_on_trigger: boolean; realert_score_jump: number };
  polling: { dexscreener_interval_ms: number; outcome_snapshot_minutes: number[] };
  limits: { max_tracked_tokens: number; dexscreener_batch_size: number };
}
