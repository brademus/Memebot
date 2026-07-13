import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { AppConfig } from './types';

const CONFIG_PATH = path.join(process.cwd(), 'config.yaml');

// LEARNED OVERRIDES — the filter learner persists threshold adjustments to Postgres
// so they survive redeploys. YAML remains the human-readable baseline.
let overrides: Record<string, number> = {};
let weightOverrides: Record<string, number> = {};
let directions: Record<string, number> = {};

const REQUIRED_BOOLEANS = [
  'gates.mint_authority_revoked', 'gates.freeze_authority_inactive', 'gates.honeypot_sim',
  'gates.lp_locked_or_burned', 'gates.require_social', 'prefilter.enabled',
  'traction_floor.enabled', 'deployer.enabled', 'deployer.rep_enabled',
  'deployer.blacklist_auto', 'bundle.enabled', 'bundle.cluster_merge_enabled',
  'bundle.count_all_slot0_as_insider', 'ai.enabled', 'ai.conviction_enabled',
  'wallets.enabled', 'wallets.webhook_enabled', 'wallets.quality_validation',
  'wallets.cobuyer_expansion', 'wallets.winner_mining_enabled',
  'states.early_runner_enabled', 'bestbuys.require_social', 'bestbuys.smart_lane',
  'bestbuys.pregrad_lane', 'bestbuys.secondwave_lane', 'alerts.telegram_on_trigger',
  'learning.enabled', 'momentum.enabled', 'calibration.enabled', 'social.enabled',
  'conviction.enabled', 'conviction.require_clean_bundle', 'conviction.require_social',
] as const;

const REQUIRED_NUMBERS = [
  'gates.top3_holder_pct_max', 'gates.hard_reject_top_holder_pct',
  'gates.liq_to_mcap_ratio_min', 'gates.min_liquidity_usd',
  'gates.min_liquidity_sol_curve', 'gates.rugcheck_score_max',
  'prefilter.serial_launcher_24h', 'prefilter.symbol_wave_per_hour',
  'prefilter.min_symbol_len', 'prefilter.max_symbol_len',
  'traction_floor.min_trades', 'traction_floor.min_bonded_sol',
  'traction_floor.pending_purge_min', 'deployer.rep_max_delta',
  'deployer.rep_serial_min', 'deployer.min_wallet_age_hours',
  'deployer.max_prior_tokens_24h', 'bundle.cluster_max_buyers',
  'bundle.max_insider_supply_pct', 'bundle.max_funded_snipers', 'bundle.total_supply',
  'age.max_token_age_minutes', 'age.freshness_half_life_minutes',
  'weights.velocity', 'weights.organic', 'weights.social', 'weights.buy_pressure',
  'weights.freshness', 'weights.smart_money', 'ai.conviction_max_delta',
  'wallets.discovery_min_multiple', 'wallets.wallet_min_winners',
  'wallets.early_buyer_slot_window', 'wallets.max_tracked_wallets',
  'wallets.hit_recency_hours', 'wallets.prune_min_measured_buys',
  'wallets.prune_max_2x_rate', 'wallets.elite_min_winners', 'wallets.elite_weight',
  'wallets.quality_recheck_days', 'wallets.cobuyer_min_shared',
  'wallets.idle_deactivate_days', 'wallets.winner_mining_hours',
  'wallets.winner_mining_min_pct', 'wallets.winner_mining_max_mints',
  'wallets.winner_mining_max_vet', 'states.heating_score_min',
  'states.trigger_score_min', 'states.trigger_min_trades',
  'states.trigger_min_unique_buyers', 'states.trigger_buy_ratio_min',
  'states.early_runner_min_age', 'states.early_runner_min_buyers',
  'states.early_runner_min_trades', 'states.extended_pct',
  'states.dying_score_drop', 'states.dying_buy_ratio_max', 'bestbuys.max_shown',
  'bestbuys.min_score', 'bestbuys.min_unique_buyers', 'bestbuys.min_trades',
  'bestbuys.min_curve_sol', 'bestbuys.max_dev_pct', 'bestbuys.exit_score',
  'bestbuys.min_hold_seconds', 'bestbuys.reentry_cooldown_min',
  'bestbuys.supersede_margin', 'bestbuys.min_age_minutes',
  'bestbuys.min_retention', 'bestbuys.net_inflow_window_min',
  'bestbuys.smart_lane_min_wallets', 'bestbuys.smart_lane_window_min',
  'bestbuys.smart_lane_min_score', 'bestbuys.smart_lane_min_age_min',
  'bestbuys.smart_lane_exit_score', 'bestbuys.pregrad_min_pct',
  'bestbuys.secondwave_max_age_min', 'bestbuys.secondwave_min_fill_min',
  'bestbuys.secondwave_min_retrace', 'bestbuys.secondwave_max_retrace',
  'bestbuys.max_cluster_pct', 'alerts.realert_score_jump',
  'polling.dexscreener_interval_ms', 'limits.max_tracked_tokens',
  'limits.dexscreener_batch_size', 'conviction.min_score',
  'conviction.min_trigger_hold_seconds', 'conviction.min_smart_wallets',
  'conviction.smart_wallet_window_min', 'conviction.max_run_pct',
  'conviction.max_alerts_per_day', 'learning.window_days', 'learning.min_samples',
  'learning.min_hours_between_changes', 'learning.loosen_false_kill_rate',
  'momentum.poll_seconds', 'momentum.min_liquidity_usd', 'momentum.min_vol24h_usd',
  'momentum.max_age_hours', 'momentum.min_change24h_pct', 'momentum.max_change5m_pct',
  'launch_signals.graduation_curve_sol', 'launch_signals.graduation_bonus_max',
  'launch_signals.dead_hours_penalty', 'launch_signals.tg_shell_max_members',
  'launch_signals.tg_real_min_members', 'calibration.freeze_age_min',
  'calibration.window_days', 'calibration.min_samples', 'calibration.min_winners',
  'calibration.win_multiple', 'calibration.learning_rate', 'calibration.min_weight',
  'calibration.max_weight', 'social.boost_poll_seconds', 'social.boost_surface_min',
] as const;

