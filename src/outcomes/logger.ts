import { cfg } from '../config';
import { allTokens } from '../store';
import { fetchTokenSnapshot } from '../ingest/dexscreener';
import { logOutcome, markRug, pool } from '../db';

// Outcome logger — runs from day one. This DB is the seed for weight-fitting
// and the reverse wallet-discovery pipeline in Phase 4.
const taken = new Map<string, Set<number>>();   // ca -> snapshot minutes already logged

export function startOutcomeLogger() {
  setInterval(tick, 60_000);
}

async function tick() {
  if (!pool) return;
  const marks = cfg().polling.outcome_snapshot_minutes;
  const now = Date.now();
  for (const t of allTokens()) {
    if (t.gated !== true) continue;              // only log tokens that passed gates
    const ageMin = (now - t.firstSeen) / 60000;
    const done = taken.get(t.ca) || new Set<number>();
    for (const m of marks) {
      if (ageMin >= m && !done.has(m)) {
        const snap = await fetchTokenSnapshot(t.ca);
        if (snap) {
          await logOutcome(t.ca, m, snap.price, snap.liq, snap.mcap, t.firstScorePrice);
          // rug detection: liquidity collapsed >90% from what we scored it at → mark deployer
          if (t.firstScorePrice && snap.price < t.firstScorePrice * 0.05 && cfg().deployer.blacklist_auto) {
            await markRug(t.ca);
          }
        }
        done.add(m);
        taken.set(t.ca, done);
      }
    }
  }
}
