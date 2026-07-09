import crypto from 'crypto';
import { cfg, env } from '../config';
import { pool } from '../db';
import { recordSmartBuy } from './tracker';

// WEBHOOK WALLET TRACKING — the scale upgrade over polling.
//
// The poller does 40 wallets x 1 Helius call / 30s: linear cost, hard ceiling.
// A Helius enhanced webhook takes up to 100,000 addresses and PUSHES every swap
// to us in real time — so every active smart wallet is watched at once, hits land
// in seconds instead of a poll cycle, and API spend drops to near zero.
//
// Needs a public URL. Railway injects RAILWAY_PUBLIC_DOMAIN automatically;
// PUBLIC_URL env overrides. Without either, this module no-ops and the poller
// stays on as the fallback.

let registered = false;
let lastSync = 0;
let lastError: string | null = null;
let addressCount = 0;
// per-boot secret: the webhook is (re)registered on every boot, so a fresh random
// secret each run is both simpler and safer than a persisted one. ADMIN_KEY wins
// if set so the secret survives restarts mid-flight.
const secret = env.ADMIN_KEY || crypto.randomBytes(24).toString('hex');

export const webhookLive = () => registered;
export const webhookDiag = () => ({ registered, lastSync: lastSync ? new Date(lastSync).toISOString() : null, lastError, addressCount });

function publicUrl(): string | null {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  return null;
}

export function startWalletWebhook(onDiscovery: (ca: string) => void) {
  if (!cfg().wallets.enabled || !cfg().wallets.webhook_enabled) return;
  if (!env.HELIUS_API_KEY || !pool) return;
  if (!publicUrl()) { lastError = 'no public URL (set PUBLIC_URL or run on Railway)'; return; }
  discoveryHook = onDiscovery;
  // register shortly after boot, then re-sync the address list every 30 min so
  // newly discovered wallets start streaming without a redeploy
  setTimeout(syncWebhook, 20_000);
  setInterval(syncWebhook, 30 * 60_000);
}

let discoveryHook: ((ca: string) => void) | null = null;
const trackedSet = new Set<string>();   // membership check for incoming deliveries

export async function syncWebhook() {
  if (!pool || !env.HELIUS_API_KEY) return;
  const url = publicUrl();
  if (!url) return;
  const hookUrl = `${url}/api/helius-webhook`;
  try {
    const active = await pool.query(
      `SELECT wallet FROM smart_wallets WHERE active ORDER BY winners_hit DESC LIMIT $1`,
      [cfg().wallets.max_tracked_wallets]);
    const addresses: string[] = active.rows.map((r: any) => r.wallet);
    if (!addresses.length) { lastError = 'no active wallets yet'; return; }
    trackedSet.clear();
    for (const a of addresses) trackedSet.add(a);

    const base = `https://api.helius.xyz/v0/webhooks?api-key=${env.HELIUS_API_KEY}`;
    const existing: any[] = await (await fetch(base)).json().catch(() => []);
    const mine = Array.isArray(existing) ? existing.find(w => w.webhookURL === hookUrl) : null;

    const body = JSON.stringify({
      webhookURL: hookUrl,
      transactionTypes: ['SWAP'],
      accountAddresses: addresses,
      webhookType: 'enhanced',
      authHeader: secret,
    });
    const res = mine
      ? await fetch(`https://api.helius.xyz/v0/webhooks/${mine.webhookID}?api-key=${env.HELIUS_API_KEY}`,
          { method: 'PUT', headers: { 'content-type': 'application/json' }, body })
      : await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    if (!res.ok) throw new Error(`helius webhook ${mine ? 'update' : 'create'}: ${res.status} ${(await res.text()).slice(0, 200)}`);

    registered = true;
    lastSync = Date.now();
    lastError = null;
    addressCount = addresses.length;
    console.log(`[wallets] webhook live — ${addresses.length} wallets streaming to ${hookUrl}`);
  } catch (e) {
    lastError = (e as Error).message;
    console.error('[wallets] webhook', lastError);
  }
}

// Express handler — mounted at POST /api/helius-webhook.
// Helius sends an array of enhanced transactions per delivery.
export function handleWebhook(authHeader: string | undefined, payload: any): number {
  if (authHeader !== secret) return 401;
  const txs: any[] = Array.isArray(payload) ? payload : [payload];
  for (const tx of txs) {
    if (!tx || (tx.type && tx.type !== 'SWAP')) continue;   // anti-dust: only real swaps
    for (const tt of tx.tokenTransfers || []) {
      if (!tt.mint || !tt.toUserAccount) continue;
      // credit ONLY wallets we actually track — deliveries also contain the
      // counterparty side of every swap
      if (trackedSet.has(tt.toUserAccount))
        recordSmartBuy(tt.toUserAccount, tt.mint, discoveryHook || (() => {}));
    }
  }
  return 200;
}
