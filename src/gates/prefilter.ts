import { cfg } from '../config';
import { pool } from '../db';

// PREFILTER — kill obvious garbage AT THE CREATE EVENT, before we spend anything:
// no trade subscription, no metadata fetch, no gate retries, no API calls.
//
// Every check here is synchronous and in-memory. The signals:
//   1. BLACKLISTED DEPLOYER — wallet already rugged a token we logged. The DB
//      check the gates do costs a query per attempt; here it's a cached Set.
//   2. SERIAL LAUNCHER — creator minted > N tokens in 24h ON OUR OWN STREAM.
//      Spray-and-rug factories launch dozens a day; we watch every create, so we
//      can count launches ourselves instead of paying Helius to reconstruct it.
//   3. SYMBOL SPAM WAVE — the same ticker launched 3+ times inside an hour is a
//      copycat wave chasing whatever just trended. First one gets a fair look;
//      the wave behind it is noise by construction.
//   4. NAME SANITY — empty/absurd symbols, links stuffed into the name field.
//
// A prefilter kill is still recorded (KILL + reason) so the seen feed stays
// honest about everything we saw and why it never got a scan.

const blacklist = new Set<string>();
const creatorMints = new Map<string, number[]>();   // creator -> create timestamps (24h)
const symbolWaves = new Map<string, number[]>();    // symbol(lower) -> create timestamps (60m)
const kills: Record<string, number> = {};
let started = false;

export const prefilterDiag = () => ({ blacklistSize: blacklist.size, kills: { ...kills } });

function startBlacklistRefresh() {
  if (started) return;
  started = true;
  const load = async () => {
    if (!pool) return;
    try {
      const r = await pool.query(`SELECT wallet FROM deployers WHERE blacklisted`);
      blacklist.clear();
      for (const row of r.rows) blacklist.add(row.wallet);
    } catch {}
  };
  load();
  setInterval(load, 5 * 60_000);
}

function prune(map: Map<string, number[]>, windowMs: number) {
  const cutoff = Date.now() - windowMs;
  for (const [k, arr] of map) {
    const kept = arr.filter(t => t > cutoff);
    if (kept.length) map.set(k, kept); else map.delete(k);
  }
}
setInterval(() => { prune(creatorMints, 24 * 3600_000); prune(symbolWaves, 60 * 60_000); }, 10 * 60_000);

export function prefilter(msg: { mint: string; symbol?: string; name?: string; traderPublicKey?: string }): string | null {
  const p = cfg().prefilter;
  startBlacklistRefresh();
  const now = Date.now();

  // always record the launch for counters, even when disabled — the data is free
  const creator = msg.traderPublicKey || null;
  if (creator) {
    const arr = creatorMints.get(creator) || [];
    arr.push(now);
    creatorMints.set(creator, arr);
  }
  const symKey = (msg.symbol || '').toLowerCase();
  if (symKey) {
    const arr = symbolWaves.get(symKey) || [];
    arr.push(now);
    symbolWaves.set(symKey, arr);
  }

  if (!p || !p.enabled) return null;

  // 1. blacklisted deployer — cached, instant
  if (creator && blacklist.has(creator)) return kill('prefilter_blacklisted');

  // 2. serial launcher — counted off our own stream, no API needed
  if (creator) {
    const cutoff = now - 24 * 3600_000;
    const n = (creatorMints.get(creator) || []).filter(t => t > cutoff).length;
    if (n > p.serial_launcher_24h) return kill(`prefilter_serial_${n}_in_24h`);
  }

  // 3. symbol spam wave — same ticker flooding within the hour
  if (symKey) {
    const cutoff = now - 60 * 60_000;
    const n = (symbolWaves.get(symKey) || []).filter(t => t > cutoff).length;
    if (n > p.symbol_wave_per_hour) return kill(`prefilter_wave_${symKey}_x${n}`);
  }

  // 4. name sanity
  const sym = (msg.symbol || '').trim();
  if (sym.length < p.min_symbol_len || sym.length > p.max_symbol_len) return kill('prefilter_symbol_len');
  const name = (msg.name || '');
  if (/https?:\/\/|t\.me\/|discord\.gg\//i.test(name)) return kill('prefilter_link_in_name');

  return null;

  function kill(reason: string): string {
    kills[reason.split('_').slice(0, 2).join('_')] = (kills[reason.split('_').slice(0, 2).join('_')] || 0) + 1;
    return reason;
  }
}
