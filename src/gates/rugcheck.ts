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

export async function fetchRugReport(ca: string, onCurve = false): Promise<RugReport> {
  const fail: RugReport = {
    mintAuthorityRevoked: false, freezeAuthorityInactive: false,
    top3HolderPct: 100, topHolderPct: 100, lpLockedOrBurned: false, riskScore: 99999,
    ok: false,
  };
  try {
    const res = await fetch(`https://api.rugcheck.xyz/v1/tokens/${ca}/report`, {
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return fail;
    const r: any = await res.json();

    const mintAuthorityRevoked = r.token?.mintAuthority == null;
    const freezeAuthorityInactive = r.token?.freezeAuthority == null;

    // holders: rugcheck returns topHolders with pct. Exclude LP/pool accounts.
    // Pools are matched by the token-ACCOUNT address (liquidityA/B are token accounts),
    // not the owner wallet — the old owner-only match let pool accounts slip through
    // on graduated AMM runners, reading the pool as a "90% holder" and false-killing
    // established movers. Match on BOTH address and owner to catch either shape.
    const holders: any[] = r.topHolders || [];
    const marketAccts = new Set<string>();
    for (const m of r.markets || [])
      for (const a of [m.liquidityA, m.liquidityB, m.lp?.lpMint, m.pubkey].filter(Boolean))
        marketAccts.add(String(a).toLowerCase());
    const nonLp = holders.filter((h: any) => {
      const addr = (h.address || '').toLowerCase();
      const owner = (h.owner || '').toLowerCase();
      return !marketAccts.has(addr) && !marketAccts.has(owner);
    });
    // On the bonding curve, the curve PDA is normally the largest "holder" — that's
    // protocol-held unsold supply, not a dumper. The old markets-empty heuristic never
    // fired because RugCheck lists the curve itself as a market; the gate now passes
    // onCurve explicitly. Report data (2026-07-07): every top false-kill was
    // top_holder_50-66pct — the curve's mid-fill fingerprint — incl. a missed 11.8x.
    let pcts = nonLp.map((h: any) => h.pct || 0).sort((a: number, b: number) => b - a);
    if (onCurve && pcts.length) pcts = pcts.slice(1);
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
