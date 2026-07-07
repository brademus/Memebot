import { TokenRecord } from '../types';

// SOCIAL PRESENCE DETECTOR — the highest-lift free signal in the research:
// tokens with X + Telegram + website graduate at 17.4x the rate of bare launches
// (Telegram alone = 8.9x). pump.fun create events carry a metadata URI whose JSON
// includes twitter/telegram/website fields. Fetch it async; score updates next tick.
export async function fetchSocials(t: TokenRecord, uri: string | undefined) {
  if (!uri) { t.socials.fetched = true; return; }
  try {
    const url = uri.startsWith('ipfs://') ? uri.replace('ipfs://', 'https://ipfs.io/ipfs/') : uri;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) { t.socials.fetched = true; return; }
    const m: any = await res.json();
    t.socials = {
      x: !!(m.twitter && String(m.twitter).length > 5),
      tg: !!(m.telegram && String(m.telegram).length > 5),
      web: !!(m.website && String(m.website).length > 5),
      fetched: true,
    };
  } catch { t.socials.fetched = true; }
}
