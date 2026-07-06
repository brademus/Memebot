import { cfg, env } from '../config';
import { isBlacklistedDeployer } from '../db';

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
