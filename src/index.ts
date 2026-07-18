import { initDb, upsertToken, markTrigger, freezeEarlySubs, saveRuntime, loadHydratable } from './db';
import { openPaper, startPaperTrader } from './paper/paper';
import { startPumpfunMonitor, setSolPrice, unsubscribeToken, subscribeToken, resubscribeAll, startSubscriptionReconciler } from './ingest/pumpfun';
import { startDexscreenerPoller } from './ingest/dexscreener';
import { startMomentumScanner } from './ingest/momentum';
import { startSocialScanner } from './ingest/social';
import { runGates } from './gates';
import { deployerRep } from './gates/deployer';
import { checkBundle } from './gates/bundle';
import { scoreToken } from './scoring/score';
import { updateState } from './scoring/states';
import { dropConvictionCandidate, isConvictionCandidate, refreshConvictionQueue } from './scoring/conviction-queue';
import { alertTrigger } from './alerts/telegram';
import { startOutcomeLogger } from './outcomes/logger';
import { startLadderMonitor } from './alerts/ladder';
import { startAutotune } from './tuning/autotune';
import { startFilterLearner } from './tuning/filtertune';
import { startScoreCalibrator } from './tuning/scorecal';
import { startWinnerWalletMiner } from './wallets/winnerminer';
import { generateNote } from './ai/analyst';
import { aiConvictionRead } from './ai/conviction';
import { startServer, broadcast } from './api/server';
import { startWalletDiscovery } from './wallets/discovery';
import { startWalletTracker } from './wallets/tracker';
import { startWalletWebhook } from './wallets/webhook';
import { addToken } from './store';
import { getToken, removeToken, allTokens, recordScan, onTokenRemove, hydrateToken, hydration } from './store';
import { cfg } from './config';
import { getStreamMode } from './ingest/pumpfun';
import { TokenRecord } from './types';

const gateAttempts = new Map<string, number>();
const lastGateAt = new Map<string, number>();
const MAX_GATE_ATTEMPTS = 60;
const GATE_COOLDOWN_MS = 45_000;
const bundleAttempts = new Map<string, number>();
const BUNDLE_RETRY_AGES = [2, 5, 10, 18, 28, 40];
export const bundleCoverage = { attempts: 0, verified: 0 };

process.on('unhandledRejection', (error) =>
  console.error('[fatal-guard] unhandled rejection:', (error as Error)?.message || error));
process.on('uncaughtException', (error) => {
  console.error('[fatal-guard] uncaught exception, exiting for clean restart:', error.message, error.stack);
  process.exit(1);
});

