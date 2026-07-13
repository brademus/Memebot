import { cfg } from '../config';
import { pool } from '../db';

// PREFILTER — kill obvious garbage AT THE CREATE EVENT, before we spend anything:
// no trade subscription, no metadata fetch, no gate retries, no API calls.
const blacklist = new Set<string>();
const creatorMints = new Map<string, number[]>();
const symbolWaves = new Map<string, number[]>();
const kills: Record<string, number> = {};
let started = false;

export const prefilterDiag = () => ({ blacklistSize: blacklist.size, kills: { ...kills } });

function startBlacklistRefresh() {
  if (started) return;
  started = true;
  const load = async () => {
    if (!pool) return;
    try {
      const result = await pool.query(`SELECT wallet FROM deployers WHERE blacklisted`);
      blacklist.clear();
      for (const row of result.rows) blacklist.add(row.wallet);
    } catch {}
  };
  load();
  const refreshTimer = setInterval(load, 5 * 60_000);
  refreshTimer.unref();
}

function prune(map: Map<string, number[]>, windowMs: number) {
  const cutoff = Date.now() - windowMs;
  for (const [key, values] of map) {
    const kept = values.filter(timestamp => timestamp > cutoff);
    if (kept.length) map.set(key, kept);
    else map.delete(key);
  }
}

const pruneTimer = setInterval(() => {
  prune(creatorMints, 24 * 3600_000);
  prune(symbolWaves, 60 * 60_000);
}, 10 * 60_000);
pruneTimer.unref();

export function prefilter(msg: { mint: string; symbol?: string; name?: string; traderPublicKey?: string }): string | null {
  const settings = cfg().prefilter;
  startBlacklistRefresh();
  const now = Date.now();

  const creator = msg.traderPublicKey || null;
  if (creator) {
    const values = creatorMints.get(creator) || [];
    values.push(now);
    creatorMints.set(creator, values);
  }

  const symbolKey = (msg.symbol || '').toLowerCase();
  if (symbolKey) {
    const values = symbolWaves.get(symbolKey) || [];
    values.push(now);
    symbolWaves.set(symbolKey, values);
  }

  if (!settings?.enabled) return null;
  if (creator && blacklist.has(creator)) return kill('prefilter_blacklisted');

  if (creator) {
    const cutoff = now - 24 * 3600_000;
    const count = (creatorMints.get(creator) || []).filter(timestamp => timestamp > cutoff).length;
    if (count > settings.serial_launcher_24h) return kill(`prefilter_serial_${count}_in_24h`);
  }

  if (symbolKey) {
    const cutoff = now - 60 * 60_000;
    const count = (symbolWaves.get(symbolKey) || []).filter(timestamp => timestamp > cutoff).length;
    if (count > settings.symbol_wave_per_hour) return kill(`prefilter_wave_${symbolKey}_x${count}`);
  }

  const symbol = (msg.symbol || '').trim();
  if (symbol.length < settings.min_symbol_len || symbol.length > settings.max_symbol_len)
    return kill('prefilter_symbol_len');
  const name = msg.name || '';
  if (/https?:\/\/|t\.me\/|discord\.gg\//i.test(name)) return kill('prefilter_link_in_name');
  return null;

  function kill(reason: string): string {
    const key = reason.split('_').slice(0, 2).join('_');
    kills[key] = (kills[key] || 0) + 1;
    return reason;
  }
}
