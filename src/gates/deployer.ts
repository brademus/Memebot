import { cfg, env } from '../config';
import { isBlacklistedDeployer, pool } from '../db';

// Deployer fingerprint via Helius. Degrades gracefully: no API key = neutral pass.
// Signals: wallet age (first signature) + launch frequency (creates in last 24h).

export interface DeployerCheck { pass: boolean; reason: string | null }

export async function checkDeployer(creator: string | null): Promise<DeployerCheck> {
  const c = cfg().deployer;
  if (!c.enabled || !creator) return { pass: true, reason: null };

  if (await isBlacklistedDeployer(creator)) {
    return { pass: false, reason: 'deployer_blacklisted' };
  }
  if (!env.HELIUS_API_KEY) return { pass: true, reason: null };

  try {
    const res = await fetch(`https://mainnet.helius-rpc.com/?api-key=${env.HELIUS_API_KEY}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'getSignaturesForAddress',
        params: [creator, { limit: 100 }],
      }),
    });
    if (!res.ok) return { pass: true, reason: null };
    const data: any = await res.json();
    const sigs: any[] = data.result || [];
    if (!sigs.length) return { pass: true, reason: null };

    // wallet age: oldest signature in the window
    const oldest = sigs[sigs.length - 1].blockTime * 1000;
    const ageHours = (Date.now() - oldest) / 3.6e6;
    // if we got a full page of 100 sigs, the wallet is older than the window — treat as aged
    const walletAged = sigs.length === 100 || ageHours >= c.min_wallet_age_hours;
    if (!walletAged) return { pass: false, reason: `deployer_fresh_wallet_${ageHours.toFixed(1)}h` };

    // launch frequency proxy: tx count in last 24h (serial launchers spray constantly)
    const last24h = sigs.filter(s => s.blockTime * 1000 > Date.now() - 864e5).length;
    if (sigs.length === 100 && last24h === 100) {
      return { pass: false, reason: 'deployer_hyperactive_24h' };
    }
    return { pass: true, reason: null };
  } catch { return { pass: true, reason: null }; }
}


// ===== DEPLOYER REPUTATION (graded, from our own launch database) =====
// Research basis (production dataset, 15.1B rows): FIRST-TIME creators pumped at
// 19.91% vs 4.16% for serial deployers (20+ tokens) — a 4.8x gap, "the strongest
// predictor in the dataset." We log every launch with its creator, so the same
// signal is computable from our own Postgres. Graded (bounded score delta), not a
// kill — the binary spam kills above stay as they are. Delta is bounded like the
// AI nudge and every classification is persisted so the weekly report can confirm
// or kill this signal on OUR outcomes (deployerRepPerformance cohort).
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
       LEFT JOIN LATERAL (SELECT MAX(multiple_from_first) AS best FROM outcomes WHERE ca = t.ca) o ON true
       WHERE t.creator = $1`, [creator]);
    const { launches, winners, dead } = r.rows[0];
    const max = c.rep_max_delta;
    let rep: DeployerRep;
    if (launches <= 1) rep = { cls: 'FRESH', launches, winners, delta: max };                     // first launch we've ever seen from this wallet
    else if (launches >= c.rep_serial_min && winners === 0 && dead >= Math.ceil(launches / 2))
      rep = { cls: 'SERIAL_DEAD', launches, winners, delta: -max };                                // serial launcher, majority dead, zero winners
    else if (launches >= c.rep_serial_min) rep = { cls: 'SERIAL', launches, winners, delta: -Math.round(max / 2) };
    else rep = { cls: 'KNOWN', launches, winners, delta: 0 };
    repCache.set(creator, { rep, at: Date.now() });
    if (repCache.size > 5000) repCache.clear();
    return rep;
  } catch { return null; }
}
