(() => {
  const byId = id => document.getElementById(id);
  const money = value => Number.isFinite(Number(value))
    ? `${Number(value) < 0 ? '-' : ''}$${Math.abs(Number(value)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : '—';
  const compactMoney = value => Number.isFinite(Number(value))
    ? `$${Number(value).toLocaleString('en-US', { maximumFractionDigits: 0 })}` : '—';
  const number = (value, digits = 2) => Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : '—';
  const percent = value => Number.isFinite(Number(value)) ? `${Number(value) >= 0 ? '+' : ''}${Number(value).toFixed(2)}%` : '—';
  const title = value => String(value || 'unknown').replaceAll('_', ' ').replace(/\b\w/g, character => character.toUpperCase());
  const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[character]);
  const date = value => Number.isFinite(Number(value)) ? new Date(Number(value)).toLocaleString() : '—';

  function callCard(call) {
    const open = ['armed', 'open', 'partial'].includes(call.status);
    const direction = String(call.direction || '').toUpperCase();
    const pnlClass = Number(call.netPnlUsd) >= 0 ? 'btcPositive' : 'btcNegative';
    const book = call.book === 'actionable' ? 'ACTIONABLE ALERT' : 'STRATEGY RESEARCH';
    const supporting = Array.isArray(call.supportingStrategies) && call.supportingStrategies.length > 1
      ? `<p class="btcSupport">Supported by ${call.supportingStrategies.map(escapeHtml).join(' · ')}</p>` : '';
    return `<article class="callCard btcCallCard ${open ? 'open' : ''}">
      <div class="callHead"><span class="state ${call.direction === 'long' ? 'trigger' : 'dying'}">${escapeHtml(direction)}</span><small>${escapeHtml(book)} · ${escapeHtml(title(call.status))}</small></div>
      <h2>${escapeHtml(call.strategyName || call.strategyId)} <span>${escapeHtml(call.leverage)}x</span></h2>
      <div class="metrics btcMetrics">
        <div class="metric"><small>Entry</small><b>${money(call.entryPrice)}</b></div>
        <div class="metric"><small>Current / exit</small><b>${money(call.exitPrice ?? call.currentPrice)}</b></div>
        <div class="metric"><small>Margin / notional</small><b>${money(call.marginUsd)} / ${compactMoney(call.notionalUsd)}</b></div>
        <div class="metric"><small>Stop</small><b>${money(call.trailingStopPrice ?? call.stopPrice)}</b></div>
        <div class="metric"><small>Liquidation</small><b>${money(call.liquidationPrice)}</b></div>
        <div class="metric"><small>Target</small><b>${money(call.targetPrice)}</b></div>
        <div class="metric"><small>Net P&amp;L</small><b class="${pnlClass}">${money(call.netPnlUsd)}</b></div>
        <div class="metric"><small>ROI / R</small><b class="${pnlClass}">${percent(call.roiPct)} · ${number(call.resultR ?? call.currentR)}R</b></div>
        <div class="metric"><small>Fees / funding</small><b>${money(call.feesUsd)} / ${money(call.fundingUsd)}</b></div>
        <div class="metric"><small>Remaining</small><b>${number(Number(call.remainingFraction || 0) * 100, 0)}%</b></div>
        <div class="metric"><small>MFE / MAE</small><b>${number(call.maxFavorableR)}R / ${number(call.maxAdverseR)}R</b></div>
        <div class="metric"><small>Confidence</small><b>${number(call.confidence, 0)}</b></div>
      </div>
      ${supporting}
      <p class="callReason">${escapeHtml(call.exitReason || (Array.isArray(call.rationale) ? call.rationale.join(' · ') : 'Paper call active.'))}</p>
      <small>${escapeHtml(date(call.openedAt))} · ${escapeHtml(call.strategyVersion || '')} · ${escapeHtml(call.id || '')}</small>
    </article>`;
  }

  function resultRow(call) {
    const positive = Number(call.netPnlUsd) >= 0;
    return `<article class="resultCard btcResultCard">
      <div><strong>${escapeHtml(call.direction?.toUpperCase())} · ${escapeHtml(call.strategyName)}</strong><small>${escapeHtml(call.book)} · ${escapeHtml(call.leverage)}x · ${escapeHtml(title(call.status))}</small></div>
      <div class="${positive ? 'btcPositive' : 'btcNegative'}"><b>${money(call.netPnlUsd)}</b><small>${percent(call.roiPct)} · ${number(call.resultR)}R</small></div>
      <p>${escapeHtml(call.exitReason || 'Closed')}</p>
    </article>`;
  }

  function strategyCard(strategy) {
    const decided = Number(strategy.wins || 0) + Number(strategy.losses || 0);
    const positive = Number(strategy.netPnlUsd) >= 0;
    return `<article class="btcStrategyCard">
      <div class="callHead"><span class="state ${strategy.mode === 'actionable' ? 'trigger' : 'watching'}">${escapeHtml(String(strategy.mode || '').toUpperCase())}</span><small>CAP ${escapeHtml(strategy.leverageCap)}x</small></div>
      <h2>${escapeHtml(strategy.strategyName)}</h2>
      <small>${escapeHtml(strategy.strategyId)} · ${escapeHtml(strategy.strategyVersion)}</small>
      <div class="metrics btcMetrics">
        <div class="metric"><small>Calls</small><b>${escapeHtml(strategy.totalCalls || 0)}</b></div>
        <div class="metric"><small>Active</small><b>${escapeHtml(strategy.activeCalls || 0)}</b></div>
        <div class="metric"><small>Record</small><b>${escapeHtml(strategy.wins || 0)}–${escapeHtml(strategy.losses || 0)}</b></div>
        <div class="metric"><small>Win rate</small><b>${decided ? number(strategy.winRatePct, 1) + '%' : '—'}</b></div>
        <div class="metric"><small>Net P&amp;L</small><b class="${positive ? 'btcPositive' : 'btcNegative'}">${money(strategy.netPnlUsd)}</b></div>
        <div class="metric"><small>Average R</small><b>${strategy.averageR == null ? '—' : number(strategy.averageR) + 'R'}</b></div>
        <div class="metric"><small>Profit factor</small><b>${strategy.profitFactor == null ? '—' : number(strategy.profitFactor)}</b></div>
      </div>
    </article>`;
  }

  function stat(label, value) {
    return `<div class="stat"><small>${escapeHtml(label)}</small><b>${escapeHtml(value)}</b></div>`;
  }

  function render(payload) {
    const btc = payload?.btc;
    if (!btc) return;
    const active = Array.isArray(btc.activeCalls) ? btc.activeCalls : [];
    const actionable = active.filter(call => call.book === 'actionable');
    const research = active.filter(call => call.book === 'research');
    const winners = Array.isArray(btc.winners) ? btc.winners : [];
    const losers = Array.isArray(btc.losers) ? btc.losers : [];
    const strategies = Array.isArray(btc.strategies) ? btc.strategies : [];
    const portfolio = btc.portfolio || {};
    const prices = btc.prices || {};
    const feedHealthy = !!btc.feed?.healthy;

    if (byId('nBtcCalls')) byId('nBtcCalls').textContent = String(actionable.length);
    if (byId('btcCallCount')) byId('btcCallCount').textContent = String(actionable.length);
    if (byId('nBtcPnl')) byId('nBtcPnl').textContent = money(portfolio.activePnlUsd || 0);
    if (byId('nBtcRecord')) byId('nBtcRecord').textContent = `${winners.length}–${losers.length}`;
    if (byId('nBtcStrategies')) byId('nBtcStrategies').textContent = String(strategies.length || 7);
    if (byId('btcStrategyCount')) byId('btcStrategyCount').textContent = String(strategies.length || 7);
    if (byId('btcEngine')) byId('btcEngine').textContent = title(btc.engineState);
    if (byId('btcPrice')) byId('btcPrice').textContent = money(prices.mark ?? prices.last);
    if (byId('btcFeed')) byId('btcFeed').textContent = feedHealthy ? (btc.feed?.derivativesHealthy ? 'Perp healthy' : 'Spot fallback') : 'Blocked';
    if (byId('btcRegime')) byId('btcRegime').textContent = btc.regime ? `${title(btc.regime.direction)} / ${title(btc.regime.volatility)}` : '—';
    if (byId('btcActivePnl')) byId('btcActivePnl').textContent = money(portfolio.activePnlUsd || 0);
    if (byId('btcRealizedPnl')) byId('btcRealizedPnl').textContent = money(portfolio.realizedPnlUsd || 0);
    if (byId('btcNotional')) byId('btcNotional').textContent = compactMoney(portfolio.activeNotionalUsd || 0);
    if (byId('btcLeverage')) byId('btcLeverage').textContent = `${number(portfolio.weightedLeverage || 0, 1)}x`;
    if (byId('btcHomeStatus')) {
      byId('btcHomeStatus').textContent = feedHealthy
        ? `${title(btc.engineState)} — ${money(prices.mark ?? prices.last)} — ${actionable.length} actionable / ${research.length} research active`
        : `Feed blocked — ${(btc.feed?.blockers || []).join('; ') || 'waiting for market data'}`;
    }

    const callList = byId('btcCallList');
    if (callList) {
      const ordered = [...actionable, ...research];
      callList.innerHTML = ordered.length
        ? ordered.map(callCard).join('')
        : '<div class="btcEmpty"><div><strong>No active BTC calls.</strong><p>Seven strategies are scanning. A call only opens after its entry zone, risk, liquidation, cost, portfolio, and data-quality conditions all pass.</p></div></div>';
    }

    if (byId('btcWinnerCount')) byId('btcWinnerCount').textContent = String(winners.length);
    if (byId('btcLoserCount')) byId('btcLoserCount').textContent = String(losers.length);
    if (byId('btcWinnerList')) byId('btcWinnerList').innerHTML = winners.length ? winners.map(resultRow).join('') : '<div class="empty">No completed BTC winners yet.</div>';
    if (byId('btcLoserList')) byId('btcLoserList').innerHTML = losers.length ? losers.map(resultRow).join('') : '<div class="empty">No completed BTC losses yet.</div>';
    const decided = winners.length + losers.length;
    if (byId('btcResultStats')) byId('btcResultStats').innerHTML = [
      stat('Decided calls', String(decided)),
      stat('Win rate', decided ? `${number(winners.length / decided * 100, 1)}%` : '—'),
      stat('Actionable realized', money(portfolio.realizedPnlUsd || 0)),
      stat('Total net P&L', money(portfolio.totalNetPnlUsd || 0)),
      stat('Calls today', String(portfolio.callsToday || 0)),
      stat('Hypothetical equity', money(portfolio.hypotheticalEquityUsd || 100)),
    ].join('');

    if (byId('btcStrategyList')) byId('btcStrategyList').innerHTML = strategies.length
      ? strategies.map(strategyCard).join('')
      : '<div class="btcEmpty"><div><strong>Strategy scorecards are initializing.</strong><p>Performance appears after PostgreSQL strategy registration and the first platform refresh.</p></div></div>';

    const candidates = Array.isArray(btc.latestCandidates) ? btc.latestCandidates : [];
    if (byId('btcSetup')) byId('btcSetup').textContent = JSON.stringify({
      engineState: btc.engineState,
      regime: btc.regime,
      feed: btc.feed,
      actionableActive: actionable.map(call => ({ id: call.id, strategy: call.strategyId, direction: call.direction, leverage: call.leverage, pnl: call.netPnlUsd })),
      latestCandidates: candidates.map(candidate => ({
        strategy: candidate.strategyId,
        version: candidate.strategyVersion,
        mode: candidate.mode,
        direction: candidate.direction,
        setup: candidate.setupType,
        entryZone: [candidate.entryZoneLow, candidate.entryZoneHigh],
        stop: candidate.structuralStop,
        target: candidate.initialTarget,
        leverageCap: candidate.strategyLeverageCap,
        scores: candidate.scores,
        expiresAt: new Date(candidate.expiresAt).toISOString(),
      })),
    }, null, 2);

    if (byId('btcAdminOutput')) byId('btcAdminOutput').textContent = JSON.stringify({
      paperOnly: true,
      executionEnabled: btc.executionEnabled,
      referenceVenue: btc.referenceVenue,
      engineState: btc.engineState,
      prices: btc.prices,
      feed: btc.feed,
      regime: btc.regime,
      portfolio: btc.portfolio,
      platformContract: {
        marginPerCallUsd: 100,
        maxLeverage: 50,
        defaultMinimumNetTargetUsd: 20,
        defaultMinimumNetRR: 3,
        maxActionableActiveCalls: 3,
        maxActionableNotionalUsd: 7500,
        realOrderEndpoint: false,
      },
      blockers: btc.blockers,
      updatedAt: btc.updatedAt,
    }, null, 2);
  }

  async function refresh() {
    try {
      const response = await fetch('/api/calls', { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      render(await response.json());
    } catch (error) {
      if (byId('btcHomeStatus')) byId('btcHomeStatus').textContent = `BTC status unavailable — ${error.message}`;
      if (byId('btcEngine')) byId('btcEngine').textContent = 'Unavailable';
      if (byId('btcFeed')) byId('btcFeed').textContent = 'Offline';
    }
  }

  refresh();
  const timer = setInterval(refresh, 5_000);
  window.addEventListener('pagehide', () => clearInterval(timer), { once: true });
})();
