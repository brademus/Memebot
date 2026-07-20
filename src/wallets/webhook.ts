import crypto from 'crypto';
import { cfg, env } from '../config';
import { pool } from '../db';
import { heliusRequest } from '../helius';
import { recordSmartBuy, setWalletWeights } from './tracker';

let registered = false;
let lastSync = 0;
let lastError: string | null = null;
let addressCount = 0;
// The Helius webhook keeps its own per-boot secret. Dashboard access does not need
// or share a credential with webhook delivery authentication.
const secret = crypto.randomBytes(24).toString('hex');

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
  setTimeout(syncWebhook, 20_000);
  const timer = setInterval(syncWebhook, 30 * 60_000);
  timer.unref();
}

let discoveryHook: ((ca: string) => void) | null = null;
const trackedSet = new Set<string>();
const signalSet = new Set<string>();
const QUOTE_MINTS = new Set([
  'So11111111111111111111111111111111111111112',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
]);

export async function syncWebhook() {
  if (!pool || !env.HELIUS_API_KEY) return;
  const url = publicUrl();
  if (!url) return;
  const hookUrl = `${url}/api/helius-webhook`;
  try {
    // Active wallets may generate trusted smart-money signals. Pump.fun activity
    // candidates are streamed too, but remain observation-only until promoted.
    const active = await pool.query(
      `SELECT wallet,winners_hit,active FROM smart_wallets
        WHERE quality_verdict IS DISTINCT FROM 'REJECT'
           OR (type='pumpfun_candidate' AND quality_verdict IS NULL)
        ORDER BY active DESC,winners_hit DESC,last_active DESC NULLS LAST LIMIT $1`,
      [cfg().wallets.max_tracked_wallets]);
    const addresses: string[] = active.rows.map((row: any) => row.wallet);
    if (!addresses.length) { lastError = 'no active or candidate wallets yet'; return; }
    trackedSet.clear();
    signalSet.clear();
    for (const row of active.rows) {
      trackedSet.add(row.wallet);
      if (row.active) signalSet.add(row.wallet);
    }
    setWalletWeights(active.rows);

    const base = `https://api.helius.xyz/v0/webhooks?api-key=${encodeURIComponent(env.HELIUS_API_KEY)}`;
    const existingResult = await heliusRequest<any[]>(base, {}, {
      group: 'admin',
      priority: 'bg',
      maxAttempts: 3,
      dedupeKey: `helius-webhooks:list:${hookUrl}`,
      cacheTtlMs: 5_000,
    });
    if (!existingResult.ok) throw new Error(`helius webhook list: ${existingResult.status || 0} ${existingResult.error || 'request deferred'}`);
    const existing = Array.isArray(existingResult.data) ? existingResult.data : [];
    const mine = existing.find(webhook => webhook.webhookURL === hookUrl) || null;
    const body = JSON.stringify({
      webhookURL: hookUrl,
      transactionTypes: ['SWAP'],
      accountAddresses: addresses,
      webhookType: 'enhanced',
      authHeader: secret,
    });
    const target = mine
      ? `https://api.helius.xyz/v0/webhooks/${encodeURIComponent(mine.webhookID)}?api-key=${encodeURIComponent(env.HELIUS_API_KEY)}`
      : base;
    const response = await heliusRequest<unknown>(target, {
      method: mine ? 'PUT' : 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    }, {
      group: 'admin',
      priority: 'bg',
      maxAttempts: 3,
      dedupeKey: `helius-webhooks:${mine ? 'update' : 'create'}:${hookUrl}:${addresses.join(',')}`,
    });
    if (!response.ok) throw new Error(`helius webhook ${mine ? 'update' : 'create'}: ${response.status || 0} ${response.error || 'request deferred'}`);
    registered = true;
    lastSync = Date.now();
    lastError = null;
    addressCount = addresses.length;
    console.log(`[wallets] webhook live — ${addresses.length} active/candidate wallets streaming to ${hookUrl}`);
  } catch (error) {
    registered = false;
    lastError = (error as Error).message;
    console.error('[wallets] webhook', lastError);
  }
}

export function handleWebhook(authHeader: string | undefined, payload: any): number {
  if (authHeader !== secret) return 401;
  const txs: any[] = Array.isArray(payload) ? payload : [payload];
  for (const tx of txs) {
    if (!tx || (tx.type && tx.type !== 'SWAP')) continue;
    const atMs = tx.timestamp ? tx.timestamp * 1000 : Date.now();
    for (const transfer of tx.tokenTransfers || []) {
      if (!transfer.mint || !transfer.toUserAccount || QUOTE_MINTS.has(transfer.mint)) continue;
      if (trackedSet.has(transfer.toUserAccount)) {
        recordSmartBuy(
          transfer.toUserAccount,
          transfer.mint,
          discoveryHook || (() => {}),
          signalSet.has(transfer.toUserAccount),
          atMs,
        );
      }
    }
  }
  return 200;
}
