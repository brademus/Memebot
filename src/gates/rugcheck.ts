// RugCheck free API: authorities, holder concentration, LP status, risk score.
// One call covers 5 of the 7 hard gates.

export interface RugReport {
  mintAuthorityRevoked: boolean;
  freezeAuthorityInactive: boolean;
  top3HolderPct: number;      // excluding LP where identifiable
  topHolderPct: number;
  lpLockedOrBurned: boolean;
  riskScore: number;          // rugcheck score, lower = safer
  ok: boolean;                // fetch succeeded
}

export async function fetchRugReport(ca: string): Promise<RugReport> {
  const fail: RugReport = {
    mintAuthorityRevoked: false, freezeAuthorityInactive: false,
    top3HolderPct: 100, topHolderPct: 100, lpLockedOrBurned: false, riskScore: 99999, ok: false,
  };
  try {
    const res = await fetch(`https://api.rugcheck.xyz/v1/tokens/${ca}/report`, {
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return fail;
    const r: any = await res.json();

    const mintAuthorityRevoked = r.token?.mintAuthority == null;
    const freezeAuthorityInactive = r.token?.freezeAuthority == null;

    // holders: rugcheck returns topHolders with pct; exclude entries flagged as LP/AMM where marked
    const holders: any[] = (r.topHolders || []).filter((h: any) => !h.insider || true);
    const nonLp = holders.filter((h: any) => {
      const owner = (h.owner || '').toLowerCase();
      return !(r.markets || []).some((m: any) =>
        [m.liquidityA, m.liquidityB, m.lp?.lpMint].filter(Boolean).map((x: string) => x.toLowerCase()).includes(owner));
    });
    const pcts = nonLp.map((h: any) => h.pct || 0).sort((a: number, b: number) => b - a);
    const topHolderPct = pcts[0] || 0;
    const top3HolderPct = pcts.slice(0, 3).reduce((s: number, x: number) => s + x, 0);

    // LP status: any market with lpLocked pct high, or LP tokens burned
    const lpLockedOrBurned = (r.markets || []).some((m: any) =>
      (m.lp?.lpLockedPct || 0) >= 90 || (m.lp?.lpBurned === true));

    return {
      mintAuthorityRevoked, freezeAuthorityInactive,
      top3HolderPct, topHolderPct, lpLockedOrBurned,
      riskScore: r.score ?? r.score_normalised ?? 0,
      ok: true,
    };
  } catch { return fail; }
}
