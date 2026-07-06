import { cfg, env } from '../config';
import { TokenRecord } from '../types';

// AI analyst: one short thesis per token, generated the first time it hits TRIGGER.
// Explains WHY the numbers look good and what the main risk is. Skipped without a key.
export async function generateNote(t: TokenRecord): Promise<void> {
  if (!cfg().ai.enabled || !env.ANTHROPIC_API_KEY || t.aiNote) return;
  const facts = {
    symbol: t.symbol, ageMinutes: Math.round((Date.now() - t.firstSeen) / 60000),
    score: t.score, subScores: t.subs,
    liquidityUsd: Math.round(t.liquidityUsd), mcapUsd: Math.round(t.mcapUsd),
    liqToMcap: t.mcapUsd ? +(t.liquidityUsd / t.mcapUsd).toFixed(3) : null,
    buys5m: t.buys5m, sells5m: t.sells5m, priceChange5m: t.priceChange5m,
    movedSinceFirstScorePct: t.firstScorePrice && t.priceUsd ? +(((t.priceUsd / t.firstScorePrice) - 1) * 100).toFixed(1) : 0,
    insiderPct: t.bundle?.insiderPct ?? null, deployerLinkedSnipers: t.bundle?.fundedSnipers ?? null,
    smartMoneyHits: new Set(t.smartHits.map(h => h.wallet)).size,
    phase: t.dex === 'pumpfun' ? 'bonding-curve' : t.dex,
  };
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: cfg().ai.model,
        max_tokens: 200,
        messages: [{
          role: 'user',
          content: `You are a memecoin scanner's analyst module. Given this token's live metrics, write a 2-3 sentence note: (1) the single strongest reason this passed the filter, (2) the single biggest risk, (3) end with "Entry quality:" GOOD/MIXED/LATE based on movedSinceFirstScorePct (>25% = LATE). Be blunt, no hedging filler, no financial advice disclaimer. Metrics: ${JSON.stringify(facts)}`,
        }],
      }),
    });
    if (!res.ok) return;
    const data: any = await res.json();
    const text = (data.content || []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join(' ').trim();
    if (text) t.aiNote = text.slice(0, 500);
  } catch { /* analyst is best-effort */ }
}