async function main() {
  await initDb();

  try {
    const rows = await loadHydratable(Math.min(150, Math.floor(cfg().limits.max_tracked_tokens * 0.3)));
    for (const row of rows) {
      if (hydrateToken(
        {
          ca: row.ca, symbol: row.symbol, name: row.name, creator: row.creator, source: row.source,
          firstSeenMs: Number(row.first_seen_ms), earlyBuyers: row.early_buyers || [],
        },
        row.runtime,
      )) hydration.restored++;
    }
    hydration.at = new Date().toISOString();
    if (hydration.restored) {
      console.log(`[hydrate] restored ${hydration.restored} tokens from the last snapshot — deploys no longer reset the watchlist`);
    }
    setTimeout(() => {
      const count = resubscribeAll();
      if (count) console.log(`[hydrate] subscribed ${count} restored token streams`);
    }, 8_000);
  } catch (error) {
    console.error('[hydrate]', (error as Error).message);
  }
  startSubscriptionReconciler();
  startPaperTrader();

  setInterval(() => {
    saveRuntime(allTokens().filter(token => token.gated === true && token.state !== 'DEAD')).catch(() => {});
  }, 45_000);
  let shuttingDown = false;
  const flushAndExit = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[hydrate] ${signal} — flushing watchlist snapshot before exit`);
    const guard = setTimeout(() => process.exit(0), 8_000);
    try {
      await saveRuntime(allTokens().filter(token => token.gated === true && token.state !== 'DEAD'));
    } catch {}
    clearTimeout(guard);
    process.exit(0);
  };
  process.on('SIGTERM', () => { void flushAndExit('SIGTERM'); });
  process.on('SIGINT', () => { void flushAndExit('SIGINT'); });

  startServer();

  onTokenRemove((ca) => {
    gateAttempts.delete(ca);
    lastGateAt.delete(ca);
    bundleAttempts.delete(ca);
    dropConvictionCandidate(ca, 'token removed');
    unsubscribeToken(ca);
  });

  const refreshSol = async () => {
    try {
      const response = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
      const data: any = await response.json();
      if (data?.solana?.usd > 0) setSolPrice(data.solana.usd);
    } catch {}
  };
  await refreshSol();
  setInterval(refreshSol, 5 * 60_000);
  startOutcomeLogger();
  startLadderMonitor();

  startWalletDiscovery();
  const walletSurface = (ca: string) => {
    const token = addToken({
      ca,
      symbol: ca.slice(0, 4) + '…',
      name: '(wallet-surfaced)',
      creator: null,
      source: 'wallet',
    });
    if (token) {
      subscribeToken(ca);
      console.log(`[wallets] smart wallet surfaced new token ${ca}`);
    }
  };
  startWalletTracker(walletSurface);
  startWalletWebhook(walletSurface);
  startMomentumScanner(async (ca) => {
    const token = getToken(ca);
    if (token) {
      subscribeToken(ca);
      await tryGate(token);
    }
  });
  startSocialScanner(async (ca) => {
    const token = getToken(ca);
    if (token) {
      subscribeToken(ca);
      await tryGate(token);
    }
  });
  startAutotune();
  startFilterLearner();
  startScoreCalibrator();
  startWinnerWalletMiner();

  const tryGate = async (token: TokenRecord) => {
    if (token.gated !== null || token.liquidityUsd <= 0) return;
    const traction = cfg().traction_floor;
    if (traction?.enabled && token.dex === 'pumpfun' && getStreamMode() === 'full') {
      const trades = token.totalBuys + token.totalSells;
      const bonded = token.curveSol - 30;
      if (trades < traction.min_trades && bonded < traction.min_bonded_sol) return;
    }
    const last = lastGateAt.get(token.ca) || 0;
    if (Date.now() - last < GATE_COOLDOWN_MS) return;
    lastGateAt.set(token.ca, Date.now());
    const attempts = (gateAttempts.get(token.ca) || 0) + 1;
    gateAttempts.set(token.ca, attempts);
    const fail = await runGates(token);
    if (fail === null) {
      token.gated = true;
      token.state = 'WATCHING';
      gateAttempts.delete(token.ca);
      if (!token.deployerRep) {
        deployerRep(token.creator).then(result => { if (result) token.deployerRep = result; }).catch(() => {});
      }
      recordScan({ ca: token.ca, symbol: token.symbol, verdict: 'PASS', reason: null, at: Date.now() });
      console.log(`[gate] PASS  $${token.symbol} ${token.ca}`);
    } else if (isTerminalFail(fail) || attempts >= MAX_GATE_ATTEMPTS) {
      token.gated = false;
      token.gateFailReason = fail;
      if (token.firstScorePrice === null && token.priceUsd > 0) token.firstScorePrice = token.priceUsd;
      recordScan({ ca: token.ca, symbol: token.symbol, verdict: 'KILL', reason: fail, at: Date.now() });
      console.log(`[gate] KILL  $${token.symbol} — ${fail}`);
      await upsertToken(token);
    }
  };

  startDexscreenerPoller(async (token: TokenRecord) => {
    await tryGate(token);
  });

  // Watchlist -> Conviction queue -> entry timing -> one buy alert/current call.
  setInterval(async () => {
    refreshConvictionQueue();

    for (const token of allTokens()) {
      if (token.gated !== true || token.state === 'DEAD') continue;
      const now = Date.now();
      const cutoff = now - 5 * 60_000;
      while (token.recentTrades.length && token.recentTrades[0].at < cutoff) token.recentTrades.shift();
      if (token.dex === 'pumpfun') {
        token.buys5m = token.recentTrades.filter(trade => trade.buy).length;
        token.sells5m = token.recentTrades.length - token.buys5m;
      }

      const ageMin = (now - token.firstSeen) / 60_000;
      const rung = bundleAttempts.get(token.ca) || 0;
      const worthIt = token.score >= 25 || token.state !== 'WATCHING';
      if (token.bundle === null && worthIt && rung < BUNDLE_RETRY_AGES.length && ageMin >= BUNDLE_RETRY_AGES[rung]) {
        bundleAttempts.set(token.ca, rung + 1);
        bundleCoverage.attempts++;
        checkBundle(token).then(result => {
          if (token.bundle !== null) bundleCoverage.verified++;
          if (!result.pass) {
            token.insiderKilled = true;
            token.state = 'DYING';
            dropConvictionCandidate(token.ca, result.reason);
            console.log(`[bundle-late] $${token.symbol} — ${result.reason}`);
          }
          upsertToken(token).catch(() => {});
        }).catch(() => {});
      }

      scoreToken(token);
      const freezeAge = (now - token.firstSeen) / 60_000;
      if (!(token as any).earlyFrozen && freezeAge >= cfg().calibration.freeze_age_min) {
        (token as any).earlyFrozen = true;
        freezeEarlySubs(token.ca, token.subs).catch(() => {});
      }
      if (!('lastUpsertAt' in (token as any)) || now - (token as any).lastUpsertAt > 10 * 60_000) {
        (token as any).lastUpsertAt = now;
        upsertToken(token).catch(() => {});
      }

      if (isConvictionCandidate(token.ca)) {
        if (!token.aiNote) generateNote(token).catch(() => {});
        if (!token.aiConviction) aiConvictionRead(token).catch(() => {});
      }

      const changed = updateState(token, now);
      if (changed === 'TRIGGER') {
        if (!token.triggeredAt) {
          token.triggeredAt = now;
          token.triggerPrice = token.priceUsd;
        }
        await markTrigger(token.ca, token.priceUsd);
        await openPaper(token.ca, token.symbol, 'trigger', token.priceUsd, token.score);
        await alertTrigger(token);
        dropConvictionCandidate(token.ca, 'alerted');
        console.log(`[state] 📣 BUY ALERT $${token.symbol} score=${token.score}`);
      }
      if (changed) upsertToken(token).catch(() => {});
    }
  }, 5000);

  startPumpfunMonitor(async (ca) => {
    const token = getToken(ca);
    if (token) {
      console.log(`[pumpfun] new mint $${token.symbol} ${ca}`);
      await tryGate(token);
    }
  });

  setInterval(broadcast, 2000);

  setInterval(() => {
    const now = Date.now();
    const pendingCutoff = now - (cfg().traction_floor?.pending_purge_min ?? 45) * 60_000;
    const killedCutoff = now - 30 * 60_000;
    const deadCutoff = now - 5 * 3600_000;
    let purged = 0;
    const drop = (ca: string) => {
      removeToken(ca);
      purged++;
    };
    for (const token of allTokens()) {
      if (token.gated === null && token.firstSeen < pendingCutoff) drop(token.ca);
      else if (token.gated === false && token.firstSeen < killedCutoff) drop(token.ca);
      else if (token.state === 'DEAD' && token.firstSeen < deadCutoff) drop(token.ca);
    }
    if (purged) console.log(`[janitor] purged ${purged} stale tokens`);
  }, 5 * 60_000);

  console.log('[memewatch] running');
}

function isTerminalFail(reason: string): boolean {
  return ['mint_authority_active', 'freeze_authority_active', 'sell_sim_failed', 'deployer_blacklisted']
    .some(prefix => reason.startsWith(prefix))
    || reason.startsWith('top_holder_')
    || reason.startsWith('deployer_fresh')
    || reason.startsWith('deployer_hyper');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
