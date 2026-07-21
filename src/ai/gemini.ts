import { env } from '../config';

// Last error surfaced for diagnostics — so the dashboard can say WHY the AI is
// down (missing key vs bad model vs quota) instead of a useless "not connected".
let lastGeminiError: string | null = null;
let hardBlocked = false;
let blockedAt: number | null = null;
let retryAfterAt = 0;
let calls = 0;
let blockedCalls = 0;
let lastSuccessAt: number | null = null;

export const geminiLastError = () => lastGeminiError;
export const geminiConfigured = () => !!env.GEMINI_API_KEY;
export const geminiDiag = () => ({
  configured: geminiConfigured(),
  hardBlocked,
  blockedAt: blockedAt ? new Date(blockedAt).toISOString() : null,
  retryAfterAt: retryAfterAt > Date.now() ? new Date(retryAfterAt).toISOString() : null,
  calls,
  blockedCalls,
  lastSuccessAt: lastSuccessAt ? new Date(lastSuccessAt).toISOString() : null,
  lastError: lastGeminiError,
  recovery: hardBlocked ? 'restore AI Studio prepaid credits, then restart Railway' : null,
});

export function isGeminiHardQuota(status: number, body: string): boolean {
  if (status === 403) return true;
  return status === 429 && /prepayment credits are depleted|prepaid credits? (?:depleted|exhausted)|billing account|payment required/i.test(body);
}

// Model fallback chain — Gemini model names change and a retired name 404s. Try
// the configured model, then known-good current fallbacks, so one stale name in
// config doesn't silently kill every AI feature.
const FALLBACKS = ['gemini-3.5-flash', 'gemini-3.1-flash-lite', 'gemini-2.0-flash'];

// Gemini REST helper. One function, model passed per call. Returns null on failure
// but records WHY in lastGeminiError for the dashboard.
export async function gemini(prompt: string, model: string, maxTokens = 300): Promise<string | null> {
  if (!env.GEMINI_API_KEY) { lastGeminiError = 'GEMINI_API_KEY not set in environment'; return null; }
  if (hardBlocked) {
    blockedCalls++;
    return null;
  }
  if (Date.now() < retryAfterAt) {
    blockedCalls++;
    return null;
  }

  calls++;
  const tries = [model, ...FALLBACKS.filter(m => m !== model)];
  let lastStatus = '';
  for (const m of tries) {
    // Thinking config is model-family-specific. Sending an unsupported field can
    // produce a 400, so select it only for model families that accept it.
    const genConfig: any = { maxOutputTokens: maxTokens, temperature: 0.4 };
    if (/gemini-3/.test(m)) genConfig.thinkingConfig = { thinkingLevel: 'low' };
    else if (/gemini-2\.5/.test(m)) genConfig.thinkingConfig = { thinkingBudget: 512 };
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 12_000);
      let res: Response;
      try {
        res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${env.GEMINI_API_KEY}`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: genConfig,
            }),
            signal: controller.signal,
          });
      } finally {
        clearTimeout(timeout);
      }

      if (res.ok) {
        const data: any = await res.json();
        const text = data?.candidates?.[0]?.content?.parts?.map((p: any) => p.text || '').join(' ').trim();
        if (text) {
          lastGeminiError = null;
          retryAfterAt = 0;
          lastSuccessAt = Date.now();
          return text;
        }
        lastStatus = `${m}: empty response`;
        retryAfterAt = Date.now() + 60_000;
        continue;
      }

      const body = (await res.text()).slice(0, 500);
      lastStatus = `${m}: ${res.status} ${body}`;
      if (isGeminiHardQuota(res.status, body)) {
        hardBlocked = true;
        blockedAt = Date.now();
        retryAfterAt = Number.MAX_SAFE_INTEGER;
        break;
      }
      if (res.status === 429) {
        retryAfterAt = Date.now() + 15 * 60_000;
        break;
      }
      // 404/400 usually means a stale model name, so try the next fallback.
      if (res.status !== 404 && res.status !== 400) {
        retryAfterAt = Date.now() + 60_000;
        break;
      }
    } catch (error) {
      const message = (error as Error).name === 'AbortError'
        ? 'request timed out after 12000ms'
        : (error as Error).message;
      lastStatus = `${m}: ${message}`;
      retryAfterAt = Date.now() + 60_000;
      break;
    }
  }
  lastGeminiError = lastStatus || 'all models failed';
  console.error('[gemini]', lastGeminiError);
  return null;
}
