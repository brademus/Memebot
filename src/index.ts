import { initDb, upsertToken, markTrigger, markConviction } from './db';
import { startPumpfunMonitor, setSolPrice, unsubscribeToken } from './ingest/pumpfun';
import { startDexscreenerPoller } from './ingest/dexscreener';
import { runGates } from './gates';
import { checkBundle } from './gates/bundle';
import { scoreToken } from './scoring/score';
import { updateState } from './scoring/states';
import { checkConviction, consumeBudget } from './scoring/conviction';
import { alertTrigger, alertConviction } from './alerts/telegram';
import { startOutcomeLogger } from './outcomes/logger';
import { startLadderMonitor } from './alerts/ladder';
import { startAutotune } from './tuning/autotune';
import { startFilterLearner } from './tuning/filtertune';
import { generateNote } from './ai/analyst';
import { startServer, broadcast } from './api/server';
import { startWalletDiscovery } from './wallets/discovery';
import { startWalletTracker } from './wallets/tracker';
import { startWalletWebhook } from './wallets/webhook';
import { addToken } from './store';
import { getToken, removeToken, allTokens, recordScan } from './store';
import { cfg } from './config';
import { getStreamMode } from './ingest/pumpfun';
import { TokenRecord } from './types';

// gate retry policy: new mints have no liquidity yet — re-check every 30s for up to 30min
const gateAttempts = new Map<string, number>();
const lastGateAt = new Map<string, number>();
const MAX_GATE_ATTEMPTS = 60;
const GATE_COOLDOWN_MS = 45_000;   // efficiency: don't re-hit RugCheck/Helius every 10s poll
const bundleRetried = new Set<string>();

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
  const walletSurface = (ca: string) => {
    // a tracked wallet bought a token we're not watching — pull it in for gating.
    // It rides the normal pipeline from here: gates, scoring, states, smart lane.
    const t = addToken({ ca, symbol: '?', name: '(wallet-surfaced)', creator: null, source: 'dexscreener' });
    if (t) console.log(`[wallets] smart wallet surfaced new token ${ca}`);
  };
  startWalletTracker(walletSurface);       // polling fallback (stands down when webhook is live)
  startWalletWebhook(walletSurface);       // primary: real-time push for ALL active wallets
  startAutotune();
  startFilterLearner();   // the closed loop: filters measure their own mistakes and adjust

  // shared gate runner — called from BOTH the create event (curve-seeded liquidity)
  // and the Dexscreener poller (AMM liquidity). Handles cooldown + retry + verdict.
  const tryGate = async (t: TokenRecord) => {
    if (t.gated !== null) return;
    if (t.liquidityUsd <= 0) return;
    // TRACTION FLOOR: most mints die with a handful of trades — don't spend
    // RugCheck/Helius on a coin that hasn't shown life. With the full trade
    // stream this check is free; the janitor purges never-woke mints early.
    const tf = cfg().traction_floor;
    if (tf?.enabled && t.dex === 'pumpfun' && getStreamMode() === 'full') {
      const trades = t.totalBuys + t.totalSells;
      const bonded = t.curveSol - 30;   // fresh curve starts ~30 SOL virtual
      if (trades < tf.min_trades && bonded < tf.min_bonded_sol) return;   // not a kill — just not yet
    }
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

  // Dexscreener callback: DATA ONLY (enrichment + gate attempts for AMM-path tokens).
  // Scoring/state runs on its own loop below so curve tokens without a Dexscreener
  // pair still score and transition — they were frozen after gating before this.
  startDexscreenerPoller(async (t: TokenRecord) => {
    await tryGate(t);
  });

  // SCORING LOOP — every 5s over all gated tokens, independent of any data source.
  setInterval(async () => {
    for (const t of allTokens()) {
      if (t.gated !== true || t.state === 'DEAD') continue;
      // prune the rolling trade window even when no new trades arrive (decay to zero)
      const cutoff = Date.now() - 5 * 60_000;
      while (t.recentTrades.length && t.recentTrades[0].at < cutoff) t.recentTrades.shift();
      if (t.dex === 'pumpfun') {
        t.buys5m = t.recentTrades.filter(x => x.buy).length;
        t.sells5m = t.recentTrades.length - t.buys5m;
      }
      // LATE BUNDLE RE-CHECK: at gate time (seconds old) Helius hasn't indexed the
      // token yet, so the insider check came back empty on ~99% of tokens. Re-run
      // once at 3-8 min. Report data: insider-clean tokens averaged 2.69x vs 0.88x
      // unknown — this is the single strongest per-token signal we have.
      const ageMinB = (Date.now() - t.firstSeen) / 60000;
      if (t.bundle === null && ageMinB >= 3 && ageMinB < 10 && !bundleRetried.has(t.ca)) {
        bundleRetried.add(t.ca);
        checkBundle(t).then(res => {
          if (!res.pass) {
            t.insiderKilled = true;   // sticky — state machine holds DYING from here
            t.state = 'DYING';        // insider structure found late — off the screen, slot-ejected
            console.log(`[bundle-late] $${t.symbol} — ${res.reason}`);
          }
          upsertToken(t).catch(() => {});
        }).catch(() => {});
      }
      scoreToken(t);
      // keep DB labels fresh — scores were only written on state changes, so
      // never-transitioned tokens carried stale near-zero labels into the report
      if (!('lastUpsertAt' in (t as any)) || Date.now() - (t as any).lastUpsertAt > 10 * 60_000) {
        (t as any).lastUpsertAt = Date.now();
        upsertToken(t).catch(() => {});
      }
      const changed = updateState(t);
      if (changed === 'TRIGGER') {
        if (!t.triggeredAt) { t.triggeredAt = Date.now(); t.triggerPrice = t.priceUsd; }
        markTrigger(t.ca, t.priceUsd);
        alertTrigger(t);                        // alert fires IMMEDIATELY
        generateNote(t).catch(() => {});        // analyst note follows async, shows on dashboard
        console.log(`[state] 🎯 TRIGGER $${t.symbol} score=${t.score}`);
      }
      // CONVICTION: evaluated every tick while a token holds TRIGGER. Fires at most
      // once per token, only when ALL independent confirmations agree (verified-clean
      // insiders, smart-wallet buys, held through the burst, still early, socials).
      if (t.state === 'TRIGGER' && !t.convictionAt) {
        const cv = checkConviction(t);
        if (cv.pass) {
          t.convictionAt = Date.now();
          consumeBudget();
          markConviction(t.ca, t.priceUsd);
          alertConviction(t, cv.confirmed);
          upsertToken(t).catch(() => {});
          console.log(`[state] 🔥 CONVICTION $${t.symbol} — ${cv.confirmed.join('; ')}`);
        }
      }
      if (changed) upsertToken(t).catch(() => {});
    }
  }, 5000);

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
    const now = Date.now();
    const pendingCutoff = now - (cfg().traction_floor?.pending_purge_min ?? 45) * 60_000;   // no traction by now = dead mint
    const killedCutoff = now - 30 * 60_000;    // killed: keep 30min for the seen feed
    const deadCutoff = now - 5 * 3600_000;     // DEAD (aged out): gone after 5h (durable copy is in Postgres)
    let purged = 0;
    const drop = (ca: string) => {
      removeToken(ca); gateAttempts.delete(ca); lastGateAt.delete(ca); bundleRetried.delete(ca); unsubscribeToken(ca); purged++;
    };
    for (const t of allTokens()) {
      if (t.gated === null && t.firstSeen < pendingCutoff) drop(t.ca);
      else if (t.gated === false && t.firstSeen < killedCutoff) drop(t.ca);
      else if (t.state === 'DEAD' && t.firstSeen < deadCutoff) drop(t.ca);
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