const REQUIRED_STRINGS = [
  'ai.note_model', 'ai.review_model', 'ai.conviction_model', 'wallets.quality_min_verdict',
] as const;

function valueAt(root: unknown, dottedPath: string): unknown {
  return dottedPath.split('.').reduce<unknown>((node, key) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return undefined;
    return (node as Record<string, unknown>)[key];
  }, root);
}

function validateConfig(raw: unknown): AppConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('config root must be a YAML object');
  }

  const errors: string[] = [];
  for (const path of REQUIRED_BOOLEANS) {
    if (typeof valueAt(raw, path) !== 'boolean') errors.push(`${path} must be boolean`);
  }
  for (const path of REQUIRED_NUMBERS) {
    const value = valueAt(raw, path);
    if (typeof value !== 'number' || !Number.isFinite(value)) errors.push(`${path} must be a finite number`);
  }
  for (const path of REQUIRED_STRINGS) {
    const value = valueAt(raw, path);
    if (typeof value !== 'string' || !value.trim()) errors.push(`${path} must be a non-empty string`);
  }

  const hours = valueAt(raw, 'launch_signals.dead_hours_utc');
  if (!Array.isArray(hours) || hours.some(value => !Number.isInteger(value) || value < 0 || value > 23)) {
    errors.push('launch_signals.dead_hours_utc must contain UTC hours 0-23');
  }

  const snapshots = valueAt(raw, 'polling.outcome_snapshot_minutes');
  if (!Array.isArray(snapshots) || snapshots.length === 0 ||
      snapshots.some(value => !Number.isInteger(value) || value <= 0) ||
      snapshots.some((value, index) => index > 0 && value <= snapshots[index - 1])) {
    errors.push('polling.outcome_snapshot_minutes must be positive, strictly increasing integers');
  }

  const weightValues = ['velocity', 'organic', 'social', 'buy_pressure', 'freshness', 'smart_money']
    .map(key => Number(valueAt(raw, `weights.${key}`)));
  if (weightValues.every(Number.isFinite)) {
    const total = weightValues.reduce((sum, value) => sum + value, 0);
    if (Math.abs(total - 100) > 0.001) errors.push(`weights must sum to 100; received ${total}`);
  }

  const pregrad = Number(valueAt(raw, 'bestbuys.pregrad_min_pct'));
  const minRetrace = Number(valueAt(raw, 'bestbuys.secondwave_min_retrace'));
  const floor = Number(valueAt(raw, 'bestbuys.secondwave_max_retrace'));
  if (Number.isFinite(pregrad) && (pregrad <= 0 || pregrad >= 1)) errors.push('bestbuys.pregrad_min_pct must be between 0 and 1');
  if (Number.isFinite(minRetrace) && (minRetrace <= 0 || minRetrace >= 1)) errors.push('bestbuys.secondwave_min_retrace must be between 0 and 1');
  if (Number.isFinite(floor) && (floor <= 0 || floor >= 1)) errors.push('bestbuys.secondwave_max_retrace must be between 0 and 1');
  if (Number.isFinite(minRetrace) && Number.isFinite(floor) && floor > 1 - minRetrace) {
    errors.push('bestbuys second-wave retrace range is impossible');
  }

  if (errors.length) throw new Error(`invalid config:\n- ${errors.join('\n- ')}`);
  return raw as AppConfig;
}

