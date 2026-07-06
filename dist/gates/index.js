"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runGates = runGates;
const config_1 = require("../config");
const rugcheck_1 = require("./rugcheck");
const honeypot_1 = require("./honeypot");
const deployer_1 = require("./deployer");
const bundle_1 = require("./bundle");
// Ordered hard gates. First failure kills the token — cheap checks first.
// Returns null on pass, or the fail reason string.
async function runGates(t) {
    const g = (0, config_1.cfg)().gates;
    // curve-stage tokens (dexId 'pumpfun') have liquidity locked in the bonding curve by
    // the program itself — LP-lock doesn't apply, and the liquidity floor is lower
    const onCurve = t.dex === 'pumpfun';
    // liquidity math first — free, uses Dexscreener data already on the record
    const liqFloor = onCurve ? g.min_liquidity_usd_curve : g.min_liquidity_usd;
    if (t.liquidityUsd < liqFloor)
        return `liq_below_min_${Math.round(t.liquidityUsd)}`;
    if (t.mcapUsd > 0 && t.liquidityUsd / t.mcapUsd < g.liq_to_mcap_ratio_min)
        return `liq_mcap_ratio_${(t.liquidityUsd / t.mcapUsd).toFixed(3)}`;
    // deployer fingerprint — one Helius call
    const dep = await (0, deployer_1.checkDeployer)(t.creator);
    if (!dep.pass)
        return dep.reason;
    // bundle / same-block insider detection — two Helius calls
    const b = await (0, bundle_1.checkBundle)(t);
    if (!b.pass)
        return b.reason;
    // rugcheck — covers authorities, holders, LP, risk score
    const r = await (0, rugcheck_1.fetchRugReport)(t.ca);
    if (!r.ok)
        return 'rugcheck_unavailable'; // fail-closed: no data = no pass
    if (g.mint_authority_revoked && !r.mintAuthorityRevoked)
        return 'mint_authority_active';
    if (g.freeze_authority_inactive && !r.freezeAuthorityInactive)
        return 'freeze_authority_active';
    if (r.topHolderPct > g.hard_reject_top_holder_pct)
        return `top_holder_${r.topHolderPct.toFixed(0)}pct`;
    if (r.top3HolderPct > g.top3_holder_pct_max)
        return `top3_${r.top3HolderPct.toFixed(0)}pct`;
    if (!onCurve && g.lp_locked_or_burned && !r.lpLockedOrBurned)
        return 'lp_not_locked';
    if (r.riskScore > g.rugcheck_score_max)
        return `rugcheck_score_${r.riskScore}`;
    // honeypot last — Jupiter quote
    if (g.honeypot_sim && !(await (0, honeypot_1.canSell)(t.ca)))
        return 'sell_sim_failed';
    return null;
}
