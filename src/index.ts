import { initDb, upsertToken, markTrigger } from './db';
import { startPumpfunMonitor, setSolPrice } from './ingest/pumpfun';
import { startDexscreenerPoller } from './ingest/dexscreener';
import { runGates } from './gates';
import { scoreToken } from './scoring/score';
import { updateState } from './scoring/states';
import { alertTrigger } from './alerts/telegram';
import { startOutcomeLogger } from './outcomes/logger';
import { startLadderMonitor } from './alerts/ladder';
import { startAutotune } from './tuning/autotune';
import { generateNote } from './ai/analyst';
import { startServer, broadcast } from './api/server';
import { startWalletDiscovery } from './wallets/discovery';
import { startWalletTracker } from './wallets/tracker';
import { addToken } from './store';
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

  // keep a live SOL/USD price so curve SOL amounts convert to real USD for gating
  const refreshSol = async () => {
    try {
      const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
      const d: any = await r.json();
      if (d?.solana?.usd > 0) setSolPrice(d.solana.usd);
    } catch {}
  };
  await refreshSol();
  setInterval(refreshSol, 5 * 60_000);
  startOutcomeLogger();
  startLadderMonitor();

  // wallet subsystems: discovery mines winners for smart wallets; tracker watches them live
  startWalletDiscovery();
  startWalletTracker((ca: string) => {
    // a tracked wallet bought a token we're not watching — pull it in for gating
    const t = addToken({ ca, symbol: '?', name: '(wallet-surfaced)', creator: null, source: 'dexscreener' });
    if (t) console.log(`[wallets] smart wallet surfaced new token ${ca}`);
  });
  startAutotune();

  // shared gate runner — called from BOTH the create event (curve-seeded liquidity)
  // and the Dexscreener poller (AMM liquidity). Handles cooldown + retry + verdict.
  const tryGate = async (t: TokenRecord) => {
    if (t.gated !== null) return;
    if (t.liquidityUsd <= 0) return;
    const last = lastGateAt.get(t.ca) || 0;
    if (Date.now() - last < GATE_COOLDOWN_MS) return;
    lastGateAt.set(t.ca, Date.now());
    const attempts = (gateAttempts.get(t.ca) || 0) + 1;
    gateAttempts.set(t.ca, attempts);
    const fail = await runGates(t);
    if (fail === null) {
      t.gated = true; t.state = 'WATCHING'; gateAttempts.delete(t.ca);
      recordScan({ ca: t.ca, symbol: t.symbol, verdict: 'PASS', reason: null, at: Date.now() });
      console.log(`[gate] PASS  $${t.symbol} ${t.ca}`);
    } else if (isTerminalFail(fail) || attempts >= MAX_GATE_ATTEMPTS) {
      t.gated = false; t.gateFailReason = fail;
      if (t.firstScorePrice === null && t.priceUsd > 0) t.firstScorePrice = t.priceUsd;
      recordScan({ ca: t.ca, symbol: t.symbol, verdict: 'KILL', reason: fail, at: Date.now() });
      console.log(`[gate] KILL  $${t.symbol} — ${fail}`);
      await upsertToken(t);
    }
  };

  // Pipeline: enrichment update → (gate if pending) → score → state → alert → broadcast
  startDexscreenerPoller(async (t: TokenRecord) => {
    await tryGate(t);
    if (false) {
      {
        const fail = await runGates(t);
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

  startPumpfunMonitor(async (ca) => {
    const t = getToken(ca);
    if (t) {
      console.log(`[pumpfun] new mint $${t.symbol} ${ca}`);
      // gate immediately using curve-seeded liquidity — no wait for Dexscreener
      await tryGate(t);
    }
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
