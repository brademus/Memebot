import { env } from '../config';

// Gemini REST helper. One function, model passed per call so the analyst (Flash)
// and the reviewer (Pro) share it. No key = null, callers skip gracefully.
export async function gemini(prompt: string, model: string, maxTokens = 300): Promise<string | null> {
  if (!env.GEMINI_API_KEY) return null;
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: maxTokens, temperature: 0.4 },
        }),
      });
    if (!res.ok) {
      console.error('[gemini]', model, res.status, (await res.text()).slice(0, 200));
      return null;
    }
    const data: any = await res.json();
    const text = data?.candidates?.[0]?.content?.parts
      ?.map((p: any) => p.text || '').join(' ').trim();
    return text || null;
  } catch (e) { console.error('[gemini]', (e as Error).message); return null; }
}
