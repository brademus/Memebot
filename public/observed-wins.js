(() => {
  const byId = id => document.getElementById(id);
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]));
  const stat = (label, value) => `<div class="stat"><small>${escapeHtml(label)}</small><b>${escapeHtml(value)}</b></div>`;

  async function fetchWins() {
    const response = await fetch('/api/wins');
    if (!response.ok) throw new Error(String(response.status));
    return response.json();
  }

  function rowsFrom(data) {
    return Array.isArray(data?.wins) ? data.wins : [];
  }

  async function refreshObservedCount() {
    try {
      const rows = rowsFrom(await fetchWins());
      const tile = byId('nWins');
      if (tile) tile.textContent = String(rows.length);
    } catch {}
  }

  async function renderThreeXCalls() {
    const stats = byId('winStats');
    const list = byId('winList');
    if (!stats || !list) return;

    try {
      const data = await fetchWins();
      const rows = rowsFrom(data);
      const summary = data.summary || {};
      const verified = rows.filter(row => row.execution_eligible).length;
      const legacyObserved = rows.length - verified;
      const executableCalls = Number(summary.executable_calls || 0);
      const resolvedCalls = Number(summary.resolved_calls || 0);

      stats.innerHTML = stat('Observed 3x', rows.length)
        + stat('Jupiter-verified 3x', verified)
        + stat('Legacy observed', legacyObserved)
        + stat('Executable calls', executableCalls)
        + stat('Resolved executable', resolvedCalls);

      list.innerHTML = rows.length ? rows.map(row => {
        const verifiedLabel = row.execution_eligible
          ? 'Jupiter-verified entry'
          : 'Observed result · predates quote verification';
        const multiple = Number(row.best_multiple || 3);
        return `<div class="item">
          <span class="big">${Number.isFinite(multiple) ? multiple.toFixed(2) : '3.00'}x</span>
          <div><b>$${escapeHtml(row.symbol || '?')}</b><br><small>${escapeHtml(row.signal || 'call')} · ${escapeHtml(verifiedLabel)} · ${new Date(row.entry_at).toLocaleString()}</small></div>
          <span>score ${escapeHtml(row.entry_score || '—')}</span>
          <a target="_blank" rel="noopener" href="https://dexscreener.com/solana/${encodeURIComponent(row.ca)}">chart</a>
        </div>`;
      }).join('') : '<div class="empty">No observed call has reached 3x yet.</div>';

      const tile = byId('nWins');
      if (tile) tile.textContent = String(rows.length);
    } catch {
      list.innerHTML = '<div class="empty">3x call history could not be loaded.</div>';
    }
  }

  // Replace the original executable-only renderer while preserving the stricter
  // Jupiter evidence as a separate, explicitly labeled subset.
  window.loadWins = renderThreeXCalls;
  document.querySelectorAll('[data-go="wins"]').forEach(button => {
    button.addEventListener('click', () => setTimeout(renderThreeXCalls, 0));
  });

  refreshObservedCount();
  setInterval(refreshObservedCount, 10_000);
})();
