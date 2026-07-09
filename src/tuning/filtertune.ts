import { cfg, setConfigOverrides } from '../config';
import { pool } from '../db';

// FILTER LEARNER — the closed loop that makes filtering improve on its own.
//
// Every kill is attributed to the rule that made it (gate_fail_reason prefix) and
// every killed token still gets outcome snapshots from its kill-time reference
// price. That means each filter's mistake rate is MEASURABLE: kills whose token
// went on to 3x+ are false kills — winners we rejected.
//
// The loop, every 12h over a rolling window:
//   LOOSEN — a rule with enough measured kills and a false-kill rate above the
//   configured tolerance moves ONE bounded step toward admitting more. This is
//   the unambiguous direction: the evidence is winners we provably turned away.
//   (This converges, not drifts: once a rule stops killing winners it stops
//   moving, and hard bounds in this file — not in user config — cap every knob.)
//
//   TIGHTEN — only where pass-side evidence exists. insider_pct is stored for
//   every passed token, so the marginal band just under the insider ceiling is
//   measurable: if that band has enough samples and produced zero 2x winners
//   with a losing average, the ceiling comes down a step.
//
// Every change is persisted to Postgres (survives redeploys — Railway resets
// config.yaml on every deploy), applied live via the config overlay, and written
// to an audit log the dashboard and weekly report expose. Kill switch:
// learning.enabled. Nothing here ever touches safety-critical booleans
// (honeypot sim, mint/freeze authority, LP lock) — those are not tunable.

interface Tunable {
  path: string;            // config dot-path the override applies to
  prefix: string;          // gate_fail_reason prefix that attributes kills to this rule
  step: number;            // one loosen movement
  bounds: [number, number];// HARD bounds — deliberately in code, not config
  loosenDir: 1 | -1;       // +1 = raise to admit more, -1 = lower to admit more
  label: string;
}

// The registry. Bounds are the contract: no amount of bad data can push a knob
// past them.
const TUNABLES: Tunable[] = [
  { path: 'gates.min_liquidity_sol_curve',  prefix: 'curve_sol',       step: 1,    bounds: [4, 15],       loosenDir: -1, label: 'curve SOL floor' },
  { path: 'gates.min_liquidity_usd',        prefix: 'liq_below_min',   step: 1000, bounds: [6000, 20000], loosenDir: -1, label: 'AMM liquidity floor' },
  { path: 'gates.rugcheck_score_max',       prefix: 'rugcheck_score',  step: 500,  bounds: [2000, 9000],  loosenDir: +1, label: 'RugCheck risk ceiling' },
  { path: 'gates.top3_holder_pct_max',      prefix: 'top3',            step: 2,    bounds: [25, 45],      loosenDir: +1, label: 'top-3 holder ceiling' },
  { path: 'gates.hard_reject_top_holder_pct', prefix: 'top_holder',    step: 2,    bounds: [40, 60],      loosenDir: +1, label: 'single-holder hard cap' },
  { path: 'deployer.min_wallet_age_hours',  prefix: 'deployer_fresh',  step: 0.5,  bounds: [0, 6],        loosenDir: -1, label: 'deployer wallet age' },
  { path: 'deployer.max_prior_tokens_24h',  prefix: 'deployer_hyper',  step: 1,    bounds: [2, 8],        loosenDir: +1, label: 'deployer launch cap' },
  { path: 'prefilter.serial_launcher_24h',  prefix: 'prefilter_serial',step: 1,    bounds: [2, 10],       loosenDir: +1, label: 'serial-launcher cap' },
  { path: 'prefilter.symbol_wave_per_hour', prefix: 'prefilter_wave',  step: 1,    bounds: [2, 10],       loosenDir: +1, label: 'symbol-wave cap' },
];

interface Decision { at: string; path: string; from: number; to: number; evidence: string }
const diag = { lastRun: null as string | null, lastError: null as string | null, activeOverrides: 0, decisions: [] as Decision[] };
export const learningDiag = () => ({ ...diag, decisions: diag.decisions.slice(0, 12) });

export function startFilterLearner() {
  if (!pool) return;
  loadOverrides().catch(() => {});                 // learned state applies from boot
  setTimeout(() => run().catch(() => {}), 3 * 60_000);
  setInterval(() => run().catch(() => {}), 12 * 3600_000);
}

