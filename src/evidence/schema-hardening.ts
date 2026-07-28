import { pool } from '../db';

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
