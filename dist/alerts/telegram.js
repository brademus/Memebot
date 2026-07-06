"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.alertTrigger = alertTrigger;
const config_1 = require("../config");
// Backup channel for when you're away from the screen. TRIGGER-only, deduped.
async function alertTrigger(t) {
    if (!(0, config_1.cfg)().alerts.telegram_on_trigger)
        return;
    if (!config_1.env.TELEGRAM_BOT_TOKEN || !config_1.env.TELEGRAM_CHAT_ID)
        return;
    if (t.score - t.lastAlertScore < (0, config_1.cfg)().alerts.realert_score_jump && t.lastAlertScore > 0)
        return;
    t.lastAlertScore = t.score;
    const ran = t.firstScorePrice && t.priceUsd
        ? ((t.priceUsd / t.firstScorePrice - 1) * 100).toFixed(0) : '0';
    const ageMin = Math.round((Date.now() - t.firstSeen) / 60000);
    const text = [
        `🎯 TRIGGER — $${t.symbol}  [${t.score}]`,
        `age ${ageMin}m | liq $${fmt(t.liquidityUsd)} | mcap $${fmt(t.mcapUsd)} | ratio ${(t.liquidityUsd / Math.max(t.mcapUsd, 1) * 100).toFixed(0)}%`,
        `buys:sells 5m ${t.buys5m}:${t.sells5m} | moved ${ran}% since first score`,
        `chart: https://dexscreener.com/solana/${t.pairAddress || t.ca}`,
        `swap: https://jup.ag/swap/SOL-${t.ca}`,
        `CA: ${t.ca}`,
        t.aiNote ? `\n🧠 ${t.aiNote}` : '',
    ].filter(Boolean).join('\n');
    try {
        await fetch(`https://api.telegram.org/bot${config_1.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ chat_id: config_1.env.TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
        });
    }
    catch (e) {
        console.error('[telegram]', e.message);
    }
}
const fmt = (n) => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : (n / 1e3).toFixed(0) + 'K';
