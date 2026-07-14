import { cfg } from '../config';
import { pool } from '../db';
import { MODEL_VERSION } from '../model/version';

interface Tunable {
  path: string;
  prefix: string;
  step: number;
  bounds: [number, number];
  loosenDir: 1 | -1;
  label: string;
}

const TUNABLES: Tunable[] = [
  { path: 'gates.min_liquidity_sol_curve', prefix: 'curve_sol', step: 1, bounds: [4, 15], loosenDir: -1, label: 'curve SOL floor' },
  { path: 'gates.min_liquidity_usd', prefix: 'liq_below_min', step: 1000, bounds: [6000, 20000], loosenDir: -1, label: 'AMM liquidity floor' },
  { path: 'gates.rugcheck_score_max', prefix: 'rugcheck_score', step: 500, bounds: [2000, 9000], loosenDir: 1, label: 'RugCheck risk ceiling' },
  { path: 'gates.top3_holder_pct_max', prefix: 'top3', step: 2, bounds: [25, 45], loosenDir: 1, label: 'top-3 holder ceiling' },
  { path: 'gates.hard_reject_top_holder_pct', prefix: 'top_holder', step: 2, bounds: [40, 60], loosenDir: 1, label: 'single-holder hard cap' },
  { path: 'deployer.min_wallet_age_hours', prefix: 'deployer_fresh', step: 0.5, bounds: [0, 6], loosenDir: -1, label: 'deployer wallet age' },
  { path: 'deployer.max_prior_tokens_24h', prefix: 'deployer_hyper', step: 1, bounds: [2, 8], loosenDir: 1, label: 'deployer launch cap' },
  { path: 'prefilter.serial_launcher_24h', prefix: 'prefilter_serial', step: 1, bounds: [2, 10], loosenDir: 1, label: 'serial-launcher cap' },
  { path: 'prefilter.symbol_wave_per_hour', prefix: 'prefilter_wave', step: 1, bounds: [2, 10], loosenDir: 1, label: 'symbol-wave cap' },
];

interface Suggestion { at: string; path: string; from: number; to: number; evidence: string }
const diag = {
  lastRun: null as string | null,
  lastError: null as string | null,
  mode: 'suggest_only',
  applied: false,
  suggestions: [] as Suggestion[],
};

export const learningDiag = () => ({ ...diag, suggestions: diag.suggestions.slice(0, 12) });

export function startFilterLearner() {
  if (!pool) return;
  setTimeout(() => run().catch(() => {}), 3 * 60_000);
  setInterval(() => run().catch(() => {}), 12 * 3600_000);
}

function getByPath(path: string): number {
  let node: any = cfg();
  for (const key of path.split('.')) node = node?.[key];
  return Number(node);
}

export async function run() {
  if (!pool || !cfg().learning?.enabled) return;
  try {
    diag.lastRun = new Date().toISOString();
    diag.lastError = null;
    const suggestions: Suggestion[] = [];

    const kills = await pool.query(
      `SELECT t.gate_fail_reason AS reason, MAX(o.multiple_from_first) AS best
         FROM tokens t JOIN outcomes o ON o.ca=t.ca
        WHERE t.gate_result='failed'
          AND t.first_seen > now()-($1 || ' days')::interval
          AND o.multiple_from_first IS NOT NULL
        GROUP BY t.ca, t.gate_fail_reason`,
      [String(cfg().learning.window_days)],
    );

    for (const tunable of TUNABLES) {
      const rows = kills.rows.filter((row: any) => String(row.reason || '').startsWith(tunable.prefix));
      if (rows.length < cfg().learning.min_samples) continue;
      const falseKills = rows.filter((row: any) => Number(row.best) >= 3).length;
      const rate = falseKills / rows.length;
      if (rate <= cfg().learning.loosen_false_kill_rate) continue;
      const current = getByPath(tunable.path);
      const next = clamp(current + tunable.loosenDir * tunable.step, tunable.bounds);
      if (next === current) continue;
      suggestions.push({
        at: new Date().toISOString(), path: tunable.path, from: current, to: next,
        evidence: `suggest loosen ${tunable.label}: ${falseKills}/${rows.length} kills later reached 3x (${(rate * 100).toFixed(1)}%); not automatically applied`,
      });
    }

    const ceiling = cfg().bundle.max_insider_supply_pct;
    const band = await pool.query(
      `SELECT COUNT(*)::int AS n,
              COUNT(*) FILTER (WHERE o.multiple_from_first >= 2)::int AS wins,
              AVG(o.multiple_from_first) AS avg
         FROM tokens t JOIN outcomes o ON o.ca=t.ca AND o.snapshot_minutes=240
        WHERE t.gate_result='passed' AND t.insider_pct IS NOT NULL
          AND t.insider_pct > $1 AND t.insider_pct <= $2
          AND t.first_seen > now()-($3 || ' days')::interval`,
      [ceiling - 10, ceiling, String(cfg().learning.window_days)],
    );
    const marginal = band.rows[0];
    if (marginal && marginal.n >= cfg().learning.min_samples && Number(marginal.wins) === 0 && Number(marginal.avg) < 0.8) {
      suggestions.push({
        at: new Date().toISOString(), path: 'bundle.max_insider_supply_pct', from: ceiling,
        to: clamp(ceiling - 3, [10, 35]),
        evidence: `suggest tighten insider ceiling: ${marginal.n} tokens in the marginal band produced 0 winners, avg ${Number(marginal.avg).toFixed(2)}x; not automatically applied`,
      });
    }

    diag.suggestions = suggestions;
    for (const suggestion of suggestions) {
      await pool.query(
        `INSERT INTO model_suggestions (model_version, kind, payload, evidence, applied)
         VALUES ($1,'filter_threshold',$2,$3,false)`,
        [MODEL_VERSION, JSON.stringify(suggestion), suggestion.evidence],
      );
    }
    console.log(`[learning] ${suggestions.length} filter suggestions recorded; live config unchanged`);
  } catch (error) {
    diag.lastError = (error as Error).message;
    console.error('[learning]', diag.lastError);
  }
}

const clamp = (value: number, [minimum, maximum]: [number, number]) => Math.min(maximum, Math.max(minimum, value));
