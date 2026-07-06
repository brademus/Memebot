"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.startOutcomeLogger = startOutcomeLogger;
const config_1 = require("../config");
const store_1 = require("../store");
const dexscreener_1 = require("../ingest/dexscreener");
const db_1 = require("../db");
// Outcome logger — runs from day one. This DB is the seed for weight-fitting
// and the reverse wallet-discovery pipeline in Phase 4.
const taken = new Map(); // ca -> snapshot minutes already logged
function startOutcomeLogger() {
    setInterval(tick, 60_000);
}
async function tick() {
    if (!db_1.pool)
        return;
    const marks = (0, config_1.cfg)().polling.outcome_snapshot_minutes;
    const now = Date.now();
    for (const t of (0, store_1.allTokens)()) {
        if (t.gated !== true)
            continue; // only log tokens that passed gates
        const ageMin = (now - t.firstSeen) / 60000;
        const done = taken.get(t.ca) || new Set();
        for (const m of marks) {
            if (ageMin >= m && !done.has(m)) {
                const snap = await (0, dexscreener_1.fetchTokenSnapshot)(t.ca);
                if (snap) {
                    await (0, db_1.logOutcome)(t.ca, m, snap.price, snap.liq, snap.mcap, t.firstScorePrice);
                    // rug detection: liquidity collapsed >90% from what we scored it at → mark deployer
                    if (t.firstScorePrice && snap.price < t.firstScorePrice * 0.05 && (0, config_1.cfg)().deployer.blacklist_auto) {
                        await (0, db_1.markRug)(t.ca);
                    }
                }
                done.add(m);
                taken.set(t.ca, done);
            }
        }
    }
}
