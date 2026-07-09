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
      tgMembers: null,
    };
    // COMMUNITY VERIFICATION — a TG that exists is worth little; a TG with real
    // members is the signal. Public t.me pages expose the count; a channel made
    // five minutes before deploy with 3 members is a manufactured shell and
    // should not ride the 17.4x social lift. Fail-neutral: null = unverifiable
    // (private/invite links, scrape misses) and keeps today's behavior.
    if (t.socials.tg) fetchTgMembers(t, String(m.telegram)).catch(() => {});
  } catch { t.socials.fetched = true; }
}

async function fetchTgMembers(t: TokenRecord, raw: string) {
  const handle = raw.replace(/^https?:\/\//, '').replace(/^(www\.)?t\.me\//, '').replace(/^@/, '')
    .split(/[/?#]/)[0].trim();
  if (!handle || handle.startsWith('+') || /joinchat/i.test(raw)) return;   // invite links: uncountable
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const res = await fetch(`https://t.me/${handle}`, {
      signal: ctrl.signal,
      headers: { 'user-agent': 'Mozilla/5.0' },
    });
    if (!res.ok) return;
    const html = await res.text();
    const m = html.match(/tgme_page_extra">\s*([\d\s\u00a0,\.]+)\s*(?:members|subscribers)/i);
    if (m) t.socials.tgMembers = parseInt(m[1].replace(/[^\d]/g, ''), 10) || null;
  } catch { /* fail-neutral */ }
  finally { clearTimeout(timer); }
}
