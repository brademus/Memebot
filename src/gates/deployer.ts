import { cfg, env } from '../config';
import { isBlacklistedDeployer, pool } from '../db';
import { heliusRpc } from '../helius';

export interface DeployerCheck { pass: boolean; reason: string | null }

export async function checkDeployer(creator: string | null): Promise<DeployerCheck> {
  const c = cfg().deployer;
  if (!c.enabled || !creator) return { pass: true, reason: null };
  if (await isBlacklistedDeployer(creator)) return { pass: false, reason: 'deployer_blacklisted' };

  // Enforce the exact knob the filter learner tunes. Count prior launches from our
  // durable stream instead of using general transaction volume as a launch proxy.
  if (pool) {
    const prior = await pool.query(
      `SELECT COUNT(*)::int AS n FROM tokens
        WHERE creator=$1 AND first_seen > now()-interval '24 hours'`,
      [creator],
    ).catch(() => null);
    const n = Number(prior?.rows[0]?.n || 0);
    if (n >= c.max_prior_tokens_24h)
      return { pass: false, reason: `deployer_hyper_prior_tokens_${n}` };
  }

  if (!env.HELIUS_API_KEY) return { pass: true, reason: null };
  try {
    const sigs = await heliusRpc<any[]>(
      'getSignaturesForAddress',
      [creator, { limit: 100 }],
      'fg',
    ) || [];
    if (!sigs.length) return { pass: true, reason: null };
    const oldestBlockTime = Number(sigs[sigs.length - 1]?.blockTime || 0);
    if (!oldestBlockTime) return { pass: true, reason: null };
    const oldest = oldestBlockTime * 1000;
    const ageHours = (Date.now() - oldest) / 3.6e6;
    const walletAged = sigs.length === 100 || ageHours >= c.min_wallet_age_hours;
    if (!walletAged) return { pass: false, reason: `deployer_fresh_wallet_${ageHours.toFixed(1)}h` };
    const last24h = sigs.filter(signature => Number(signature.blockTime || 0) * 1000 > Date.now() - 864e5).length;
    if (sigs.length === 100 && last24h === 100)
      return { pass: false, reason: 'deployer_hyperactive_24h' };
    return { pass: true, reason: null };
  } catch { return { pass: true, reason: null }; }
}

export interface DeployerRep { cls: 'FRESH' | 'KNOWN' | 'SERIAL' | 'SERIAL_DEAD'; launches: number; winners: number; delta: number }
const repCache = new Map<string, { rep: DeployerRep; at: number }>();

export async function deployerRep(creator: string | null): Promise<DeployerRep | null> {
  const c = cfg().deployer;
  if (!c.rep_enabled || !creator || !pool) return null;
  const hit = repCache.get(creator);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.rep;
  try {
    const r = await pool.query(
      `SELECT COUNT(*)::int AS launches,
              COUNT(*) FILTER (WHERE o.best >= 3)::int AS winners,
              COUNT(*) FILTER (WHERE o.best IS NOT NULL AND o.best < 1.2)::int AS dead
       FROM tokens t
       LEFT JOIN LATERAL (SELECT MAX(multiple_from_first) AS best FROM outcomes WHERE ca=t.ca) o ON true
       WHERE t.creator=$1`, [creator]);
    const { launches, winners, dead } = r.rows[0];
    const max = c.rep_max_delta;
    let rep: DeployerRep;
    if (launches <= 1) rep = { cls: 'FRESH', launches, winners, delta: max };
    else if (launches >= c.rep_serial_min && winners === 0 && dead >= Math.ceil(launches / 2))
      rep = { cls: 'SERIAL_DEAD', launches, winners, delta: -max };
    else if (launches >= c.rep_serial_min) rep = { cls: 'SERIAL', launches, winners, delta: -Math.round(max / 2) };
    else rep = { cls: 'KNOWN', launches, winners, delta: 0 };
    repCache.set(creator, { rep, at: Date.now() });
    if (repCache.size > 5000) repCache.clear();
    return rep;
  } catch { return null; }
}
