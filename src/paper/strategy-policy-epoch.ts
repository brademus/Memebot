import { pool } from '../db';
import { ADAPTIVE_EXIT_POLICY, STRATEGY_VERSION } from './strategy-policy';

export const EXIT_POLICY_VERSION = 'adaptive-exit-independent-families-v2';
export const EXIT_POLICY_EPOCH_NAME = 'strategy_exit_independent_families_v2';

let epochPromise: Promise<string> | null = null;
const diag = {
  epochAt: null as string | null,
  lastSuccessAt: null as string | null,
  lastError: null as string | null,
};

export const strategyPolicyEpochDiag = () => ({
  enabled: !!pool,
  epochName: EXIT_POLICY_EPOCH_NAME,
  exitPolicyVersion: EXIT_POLICY_VERSION,
  strategyVersion: STRATEGY_VERSION,
  ...diag,
});

export function ensureStrategyPolicyEpoch(): Promise<string> {
  if (epochPromise) return epochPromise;
  epochPromise = (async () => {
    if (!pool) throw new Error('DATABASE_URL unavailable');
    await pool.query(`CREATE TABLE IF NOT EXISTS evidence_epochs (
      name TEXT PRIMARY KEY,
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb
    )`);
    await pool.query(`INSERT INTO evidence_epochs (name,metadata)
      VALUES ($1,$2::jsonb) ON CONFLICT (name) DO NOTHING`, [EXIT_POLICY_EPOCH_NAME, JSON.stringify({
      purpose: 'prospective evidence after correlated exit conditions were grouped into independent families',
      exitPolicyVersion: EXIT_POLICY_VERSION,
      strategyVersion: STRATEGY_VERSION,
      policy: ADAPTIVE_EXIT_POLICY,
      accounting: 'market-mark and fully simulated entry-plus-exit results are reported separately',
    })]);
    const result = await pool.query(`SELECT started_at FROM evidence_epochs WHERE name=$1`, [EXIT_POLICY_EPOCH_NAME]);
    const epochAt = new Date(result.rows[0]?.started_at || Date.now()).toISOString();
    diag.epochAt = epochAt;
    diag.lastSuccessAt = new Date().toISOString();
    diag.lastError = null;
    return epochAt;
  })().catch(error => {
    diag.lastError = (error as Error).message.slice(0, 400);
    epochPromise = null;
    throw error;
  });
  return epochPromise;
}

export function startStrategyPolicyEpoch() {
  if (!pool) return;
  void ensureStrategyPolicyEpoch().then(epochAt => {
    console.log(`[strategy-policy] ${EXIT_POLICY_VERSION} prospective epoch=${epochAt}`);
  }).catch(error => console.error('[strategy-policy epoch]', (error as Error).message));
}

export const EXECUTION_TRUTH_EPOCH_NAME = 'execution_truth_v1';
/**
 * Marks the moment the execution-honest fixes deployed (strict round-trip
 * promotion predicate, unpriced curve demotion, exit evidence at every eligible
 * close, notional-aligned probes). Reports can scope executable cohorts to rows
 * after this epoch; earlier execution evidence is classifiable as legacy.
 */
export async function ensureExecutionTruthEpoch(): Promise<void> {
  if (!pool) return;
  await pool.query(
    `INSERT INTO evidence_epochs (name, metadata) VALUES ($1, $2::jsonb)
     ON CONFLICT (name) DO NOTHING`,
    [EXECUTION_TRUTH_EPOCH_NAME, JSON.stringify({
      reason: 'promotion integrity + curve demotion + universal exit evidence + notional alignment',
      commits: ['c9b5a37', '76fad02', '7a3913d'],
    })],
  ).catch(() => {});
}
