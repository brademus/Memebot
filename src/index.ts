import { initDb, upsertToken, markTrigger } from './db';
import { startPumpfunMonitor } from './ingest/pumpfun';
import { startDexscreenerPoller } from './ingest/dexscreener';
import { runGates } from './gates';
import { scoreToken } from './scoring/score';
import { updateState } from './scoring/states';
import { alertTrigger } from './alerts/telegram';
import { explainTrigger } from './alerts/explain';
import { startOutcomeLogger } from './outcomes/logger';
import { startWalletTracker } from './ingest/wallets';
import { startAutotune } from './tuning/autotune';
import { generateNote } from './ai/analyst';
import { startServer, broadcast } from './api/server';
import { getToken, removeToken, allTokens, recordScan } from './store';
import { TokenRecord } from './types';

// gate retry policy: new mints have no liquidity yet — re-check every 30s for up to 30min
const gateAttempts = new Map<string, number>();
const lastGateAt = new Map<string, number>();
const MAX_GATE_ATTEMPTS = 60;
const GATE_COOLDOWN_MS = 45_000;   // efficiency: don't re-hit RugCheck/Helius every 10s poll

async function main() {
  await initDb();
  startServer();
  startOutcomeLogger();
  startWalletTracker();
  startAutotune();

  // Pipeline: enrichment update → (gate if pending) → score → state → alert → broadcast
  startDexscreenerPoller(async (t: TokenRecord) => {
    if (t.gated === null) {
      // only attempt gates once the token has any liquidity showing
      if (t.liquidityUsd > 0) {
        const last = lastGateAt.get(t.ca) || 0;
        if (Date.now() - last < GATE_COOLDOWN_MS) return;
        lastGateAt.set(t.ca, Date.now());
        const attempts = (gateAttempts.get(t.ca) || 0) + 1;
        gateAttempts.set(t.ca, attempts);
        const fail = await runGates(t);
        if (fail === null) {
          t.gated = true;
          t.state = 'WATCHING';
          gateAttempts.delete(t.ca);
          recordScan({ ca: t.ca, symbol: t.symbol, verdict: 'PASS', reason: null, at: Date.now() });
          console.log(`[gate] PASS  $${t.symbol} ${t.ca}`);
        } else if (isTerminalFail(fail) || attempts >= MAX_GATE_ATTEMPTS) {
          t.gated = false;
          t.gateFailReason = fail;
          // reference price at kill so the outcome logger can measure false kills
          if (t.firstScorePrice === null && t.priceUsd > 0) t.firstScorePrice = t.priceUsd;
          recordScan({ ca: t.ca, symbol: t.symbol, verdict: 'KILL', reason: fail, at: Date.now() });
          console.log(`[gate] KILL  $${t.symbol} — ${fail}`);
          await upsertToken(t);
          // keep in store briefly so it shows in the seen feed; janitor removes it after a grace window
          return;
        }
        // non-terminal fail (thin liq early on): stay pending, retry next poll
      }
    }

    if (t.gated === true) {
      scoreToken(t);
      const changed = updateState(t);
      if (changed === 'TRIGGER') {
        await generateNote(t);           // analyst thesis before the alert goes out
        alertTrigger(t);
        console.log(`[state] 🎯 TRIGGER $${t.symbol} score=${t.score}`);
      }
      if (changed) await upsertToken(t);
    }
  });

  startPumpfunMonitor((ca) => {
    const t = getToken(ca);
    if (t) console.log(`[pumpfun] new mint $${t.symbol} ${ca}`);
  });

  // SSE push every 2s — dashboard stays live without hammering per-token
  setInterval(broadcast, 2000);

  // janitor: most pump.fun mints die on the curve with zero liquidity — purge
  // anything still PENDING after 45min so the store stays full of live candidates
  setInterval(() => {
    const pendingCutoff = Date.now() - 45 * 60_000;    // pending-but-no-liquidity: dead on curve
    const killedCutoff = Date.now() - 30 * 60_000;      // killed: keep 30min so they show in seen feed
    let purged = 0;
    for (const t of allTokens()) {
      if (t.gated === null && t.firstSeen < pendingCutoff) { removeToken(t.ca); gateAttempts.delete(t.ca); purged++; }
      else if (t.gated === false && t.firstSeen < killedCutoff) { removeToken(t.ca); purged++; }
    }
    if (purged) console.log(`[janitor] purged ${purged} stale tokens`);
  }, 5 * 60_000);

  console.log('[memewatch] running');
}

// fails that can't self-heal with time vs. ones that can (liquidity grows on the curve)
function isTerminalFail(reason: string): boolean {
  return ['mint_authority_active', 'freeze_authority_active', 'sell_sim_failed',
          'deployer_blacklisted'].some(r => reason.startsWith(r)) ||
         reason.startsWith('top_holder_') || reason.startsWith('deployer_fresh') ||
         reason.startsWith('deployer_hyper');
}

main().catch(e => { console.error(e); process.exit(1); });
