export interface RawScoreFeatures {
  freshness: number;
  velocity: number;
  buy_pressure: number;
  organic: number;
  social: number;
  smart_money: number;
}

export interface TradeEvent {
  at: number;
  buy: boolean;
  wallet?: string | null;
  solAmount?: number | null;
  tokenAmount?: number | null;
  signature?: string | null;
  slot?: number | null;
  priceUsd?: number | null;
  curveSol?: number | null;
}

export interface MarketSample {
  at: number;
  priceUsd: number;
  liquidityUsd: number;
  vol5m: number;
  buys5m: number;
  sells5m: number;
}

export interface BurstFeatures {
  tradeCount: number;
  buyShare: number;
  uniqueWallets: number;
  uniqueTradeRatio: number;
  walletEntropy: number;
  interarrivalMeanSeconds: number;
  interarrivalCv: number;
  burstiness: number;
  max15sShare: number;
  branchingProxy: number;
  grossSol: number;
  netSol: number;
  retainedFlow: number;
  acceleration: number;
  exhaustion: number;
  quality: number;
  completeness: number;
}

export interface EntityGraphFeatures {
  checkedAt: number;
  buyersAnalyzed: number;
  independentEntities: number;
  independenceRatio: number;
  largestEntityBuyerPct: number;
  largestEntitySupplyPct: number;
  commonFunderBuyerPct: number;
  freshWalletPct: number;
  deployerLinkedPct: number;
  fundingTimeConcentration: number;
  graphRisk: number;
  roots: number;
  complete: boolean;
}

export type RegimeKind = 'cold' | 'normal' | 'hot' | 'mania' | 'adverse' | 'transition';
export interface MarketRegime {
  id: string;
  kind: RegimeKind;
  observedAt: number;
  launches1h: number;
  passRate: number;
  medianChange5m: number;
  aggregateBuyRatio: number;
  medianLiquidityUsd: number;
  routeHealth: number;
  changeProbability: number;
  completeness: number;
}

export interface CompetingRiskHazards {
  target_1_5x: number;
  target_2x: number;
  target_3x: number;
  stop_30pct: number;
  stop_50pct: number;
  rug: number;
  route_loss: number;
  timeout: number;
}

export interface ExecutionEvidence {
  eligible: boolean;
  status: string;
  transactionBuilt: boolean;
  simulationOk: boolean;
  simulationError: string | null;
  executionScore: number;
  routeStabilityBps: number | null;
  requestedPositionSol: number | null;
  selectedRouter: string | null;
  selectedMode: string | null;
  priceImpact: number | null;
  unitsConsumed: number | null;
  probeSizes: Array<{
    sol: number;
    status: string;
    router: string | null;
    mode: string | null;
    priceImpact: number | null;
    outUsd: number | null;
    transactionBuilt: boolean;
    simulationOk: boolean;
  }>;
}

export interface SignalFeatureVector {
  ageMinutes: number;
  curveProgress: number;
  curveSpeed1m: number;
  curveSpeed3m: number;
  capitalEfficiency: number;
  liquidityDepth: number;
  buyPressure: number;
  organicBreadth: number;
  smartMoney: number;
  socialCredibility: number;
  earlyRetention: number;
  buyerIndependence: number;
  graphRisk: number;
  commonFunderPct: number;
  burstQuality: number;
  burstExhaustion: number;
  walletEntropy: number;
  flowRetention: number;
  tradeAcceleration: number;
  runupPenalty: number;
  deployerRisk: number;
  routePrior: number;
  featureCompleteness: number;
  sourceEligible: number;
}

export interface SignalDecision {
  modelVersion: string;
  evaluatedAt: number;
  expiresAt: number;
  allow: boolean;
  preliminaryPass: boolean;
  reasons: string[];
  regime: MarketRegime;
  features: SignalFeatureVector;
  hazards: CompetingRiskHazards;
  targetBeforeStopProbability: number;
  downsideProbability: number;
  expectedValue: number;
  uncertainty: number;
  alphaScore: number;
  cohortPercentile: number;
  cohortSize: number;
  execution: ExecutionEvidence | null;
}

