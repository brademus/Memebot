"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const db_1 = require("./db");
const pumpfun_1 = require("./ingest/pumpfun");
const dexscreener_1 = require("./ingest/dexscreener");
const gates_1 = require("./gates");
const score_1 = require("./scoring/score");
const states_1 = require("./scoring/states");
const telegram_1 = require("./alerts/telegram");
const logger_1 = require("./outcomes/logger");
const autotune_1 = require("./tuning/autotune");
const analyst_1 = require("./ai/analyst");
const server_1 = require("./api/server");
const discovery_1 = require("./wallets/discovery");
const tracker_1 = require("./wallets/tracker");
const store_1 = require("./store");
const store_2 = require("./store");
// gate retry policy: new mints have no liquidity yet — re-check every 30s for up to 30min
const gateAttempts = new Map();
const lastGateAt = new Map();
const MAX_GATE_ATTEMPTS = 60;
const GATE_COOLDOWN_MS = 45_000; // efficiency: don't re-hit RugCheck/Helius every 10s poll
async function main() {
    await (0, db_1.initDb)();
    (0, server_1.startServer)();
    (0, logger_1.startOutcomeLogger)();
    // wallet subsystems: discovery mines winners for smart wallets; tracker watches them live
    (0, discovery_1.startWalletDiscovery)();
    (0, tracker_1.startWalletTracker)((ca) => {
        // a tracked wallet bought a token we're not watching — pull it in for gating
        const t = (0, store_1.addToken)({ ca, symbol: '?', name: '(wallet-surfaced)', creator: null, source: 'dexscreener' });
        if (t)
            console.log(`[wallets] smart wallet surfaced new token ${ca}`);
    });
    (0, autotune_1.startAutotune)();
    // Pipeline: enrichment update → (gate if pending) → score → state → alert → broadcast
    (0, dexscreener_1.startDexscreenerPoller)(async (t) => {
        if (t.gated === null) {
            // only attempt gates once the token has any liquidity showing
            if (t.liquidityUsd > 0) {
                const last = lastGateAt.get(t.ca) || 0;
                if (Date.now() - last < GATE_COOLDOWN_MS)
                    return;
                lastGateAt.set(t.ca, Date.now());
                const attempts = (gateAttempts.get(t.ca) || 0) + 1;
                gateAttempts.set(t.ca, attempts);
                const fail = await (0, gates_1.runGates)(t);
                if (fail === null) {
                    t.gated = true;
                    t.state = 'WATCHING';
                    gateAttempts.delete(t.ca);
                    (0, store_2.recordScan)({ ca: t.ca, symbol: t.symbol, verdict: 'PASS', reason: null, at: Date.now() });
                    console.log(`[gate] PASS  $${t.symbol} ${t.ca}`);
                }
                else if (isTerminalFail(fail) || attempts >= MAX_GATE_ATTEMPTS) {
                    t.gated = false;
                    t.gateFailReason = fail;
                    // reference price at kill so the outcome logger can measure false kills
                    if (t.firstScorePrice === null && t.priceUsd > 0)
                        t.firstScorePrice = t.priceUsd;
                    (0, store_2.recordScan)({ ca: t.ca, symbol: t.symbol, verdict: 'KILL', reason: fail, at: Date.now() });
                    console.log(`[gate] KILL  $${t.symbol} — ${fail}`);
                    await (0, db_1.upsertToken)(t);
                    // keep in store briefly so it shows in the seen feed; janitor removes it after a grace window
                    return;
                }
                // non-terminal fail (thin liq early on): stay pending, retry next poll
            }
        }
        if (t.gated === true) {
            (0, score_1.scoreToken)(t);
            const changed = (0, states_1.updateState)(t);
            if (changed === 'TRIGGER') {
                await (0, analyst_1.generateNote)(t); // analyst thesis before the alert goes out
                (0, telegram_1.alertTrigger)(t);
                console.log(`[state] 🎯 TRIGGER $${t.symbol} score=${t.score}`);
            }
            if (changed)
                await (0, db_1.upsertToken)(t);
        }
    });
    (0, pumpfun_1.startPumpfunMonitor)((ca) => {
        const t = (0, store_2.getToken)(ca);
        if (t)
            console.log(`[pumpfun] new mint $${t.symbol} ${ca}`);
    });
    // SSE push every 2s — dashboard stays live without hammering per-token
    setInterval(server_1.broadcast, 2000);
    // janitor: most pump.fun mints die on the curve with zero liquidity — purge
    // anything still PENDING after 45min so the store stays full of live candidates
    setInterval(() => {
        const pendingCutoff = Date.now() - 45 * 60_000; // pending-but-no-liquidity: dead on curve
        const killedCutoff = Date.now() - 30 * 60_000; // killed: keep 30min so they show in seen feed
        let purged = 0;
        for (const t of (0, store_2.allTokens)()) {
            if (t.gated === null && t.firstSeen < pendingCutoff) {
                (0, store_2.removeToken)(t.ca);
                gateAttempts.delete(t.ca);
                purged++;
            }
            else if (t.gated === false && t.firstSeen < killedCutoff) {
                (0, store_2.removeToken)(t.ca);
                purged++;
            }
        }
        if (purged)
            console.log(`[janitor] purged ${purged} stale tokens`);
    }, 5 * 60_000);
    console.log('[memewatch] running');
}
// fails that can't self-heal with time vs. ones that can (liquidity grows on the curve)
function isTerminalFail(reason) {
    return ['mint_authority_active', 'freeze_authority_active', 'sell_sim_failed',
        'deployer_blacklisted'].some(r => reason.startsWith(r)) ||
        reason.startsWith('top_holder_') || reason.startsWith('deployer_fresh') ||
        reason.startsWith('deployer_hyper');
}
main().catch(e => { console.error(e); process.exit(1); });
