import { env } from '../config';

// last error surfaced for diagnostics — so the dashboard can say WHY the AI is
// down (missing key vs bad model vs quota) instead of a useless "not connected".
let lastGeminiError: string | null = null;
export const geminiLastError = () => lastGeminiError;
export const geminiConfigured = () => !!env.GEMINI_API_KEY;

// Model fallback chain — Gemini model names change and a retired name 404s. Try
// the configured model, then known-good current fallbacks, so one stale name in
// config doesn't silently kill every AI feature. Updated 2026-07 to current names.
const FALLBACKS = ['gemini-3.5-flash', 'gemini-3.1-flash-lite', 'gemini-2.0-flash'];

// Gemini REST helper. One function, model passed per call. Returns null on failure
// but records WHY in lastGeminiError for the dashboard.
export async function gemini(prompt: string, model: string, maxTokens = 300): Promise<string | null> {
  if (!env.GEMINI_API_KEY) { lastGeminiError = 'GEMINI_API_KEY not set in environment'; return null; }
  const tries = [model, ...FALLBACKS.filter(m => m !== model)];
  let lastStatus = '';
  for (const m of tries) {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${env.GEMINI_API_KEY}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { maxOutputTokens: maxTokens, temperature: 0.4 },
          }),
        });
      if (res.ok) {
        const data: any = await res.json();
        const text = data?.candidates?.[0]?.content?.parts?.map((p: any) => p.text || '').join(' ').trim();
        if (text) { lastGeminiError = null; return text; }
        lastStatus = `${m}: empty response`;
        continue;
      }
      const body = (await res.text()).slice(0, 150);
      lastStatus = `${m}: ${res.status} ${body}`;
      // 404/400 = bad model name -> try next fallback. 403/429 = key/quota -> stop, retrying won't help.
      if (res.status === 403 || res.status === 429) break;
    } catch (e) {
      lastStatus = `${m}: ${(e as Error).message}`;
    }
  }
  lastGeminiError = lastStatus || 'all models failed';
  console.error('[gemini]', lastGeminiError);
  return null;
}