export function setConfigOverrides(next: Record<string, number>) {
  overrides = { ...overrides, ...next };
  try { current = withOverrides(load()); }
  catch (error) { console.error('[config] rejected learned overrides:', (error as Error).message); }
}

export function setDirections(next: Record<string, number>) { directions = next; }
export function getDirection(key: string): number { return directions[key] ?? 1; }

export function setWeightOverrides(next: Record<string, number>) {
  weightOverrides = next;
  try { current = withOverrides(load()); }
  catch (error) { console.error('[config] rejected learned weights:', (error as Error).message); }
}

function withOverrides(base: AppConfig): AppConfig {
  for (const [dottedPath, value] of Object.entries(overrides)) {
    const keys = dottedPath.split('.');
    let node: any = base;
    for (let index = 0; index < keys.length - 1 && node; index++) node = node[keys[index]];
    if (node && typeof node[keys[keys.length - 1]] === 'number') node[keys[keys.length - 1]] = value;
  }
  const weights: any = (base as any).weights;
  if (weights) {
    for (const [key, value] of Object.entries(weightOverrides)) {
      if (typeof weights[key] === 'number') weights[key] = value;
    }
  }
  return validateConfig(base);
}

function load(): AppConfig {
  return validateConfig(yaml.load(fs.readFileSync(CONFIG_PATH, 'utf8')));
}

let current: AppConfig = withOverrides(load());
console.log('[config] validated runtime configuration');

// A hot-reload timer should not keep tests or one-off diagnostic scripts alive.
// The production worker already has sockets/server timers, so unref changes no runtime behavior.
const reloadTimer = setInterval(() => {
  try {
    current = withOverrides(load());
  } catch (error) {
    console.error('[config] reload rejected, keeping previous:', (error as Error).message);
  }
}, 60_000);
reloadTimer.unref();

export const cfg = () => current;
export const env = {
  DATABASE_URL: process.env.DATABASE_URL || '',
  HELIUS_API_KEY: process.env.HELIUS_API_KEY || '',
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || '',
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '',
  GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',
  PUMPPORTAL_API_KEY: process.env.PUMPPORTAL_API_KEY || '',
  JUPITER_API_KEY: process.env.JUPITER_API_KEY || '',
  ADMIN_KEY: process.env.ADMIN_KEY || '',
  PORT: parseInt(process.env.PORT || '3000', 10),
};
