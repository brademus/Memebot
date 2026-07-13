import { TokenRecord } from '../types';

const telegramUrls = new Map<string, string>();

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
    if (m.description && typeof m.description === 'string') t.description = m.description.slice(0, 500);
    if (t.socials.tg) {
      telegramUrls.set(t.ca, String(m.telegram));
      fetchTgMembers(t, String(m.telegram)).catch(() => {});
    }
  } catch { t.socials.fetched = true; }
}

export async function refreshTelegramMembers(t: TokenRecord): Promise<void> {
  const raw = telegramUrls.get(t.ca);
  if (!raw || !t.socials.tg) return;
  await fetchTgMembers(t, raw);
}

async function fetchTgMembers(t: TokenRecord, raw: string) {
  const handle = raw.replace(/^https?:\/\//, '').replace(/^(www\.)?t\.me\//, '').replace(/^@/, '')
    .split(/[/?#]/)[0].trim();
  if (!handle || handle.startsWith('+') || /joinchat/i.test(raw)) return;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const res = await fetch(`https://t.me/${handle}`, {
      signal: ctrl.signal,
      headers: { 'user-agent': 'Mozilla/5.0' },
    });
    if (!res.ok) return;
    const html = await res.text();
    const match = html.match(/tgme_page_extra">\s*([\d\s\u00a0,\.]+)\s*(?:members|subscribers)/i);
    if (!match) return;
    const members = parseInt(match[1].replace(/[^\d]/g, ''), 10) || null;
    if (!members) return;
    t.socials.tgMembers = members;
    recordTgSample(t, members);
  } catch {}
  finally { clearTimeout(timer); }
}

function recordTgSample(t: TokenRecord, members: number) {
  const now = Date.now();
  t.tgSamples = (t.tgSamples || []).filter(sample => now - sample.at < 30 * 60_000);
  const prior = t.tgSamples[t.tgSamples.length - 1];
  if (!prior || prior.n !== members || now - prior.at > 60_000)
    t.tgSamples.push({ n: members, at: now });
  if (t.tgSamples.length >= 2) {
    const first = t.tgSamples[0];
    const last = t.tgSamples[t.tgSamples.length - 1];
    const minutes = (last.at - first.at) / 60_000;
    t.tgGrowthPerMin = minutes > 0.5 ? Math.round((last.n - first.n) / minutes) : 0;
  }
}
