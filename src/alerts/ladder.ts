import { cfg, env } from '../config';
import { allTokens } from '../store';
import { TokenRecord } from '../types';

// EXIT-LADDER ALERTS — the research's discipline layer. Winners' paths peak fast
// (median graduation ~4.4 min; dumps cluster pre-graduation), so profit-taking
// must be mechanical: ~50% at 2-3x (principal safe), 25-30% at 5-10x, exit the
// rest on exhaustion/dump signals. This module watches TRIGGERed tokens and
// pushes the ladder + live dump warnings to Telegram. Alert-only, always.
const LADDER = [
  { mult: 2, msg: 'LADDER 2x — take ~50% (principal off the table, ride the rest free)' },
  { mult: 5, msg: 'LADDER 5x — take another ~25-30%' },
  { mult: 10, msg: 'LADDER 10x — trail the remainder; keep only a small moon bag' },
];

export function startLadderMonitor() {
  setInterval(tick, 20_000);
}

async function tick() {
  for (const t of allTokens()) {
    // BUG FIX: was `t.state !== 'TRIGGER' && !laddersFired.length` — but EXTENDED
    // fires at +40% and the first rung is 2x (+100%), so every token left TRIGGER
    // before any rung could fire. Ladder alerts were structurally unreachable.
    // Track "has ever triggered" instead, and measure multiples from trigger price
    // so the "since trigger" message is literally true.
    if (!t.triggeredAt || t.insiderKilled || t.state === 'DEAD') continue;
    const base = t.triggerPrice || t.firstScorePrice;
    if (!base || t.priceUsd <= 0) continue;
    const mult = t.priceUsd / base;

    for (const step of LADDER) {
      if (mult >= step.mult && !t.laddersFired.includes(step.mult)) {
        t.laddersFired.push(step.mult);
        send(`📈 $${t.symbol} hit ${step.mult}x since trigger\n${step.msg}\nCA: ${t.ca}`);
      }
    }

    // dump warnings (research: volume-price divergence + pressure collapse precede dumps)
    const buyRatio = t.sells5m > 0 ? t.buys5m / t.sells5m : 3;
    if (t.laddersFired.length && buyRatio < 0.6 && !t.laddersFired.includes(-1)) {
      t.laddersFired.push(-1);
      send(`⚠️ $${t.symbol} — sell pressure taking over (b:s ${t.buys5m}:${t.sells5m}). Research says dumps cluster fast; consider exiting remainder.\nCA: ${t.ca}`);
    }
  }
}

async function send(text: string) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
    });
  } catch {}
}
