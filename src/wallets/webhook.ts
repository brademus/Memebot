import crypto from 'crypto';
import { cfg, env } from '../config';
import { pool } from '../db';
import { heliusRequest } from '../helius';
import { recordSmartBuy, setWalletWeights } from './tracker';

let registered = false;
let lastSync = 0;
let lastError: string | null = null;
let addressCount = 0;
let lastAddressFingerprint: string | null = null;
// The Helius webhook keeps its own per-boot secret. Dashboard access does not need
// or share a credential with webhook delivery authentication.
const secret = crypto.randomBytes(24).toString('hex');

export const webhookLive = () => registered;
export const webhookDiag = () => ({
  registered,
  lastSync: lastSync ? new Date(lastSync).toISOString() : null,
  lastError,
  addressCount,
  maxAddresses: WEBHOOK_MAX_WALLETS,
});

function publicUrl(): string | null {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  return null;
}

const safeInteger = (value: string | undefined, fallback: number, minimum: number, maximum: number) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(parsed)));
};

// Webhook events are billed and webhook management calls also consume credits.
// Only proven active wallets belong in the real-time stream. Inactive activity-miner
// candidates can be vetted during the hourly background run without streaming every
// transaction they make.
const WEBHOOK_MAX_WALLETS = safeInteger(process.env.HELIUS_WEBHOOK_MAX_WALLETS, 40, 1, 100);
const UNCHANGED_SYNC_TTL_MS = 6 * 60 * 60_000;

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
    // Real-time delivery is reserved for active wallets that have not failed quality
    // validation. This prevents hundreds of inactive candidates from consuming event
    // credits while preserving manually-added and still-ungraded active wallets.
    const active = await pool.query(
      `SELECT wallet,winners_hit,active FROM smart_wallets
        WHERE active AND quality_verdict IS DISTINCT FROM 'REJECT'
        ORDER BY winners_hit DESC,last_active DESC NULLS LAST,last_validated DESC
        LIMIT $1`,
      [WEBHOOK_MAX_WALLETS]);
    const addresses: string[] = active.rows.map((row: any) => row.wallet);
    if (!addresses.length) { lastError = 'no active quality-qualified wallets yet'; return; }

    const fingerprint = crypto.createHash('sha256').update(addresses.join(',')).digest('hex');
    if (registered && fingerprint === lastAddressFingerprint && Date.now() - lastSync < UNCHANGED_SYNC_TTL_MS) {
      addressCount = addresses.length;
      lastError = null;
      return;
    }

    trackedSet.clear();
    signalSet.clear();
    for (const row of active.rows) {
      trackedSet.add(row.wallet);
      signalSet.add(row.wallet);
    }
    setWalletWeights(active.rows);

    const base = `https://api.helius.xyz/v0/webhooks?api-key=${encodeURIComponent(env.HELIUS_API_KEY)}`;
    const existingResult = await heliusRequest<any[]>(base, {}, {
      group: 'admin',
      priority: 'bg',
      maxAttempts: 1,
      dedupeKey: `helius-webhooks:list:${hookUrl}`,
      cacheTtlMs: 60_000,
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
      maxAttempts: 1,
      dedupeKey: `helius-webhooks:${mine ? 'update' : 'create'}:${hookUrl}:${fingerprint}`,
    });
    if (!response.ok) throw new Error(`helius webhook ${mine ? 'update' : 'create'}: ${response.status || 0} ${response.error || 'request deferred'}`);
    registered = true;
    lastSync = Date.now();
    lastError = null;
    addressCount = addresses.length;
    lastAddressFingerprint = fingerprint;
    console.log(`[wallets] webhook live — ${addresses.length} active wallets streaming to ${hookUrl}`);
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
