"use strict";
// RugCheck free API: authorities, holder concentration, LP status, risk score.
// One call covers 5 of the 7 hard gates.
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchRugReport = fetchRugReport;
async function fetchRugReport(ca) {
    const fail = {
        mintAuthorityRevoked: false, freezeAuthorityInactive: false,
        top3HolderPct: 100, topHolderPct: 100, lpLockedOrBurned: false, riskScore: 99999, ok: false,
    };
    try {
        const res = await fetch(`https://api.rugcheck.xyz/v1/tokens/${ca}/report`, {
            headers: { accept: 'application/json' },
        });
        if (!res.ok)
            return fail;
        const r = await res.json();
        const mintAuthorityRevoked = r.token?.mintAuthority == null;
        const freezeAuthorityInactive = r.token?.freezeAuthority == null;
        // holders: rugcheck returns topHolders with pct; exclude entries flagged as LP/AMM where marked
        const holders = (r.topHolders || []).filter((h) => !h.insider || true);
        const nonLp = holders.filter((h) => {
            const owner = (h.owner || '').toLowerCase();
            return !(r.markets || []).some((m) => [m.liquidityA, m.liquidityB, m.lp?.lpMint].filter(Boolean).map((x) => x.toLowerCase()).includes(owner));
        });
        const pcts = nonLp.map((h) => h.pct || 0).sort((a, b) => b - a);
        const topHolderPct = pcts[0] || 0;
        const top3HolderPct = pcts.slice(0, 3).reduce((s, x) => s + x, 0);
        // LP status: any market with lpLocked pct high, or LP tokens burned
        const lpLockedOrBurned = (r.markets || []).some((m) => (m.lp?.lpLockedPct || 0) >= 90 || (m.lp?.lpBurned === true));
        return {
            mintAuthorityRevoked, freezeAuthorityInactive,
            top3HolderPct, topHolderPct, lpLockedOrBurned,
            riskScore: r.score ?? r.score_normalised ?? 0,
            ok: true,
        };
    }
    catch {
        return fail;
    }
}