export interface TokenRecord {
  ca: string;
  symbol: string;
  name: string;
  creator: string | null;
  source: 'pumpfun' | 'dexscreener' | 'wallet' | 'momentum' | 'aged';
  firstSeen: number;
  marketCreatedAt: number | null;
  marketSamples: MarketSample[];
  deployerRep: { cls: string; launches: number; winners: number; delta: number } | null;
  gradAt: number | null;
  gradPeak: number;
  gradTrough: number;
  fillMinutes: number | null;
  secondWaveAt: number | null;
  priceUsd: number;
  liquidityUsd: number;
  mcapUsd: number;
  vol5m: number;
  buys5m: number;
  sells5m: number;
  priceChange5m: number;
  pairAddress: string | null;
  dex: string | null;
  curveSol: number;
  curveSamples: { sol: number; at: number }[];
  uniqueBuyers: string[];
  devBuyPct: number;
  totalBuys: number;
  totalSells: number;
  recentTrades: TradeEvent[];
  earlyBuyers: string[];
  earlyExited: string[];
  peakCurveSol: number;
  socials: { x: boolean; tg: boolean; web: boolean; fetched: boolean; tgMembers: number | null };
  description: string | null;
  boostAmount: number;
  tgSamples: { n: number; at: number }[];
  tgGrowthPerMin: number;
  aiConviction: { verdict: string; delta: number; reason: string; at: number } | null;
  playType: 'MOMENTUM' | 'GRADUATION' | 'DIP' | 'RUNNER' | 'REVIVAL' | null;
  laddersFired: number[];
  triggeredAt: number | null;
  triggerPrice: number | null;
  insiderKilled: boolean;
  convictionAt: number | null;
  dexId: string | null;
  gated: boolean | null;
  gateFailReason: string | null;
  score: number;
  peakScore: number;
  firstScorePrice: number | null;
  subs: {
    freshness: number;
    liquidity: number;
    buyPressure: number;
    holderGrowth: number;
    smartMoney: number;
    raw?: RawScoreFeatures;
  };
  uniqueBuyerSamples: number[];
  bundle: ({
    insiderPct: number;
    slot0Buyers: number;
    fundedSnipers: number;
    clusterPct?: number;
  } & Partial<EntityGraphFeatures>) | null;
  entityGraph: EntityGraphFeatures | null;
  modelDecision: SignalDecision | null;
  modelDecisionAt: number | null;
  aiNote: string | null;
  smartHits: { wallet: string; at: number; w: number }[];
  ai: { verdict: string; confidence: number; thesis: string; risks: string } | null;
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
  prefilter: { enabled: boolean; serial_launcher_24h: number; symbol_wave_per_hour: number; min_symbol_len: number; max_symbol_len: number };
  traction_floor: { enabled: boolean; min_trades: number; min_bonded_sol: number; pending_purge_min: number };
  deployer: { enabled: boolean; rep_enabled: boolean; rep_max_delta: number; rep_serial_min: number; min_wallet_age_hours: number; max_prior_tokens_24h: number; blacklist_auto: boolean };
  bundle: { enabled: boolean; cluster_merge_enabled: boolean; cluster_max_buyers: number; max_insider_supply_pct: number; max_funded_snipers: number; count_all_slot0_as_insider: boolean; total_supply: number };
  age: { max_token_age_minutes: number; freshness_half_life_minutes: number };
  weights: { velocity: number; organic: number; social: number; buy_pressure: number; freshness: number; smart_money: number };
  ai: { enabled: boolean; note_model: string; review_model: string; conviction_enabled: boolean; conviction_model: string; conviction_max_delta: number };
  wallets: {
    enabled: boolean; discovery_min_multiple: number; wallet_min_winners: number; early_buyer_slot_window: number;
    max_tracked_wallets: number; hit_recency_hours: number; webhook_enabled: boolean; prune_min_measured_buys: number;
    prune_max_2x_rate: number; elite_min_winners: number; elite_weight: number; quality_validation: boolean;
    quality_min_verdict: string; quality_recheck_days: number; cobuyer_expansion: boolean; cobuyer_min_shared: number;
    idle_deactivate_days: number; winner_mining_enabled: boolean; winner_mining_hours: number; winner_mining_min_pct: number;
    winner_mining_max_mints: number; winner_mining_max_vet: number;
  };
  states: {
    heating_score_min: number; trigger_score_min: number; trigger_min_trades: number; trigger_min_unique_buyers: number;
    early_runner_enabled: boolean; early_runner_min_age: number; early_runner_min_buyers: number; early_runner_min_trades: number;
    trigger_buy_ratio_min: number; extended_pct: number; dying_score_drop: number; dying_buy_ratio_max: number;
  };
  bestbuys: {
    max_shown: number; min_score: number; require_social: boolean; min_unique_buyers: number; min_trades: number;
    min_curve_sol: number; max_dev_pct: number; exit_score: number; min_hold_seconds: number; reentry_cooldown_min: number;
    supersede_margin: number; min_age_minutes: number; min_retention: number; net_inflow_window_min: number;
    smart_lane: boolean; smart_lane_min_wallets: number; pregrad_lane: boolean; pregrad_min_pct: number;
    secondwave_lane: boolean; secondwave_max_age_min: number; secondwave_min_fill_min: number;
    secondwave_min_retrace: number; secondwave_max_retrace: number; max_cluster_pct: number;
    smart_lane_window_min: number; smart_lane_min_score: number; smart_lane_min_age_min: number; smart_lane_exit_score: number;
  };
  alerts: { telegram_on_trigger: boolean; realert_score_jump: number };
  launch_signals: { graduation_curve_sol: number; graduation_bonus_max: number; dead_hours_utc: number[]; dead_hours_penalty: number; tg_shell_max_members: number; tg_real_min_members: number };
  momentum: { enabled: boolean; poll_seconds: number; min_liquidity_usd: number; min_vol24h_usd: number; max_age_hours: number; min_change24h_pct: number; max_change5m_pct: number };
  aged: {
    enabled: boolean; poll_seconds: number; pages_per_duration: number; max_surfaced_per_run: number;
    min_age_hours: number; max_age_hours: number; min_liquidity_usd: number; min_liquidity_mcap_ratio: number;
    min_mcap_usd: number; max_mcap_usd: number; min_vol24h_usd: number; min_vol1h_usd: number;
    min_volume_liquidity_24h: number; min_txns_1h: number; min_buy_ratio_1h: number;
    min_change1h_pct: number; max_change1h_pct: number; min_change24h_pct: number; max_change24h_pct: number;
    max_change5m_pct: number; confirmation_minutes: number; confirmation_samples: number;
    max_price_pullback_pct: number; max_liquidity_drop_pct: number; min_score: number;
    max_convictions: number; conviction_hold_seconds: number;
  };
  learning: { enabled: boolean; window_days: number; min_samples: number; loosen_false_kill_rate: number; min_hours_between_changes: number };
  social: { enabled: boolean; boost_poll_seconds: number; boost_surface_min: number };
  calibration: { enabled: boolean; freeze_age_min: number; window_days: number; min_samples: number; min_winners: number; win_multiple: number; learning_rate: number; min_weight: number; max_weight: number };
  conviction: { enabled: boolean; min_score: number; min_trigger_hold_seconds: number; require_clean_bundle: boolean; min_smart_wallets: number; smart_wallet_window_min: number; require_social: boolean; max_run_pct: number; max_alerts_per_day: number };
  paper: { require_jupiter_quote: boolean; target_multiple: number; stop_multiple: number; max_hold_hours: number; position_sol: number; max_liquidity_pct: number; min_position_usd: number; slippage_bps: number; max_price_impact_pct: number; quote_timeout_ms: number; min_forward_samples_per_lane: number };
  signal_model: {
    enabled: boolean;
    mode: 'shadow' | 'enforce';
    require_transaction_simulation: boolean;
    min_rank_percentile: number;
    min_target_before_stop: number;
    max_downside_probability: number;
    max_graph_risk: number;
    max_burst_exhaustion: number;
    max_uncertainty: number;
    min_expected_value: number;
    min_feature_completeness: number;
    min_execution_score: number;
    min_independent_entity_ratio: number;
    decision_ttl_seconds: number;
    min_cohort_size: number;
    route_stability_max_bps: number;
    regime_change_abstain_threshold: number;
    probe_sizes_sol: number[];
  };
  polling: { dexscreener_interval_ms: number; outcome_snapshot_minutes: number[] };
  limits: { max_tracked_tokens: number; dexscreener_batch_size: number };
}