async function loadOverrides() {
  if (!pool) return;
  const r = await pool.query(`SELECT path, value FROM filter_overrides`).catch(() => null);
  if (!r) return;
  const o: Record<string, number> = {};
  for (const row of r.rows) o[row.path] = Number(row.value);
  diag.activeOverrides = r.rows.length;
  setConfigOverrides(o);
  if (r.rows.length) console.log(`[learning] ${r.rows.length} learned overrides applied`);
}

function getByPath(p: string): number {
  let node: any = cfg();
  for (const k of p.split('.')) node = node?.[k];
  return Number(node);
}

export async function run() {
  if (!pool) return;
  const L = cfg().learning;
  if (!L || !L.enabled) return;
  try {
    diag.lastRun = new Date().toISOString();
    diag.lastError = null;

    // best measured multiple per killed token (any snapshot) within the window,
    // attributed to the rule that killed it
    const kills = await pool.query(`
      SELECT t.gate_fail_reason AS reason, MAX(o.multiple_from_first) AS best
      FROM tokens t JOIN outcomes o ON o.ca = t.ca
      WHERE t.gate_result = 'failed'
        AND t.first_seen > now() - ($1 || ' days')::interval
        AND o.multiple_from_first IS NOT NULL
      GROUP BY t.ca, t.gate_fail_reason`, [String(L.window_days)]);

    for (const tn of TUNABLES) {
      const rows = kills.rows.filter((r: any) => (r.reason || '').startsWith(tn.prefix));
      const n = rows.length;
      if (n < L.min_samples) continue;
      const fk = rows.filter((r: any) => Number(r.best) >= 3).length;
      const rate = fk / n;
      if (rate <= L.loosen_false_kill_rate) continue;

      const cur = getByPath(tn.path);
      const next = clamp(cur + tn.loosenDir * tn.step, tn.bounds);
      if (next === cur) continue;   // already at the bound — the contract holds
      await apply(tn.path, cur, next,
        `loosen ${tn.label}: ${fk}/${n} kills went 3x+ (${(rate * 100).toFixed(1)}% false-kill rate over ${L.window_days}d)`);
    }

    // TIGHTEN (pass-side evidence): the marginal insider band. insider_pct is
    // stored for passed tokens, so the band just under the ceiling is measurable.
    const ceil = cfg().bundle.max_insider_supply_pct;
    const band = await pool.query(`
      SELECT COUNT(*)::int n,
             COUNT(*) FILTER (WHERE o.multiple_from_first >= 2)::int wins,
             AVG(o.multiple_from_first) avg
      FROM tokens t JOIN outcomes o ON o.ca = t.ca AND o.snapshot_minutes = 240
      WHERE t.gate_result = 'passed' AND t.insider_pct IS NOT NULL
        AND t.insider_pct > $1 AND t.insider_pct <= $2
        AND t.first_seen > now() - ($3 || ' days')::interval`,
      [ceil - 10, ceil, String(L.window_days)]);
    const b = band.rows[0];
    if (b && b.n >= L.min_samples && b.wins === 0 && Number(b.avg) < 0.8) {
      const next = clamp(ceil - 3, [10, 35]);
      if (next !== ceil) await apply('bundle.max_insider_supply_pct', ceil, next,
        `tighten insider ceiling: ${b.n} passed tokens at ${ceil - 10}-${ceil}% insiders produced 0 winners, avg ${Number(b.avg).toFixed(2)}x`);
    }
  } catch (e) {
    diag.lastError = (e as Error).message;
    console.error('[learning]', diag.lastError);
  }
}

async function apply(path: string, from: number, to: number, evidence: string) {
  if (!pool) return;
  await pool.query(
    `INSERT INTO filter_overrides (path, value, reason) VALUES ($1,$2,$3)
     ON CONFLICT (path) DO UPDATE SET value=$2, reason=$3, updated_at=now()`, [path, to, evidence]);
  await pool.query(
    `INSERT INTO filter_tuning_log (path, old_value, new_value, evidence) VALUES ($1,$2,$3,$4)`,
    [path, from, to, evidence]);
  diag.decisions.unshift({ at: new Date().toISOString(), path, from, to, evidence });
  if (diag.decisions.length > 50) diag.decisions.pop();
  await loadOverrides();
  console.log(`[learning] ${path}: ${from} -> ${to} — ${evidence}`);
}

const clamp = (x: number, [lo, hi]: [number, number]) => Math.min(hi, Math.max(lo, x));
