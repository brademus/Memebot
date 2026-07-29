(() => {
  const byId = id => document.getElementById(id);
  const money = value => Number.isFinite(Number(value))
    ? `$${Number(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : '—';
  const number = (value, digits = 2) => Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : '—';
  const title = value => String(value || 'unknown').replaceAll('_', ' ').replace(/\b\w/g, character => character.toUpperCase());
  const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[character]);

  function callCard(call) {
    const open = call.status === 'open';
    const direction = String(call.direction || '').toUpperCase();
    const r = call.currentR ?? call.resultR;
    return `<article class="callCard ${open ? 'open' : ''}">
      <div class="callHead"><span class="state ${call.direction === 'long' ? 'trigger' : 'dying'}">${escapeHtml(direction)}</span><small>${escapeHtml(call.status || 'paper')}</small></div>
      <h2>BTC-USD ${escapeHtml(direction)}</h2>
      <div class="metrics">
        <div class="metric"><small>Entry</small><b>${money(call.entry)}</b></div>
        <div class="metric"><small>Current / exit</small><b>${money(call.currentPrice ?? call.exitPrice)}</b></div>
        <div class="metric"><small>Stop</small><b>${money(call.stop)}</b></div>
        <div class="metric"><small>Target</small><b>${money(call.target)}</b></div>
        <div class="metric"><small>Result</small><b>${number(r)}R</b></div>
        <div class="metric"><small>Confidence</small><b>${number(call.confidence, 0)}</b></div>
      </div>
      <p class="callReason">${escapeHtml(call.exitReason || 'Regime-filtered high-volume momentum retest — paper call only.')}</p>
      <small>${escapeHtml(new Date(call.openedAt).toLocaleString())} · ${escapeHtml(call.strategyVersion || '')}</small>
    </article>`;
  }

  function render(payload) {
    const btc = payload?.btc;
    if (!btc) return;
    const calls = Array.isArray(btc.recentCalls) ? btc.recentCalls : [];
    const active = btc.activeCall;
    const feedHealthy = !!btc.feed?.healthy;
    const openCount = active ? 1 : 0;

    if (byId('nBtcCalls')) byId('nBtcCalls').textContent = String(openCount);
    if (byId('btcCallCount')) byId('btcCallCount').textContent = String(openCount);
    if (byId('btcEngine')) byId('btcEngine').textContent = title(btc.engineState);
    if (byId('btcPrice')) byId('btcPrice').textContent = money(btc.price);
    if (byId('btcFeed')) byId('btcFeed').textContent = feedHealthy ? 'Healthy' : 'Blocked';
    if (byId('btcHomeStatus')) {
      byId('btcHomeStatus').textContent = feedHealthy
        ? `${title(btc.engineState)} — ${money(btc.price)}`
        : `Feed blocked — ${(btc.feed?.blockers || []).join('; ') || 'waiting for market data'}`;
    }

    const callList = byId('btcCallList');
    if (callList) {
      callList.innerHTML = calls.length
        ? calls.map(callCard).join('')
        : '<div class="btcEmpty"><div><strong>No BTC paper calls yet.</strong><p>The engine is collecting market data and will only publish a call after regime, impulse, retest, order-flow, spread, and cross-exchange checks all pass.</p></div></div>';
    }

    const setup = byId('btcSetup');
    if (setup) {
      const current = btc.setup;
      const reasons = Array.isArray(btc.blockers) ? btc.blockers : [];
      setup.textContent = current
        ? JSON.stringify({ state: btc.engineState, direction: current.direction, impulse: current, feed: btc.feed }, null, 2)
        : JSON.stringify({ state: btc.engineState, blockers: reasons, feed: btc.feed, session: btc.session, limits: btc.limits }, null, 2);
    }

    const admin = byId('btcAdminOutput');
    if (admin) admin.textContent = JSON.stringify({
      paperOnly: true,
      strategyVersion: btc.strategyVersion,
      strategyName: btc.strategyName,
      engineState: btc.engineState,
      feed: btc.feed,
      warmup: btc.warmup,
      session: btc.session,
      limits: btc.limits,
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
