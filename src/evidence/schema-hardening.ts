import { pool } from '../db';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * `index.ts` starts `initDb()` asynchronously during module evaluation. On a fresh
 * database, boot must not run evidence ALTERs before the core paper_trades table
 * exists. Existing databases pass immediately; fresh databases wait for the core
 * migration and fail closed if it never becomes ready.
 */
export async function waitForCorePaperSchema() {
  if (!pool) return;
  let lastError: string | null = null;
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      const result = await pool.query(`SELECT to_regclass('paper_trades') AS relation`);
      if (result.rows[0]?.relation) return;
      lastError = null;
    } catch (error) {
      lastError = (error as Error).message;
    }
    await sleep(100);
  }
  throw new Error(`core paper schema did not become ready${lastError ? `: ${lastError}` : ''}`);
}

/**
 * Evidence fingerprints describe the policy under which a row was CREATED.
 * Updating a legacy row must never relabel it as current evidence. The main
 * schema initializer creates the trigger idempotently; this hardening step
 * narrows it to inserts before scanners can create new paper rows.
 */
export async function hardenEvidenceSystemV3Schema() {
  if (!pool) return;
  await pool.query(`DROP TRIGGER IF EXISTS trg_stamp_active_policy_fingerprint ON paper_trades`);
  await pool.query(`CREATE TRIGGER trg_stamp_active_policy_fingerprint
    BEFORE INSERT ON paper_trades FOR EACH ROW
    EXECUTE FUNCTION stamp_active_policy_fingerprint()`);
}
