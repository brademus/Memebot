export interface TokenRecord {
  ca: string;
  symbol: string;
  name: string;
  creator: string | null;
  source: 'pumpfun' | 'dexscreener' | 'wallet' | 'momentum';
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
  curveSol: number;                  // native SOL in bonding curve (price-independent gating)
  curveSamples: { sol: number; at: number }[];   // rolling curve-SOL history -> demand velocity
  uniqueBuyers: string[];            // distinct buyer wallets seen on curve trades (capped)
  devBuyPct: number;                 // % of supply the deployer bought at creation
  totalBuys: number;                 // cumulative buy count (liquidity-velocity denominator)
  totalSells: number;
  recentTrades: { at: number; buy: boolean }[];   // rolling window -> real 5m counters
  earlyBuyers: string[];             // first N buyer wallets (the snipe cohort)
  earlyExited: string[];             // which of them have since SOLD
  peakCurveSol: number;              // high-water mark of SOL in curve (outflow detection)
  socials: { x: boolean; tg: boolean; web: boolean; fetched: boolean; tgMembers: number | null };  // 17x lift; tgMembers verifies the community is REAL
  description: string | null;        // human-authored token description (narrative signal for AI read)
  boostAmount: number;               // Dexscreener paid-boost total — money-backed attention signal
  tgSamples: { n: number; at: number }[];   // Telegram member-count history -> growth velocity
  tgGrowthPerMin: number;            // TG members gained per minute (pre-pump tell)
  aiConviction: { verdict: string; delta: number; reason: string; at: number } | null;  // AI narrative read, logged + bounded
  playType: 'MOMENTUM' | 'GRADUATION' | 'DIP' | 'RUNNER' | null;
  laddersFired: number[];            // exit-ladder levels already alerted (2, 5, ...)
  triggeredAt: number | null;        // first time this token hit TRIGGER (in-memory; DB has triggered_at)
  triggerPrice: number | null;       // price at first TRIGGER — ladder multiples measure from here
  insiderKilled: boolean;            // late bundle re-check found insider structure — sticky kill
  convictionAt: number | null;       // when the CONVICTION tier confirmed this token (null = never)
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
  smartHits: { wallet: string; at: number; w: number }[];   // w = confluence weight (elite wallets > 1)
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
    min_liquidity_sol_curve: number;
    curve_min_liquidity_usd: number;
    rugcheck_score_max: number;
    require_social: boolean;
  };
  prefilter: {
    enabled: boolean;
    serial_launcher_24h: number;
    symbol_wave_per_hour: number;
    min_symbol_len: number;
    max_symbol_len: number;
  };
  traction_floor: {
    enabled: boolean;
    min_trades: number;
    min_bonded_sol: number;
    pending_purge_min: number;
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
  weights: { velocity: number; organic: number; social: number; buy_pressure: number; freshness: number; smart_money: number };
  ai: { enabled: boolean; note_model: string; review_model: string; conviction_enabled: boolean; conviction_model: string; conviction_max_delta: number };
  wallets: {
    enabled: boolean;
    discovery_min_multiple: number;
    wallet_min_winners: number;
    early_buyer_slot_window: number;
    max_tracked_wallets: number;
    hit_recency_hours: number;
    webhook_enabled: boolean;
    prune_min_measured_buys: number;
    prune_max_2x_rate: number;
    elite_min_winners: number;
    elite_weight: number;
    quality_validation: boolean;
    quality_min_verdict: string;
    quality_recheck_days: number;
    cobuyer_expansion: boolean;
    cobuyer_min_shared: number;
    idle_deactivate_days: number;
  };
  states: {
    heating_score_min: number;
    trigger_score_min: number;
    trigger_min_trades: number;
    trigger_min_unique_buyers: number;
    early_runner_enabled: boolean;
    early_runner_min_age: number;
    early_runner_min_buyers: number;
    early_runner_min_trades: number;
    trigger_buy_ratio_min: number;
    extended_pct: number;
    dying_score_drop: number;
    dying_buy_ratio_max: number;
  };
  bestbuys: {
    max_shown: number;
    min_score: number;
    require_social: boolean;
    min_unique_buyers: number;
    min_trades: number;
    min_curve_sol: number;
    max_dev_pct: number;
    exit_score: number;
    min_hold_seconds: number;
    reentry_cooldown_min: number;
    supersede_margin: number;
    min_age_minutes: number;
    min_retention: number;
    net_inflow_window_min: number;
    smart_lane: boolean;
    smart_lane_min_wallets: number;
    smart_lane_window_min: number;
    smart_lane_min_score: number;
    smart_lane_min_age_min: number;
    smart_lane_exit_score: number;
  };
  alerts: { telegram_on_trigger: boolean; realert_score_jump: number };
  launch_signals: {
    graduation_curve_sol: number;
    graduation_bonus_max: number;
    dead_hours_utc: number[];
    dead_hours_penalty: number;
    tg_shell_max_members: number;
    tg_real_min_members: number;
  };
  momentum: {
    enabled: boolean;
    poll_seconds: number;
    min_liquidity_usd: number;
    min_vol24h_usd: number;
    max_age_hours: number;
    min_change24h_pct: number;
    max_change5m_pct: number;
  };
  learning: {
    enabled: boolean;
    window_days: number;
    min_samples: number;
    loosen_false_kill_rate: number;
  };
  social: {
    enabled: boolean;
    boost_poll_seconds: number;
    boost_surface_min: number;
  };
  calibration: {
    enabled: boolean;
    freeze_age_min: number;
    window_days: number;
    min_samples: number;
    min_winners: number;
    win_multiple: number;
    learning_rate: number;
    min_weight: number;
    max_weight: number;
  };
  conviction: {
    enabled: boolean;
    min_score: number;
    min_trigger_hold_seconds: number;
    require_clean_bundle: boolean;
    min_smart_wallets: number;
    smart_wallet_window_min: number;
    require_social: boolean;
    max_run_pct: number;
    max_alerts_per_day: number;
  };
  polling: { dexscreener_interval_ms: number; outcome_snapshot_minutes: number[] };
  limits: { max_tracked_tokens: number; dexscreener_batch_size: number };
}
