import { TokenRecord } from '../types';

// AI rationale layer. When a token hits TRIGGER, compose everything we know and
// ask Claude for a 2-3 sentence "why this scored high + the main risk" note.
// Optional: no ANTHROPIC_API_KEY = skipped silently. This explains the pick;
// it does not predict. The prediction is the scoring pipeline.
const KEY = process.env.ANTHROPIC_API_KEY || '';

export async function explainTrigger(t: TokenRecord): Promise<string | null> {
  if (!KEY) return null;
  const ageMin = Math.round((Date.now() - t.firstSeen) / 60000);
  const facts = {
    symbol: t.symbol, name: t.name, ageMinutes: ageMin, score: t.score,
    subScores: t.subs,
    liquidityUsd: Math.round(t.liquidityUsd), mcapUsd: Math.round(t.mcapUsd),
    liqMcapRatio: t.mcapUsd ? +(t.liquidityUsd / t.mcapUsd).toFixed(3) : 0,
    buys5m: t.buys5m, sells5m: t.sells5m, priceChange5m: t.priceChange5m,
    movedSinceFirstScorePct: t.firstScorePrice && t.priceUsd ? +(((t.priceUsd / t.firstScorePrice) - 1) * 100).toFixed(1) : 0,
    bundleCheck: t.bundle,   // insiderPct / slot0Buyers / fundedSnipers
    source: t.source,
  };
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 200,
        messages: [{
          role: 'user',
          content: `You are the rationale layer of a Solana memecoin scanner. A token just hit TRIGGER. Data: ${JSON.stringify(facts)}. In 2-3 short sentences: why the data looks strong, and the single biggest risk. Plain language, no hype, no financial advice framing, no emoji. Never say it will go up.`,
        }],
      }),
    });
    if (!res.ok) return null;
    const data: any = await res.json();
    const text = (data.content || []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join(' ').trim();
    return text || null;
  } catch { return null; }
}
