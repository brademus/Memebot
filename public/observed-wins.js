(() => {
  const byId = id => document.getElementById(id);
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]));
  const stat = (label, value) => `<div class="stat"><small>${escapeHtml(label)}</small><b>${escapeHtml(value)}</b></div>`;

  async function fetchJson(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(String(response.status));
    return response.json();
  }
  const rowsFrom = data => Array.isArray(data?.wins) ? data.wins : [];
  const observedFrom = evidence => (evidence?.lanes || [])
    .reduce((sum, lane) => sum + Number(lane.observed_hits_3x || 0), 0);

  async function loadData() {
    const [wins, evidence] = await Promise.all([
      fetchJson('/api/wins'),
      fetchJson('/api/evidence?days=180'),
    ]);
    return { wins, evidence };
  }

  async function refreshObservedCount() {
    try {
      const { evidence } = await loadData();
      const tile = byId('nWins');
      if (tile) tile.textContent = String(observedFrom(evidence));
    } catch {}
  }

  async function renderThreeXCalls() {
    const stats = byId('winStats');
    const list = byId('winList');
    if (!stats || !list) return;
    try {
      const { wins, evidence } = await loadData();
      const rows = rowsFrom(wins);
      const summary = wins.summary || {};
      const observed = observedFrom(evidence);
      const roundTripVerified = rows.filter(row => row.execution_eligible).length;
      const legacyObserved = rows.length - roundTripVerified;
      const exitUnverified = Math.max(0, observed - rows.length);
      stats.innerHTML = stat('Observed market 3x', observed)
        + stat('Jupiter round-trip verified', roundTripVerified)
        + stat('Observed, exit unverified', exitUnverified)
        + stat('Legacy observed', legacyObserved)
        + stat('Executable entries', Number(summary.executable_calls || 0))
        + stat('Resolved executable', Number(summary.resolved_calls || 0));

      const note = exitUnverified
        ? `<div class="empty">${exitUnverified} call${exitUnverified === 1 ? '' : 's'} touched 3x on market data but did not yet clear an executable Jupiter sell quote.</div>`
        : '';
      list.innerHTML = note + (rows.length ? rows.map(row => {
        const label = row.execution_eligible
          ? 'Jupiter entry + exit verified'
          : 'Observed result · predates quote verification';
        const multiple = Number(row.best_multiple || 3);
        return `<div class="item">
          <span class="big">${Number.isFinite(multiple) ? multiple.toFixed(2) : '3.00'}x</span>
          <div><b>$${escapeHtml(row.symbol || '?')}</b><br><small>${escapeHtml(row.signal || 'call')} · ${escapeHtml(label)} · ${new Date(row.entry_at).toLocaleString()}</small></div>
          <span>score ${escapeHtml(row.entry_score || '—')}</span>
          <a target="_blank" rel="noopener" href="https://dexscreener.com/solana/${encodeURIComponent(row.ca)}">chart</a>
        </div>`;
      }).join('') : '<div class="empty">No verified or legacy observed call has reached 3x yet.</div>');
      const tile = byId('nWins');
      if (tile) tile.textContent = String(observed);
    } catch {
      list.innerHTML = '<div class="empty">3x call history could not be loaded.</div>';
    }
  }

  window.loadWins = renderThreeXCalls;
  document.querySelectorAll('[data-go="wins"]').forEach(button => {
    button.addEventListener('click', () => setTimeout(renderThreeXCalls, 0));
  });
  refreshObservedCount();
  setInterval(refreshObservedCount, 10_000);
})();
