const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]));

const fmt = value => {
  const number = Number(value) || 0;
  return number >= 1e9 ? `${(number / 1e9).toFixed(1)}B`
    : number >= 1e6 ? `${(number / 1e6).toFixed(1)}M`
      : number >= 1e3 ? `${(number / 1e3).toFixed(0)}K`
        : Math.round(number).toString();
};
const money = value => {
  const number = Number(value) || 0;
  const sign = number > 0 ? '+' : number < 0 ? '−' : '';
  return `${sign}$${Math.abs(number).toFixed(Math.abs(number) >= 100 ? 0 : 2)}`;
};
const percent = value => value == null ? '—' : `${Number(value) > 0 ? '+' : ''}${Number(value).toFixed(1)}%`;
const price = value => {
  const number = Number(value) || 0;
  if (!number) return '—';
  if (number >= 1) return `$${number.toFixed(3)}`;
  if (number >= 0.01) return `$${number.toFixed(5)}`;
  return `$${number.toPrecision(4)}`;
};
const stat = (label, value, className = '') => `<div class="stat ${className}"><small>${esc(label)}</small><b>${esc(value)}</b></div>`;
const chartUrl = item => `https://dexscreener.com/solana/${encodeURIComponent(item.pair || item.ca)}`;

let live = { tokens: [], scans: [], seenFeed: [] };
let stats = {};
let best = [];
let callsData = {
  summary: {}, current: [], winners: [], losers: [], unresolved: [], normalizedStakeUsd: 100,
};
let filter = 'ALL';
let sound = false;
let previousCalls = new Set();
let previousConvictions = new Set();
let lastToolText = '';

const views = [...document.querySelectorAll('.view')];
function go(name) {
  views.forEach(view => view.classList.toggle('active', view.id === name));
  $('back').classList.toggle('hidden', name === 'home');
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (name === 'watchlist') renderWatch();
  if (name === 'convictions') renderConvictions();
  if (name === 'calls') renderCalls();
  if (name === 'results') renderResults();
}
document.querySelectorAll('[data-go]').forEach(button => {
  button.onclick = () => go(button.dataset.go);
});

$('sound').onclick = () => {
  sound = !sound;
  $('sound').textContent = sound ? 'Sound on' : 'Sound off';
  if (sound) ding(true);
};
function ding(big = false) {
  if (!sound) return;
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return;
  const context = new AudioContextClass();
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.frequency.value = big ? 660 : 880;
  gain.gain.value = 0.12;
  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start();
  gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.45);
  oscillator.stop(context.currentTime + 0.45);
}

async function json(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(String(response.status));
  return response.json();
}

async function adminJson(url, options = {}) {
  let key = sessionStorage.getItem('memewatchAdminKey') || '';
  if (!key) key = window.prompt('Enter the MEMEWATCH admin key:') || '';
  if (!key) throw new Error('admin key required');
  const headers = { ...(options.headers || {}), 'x-admin-key': key };
  const response = await fetch(url, { ...options, headers });
  if (response.status === 401 || response.status === 503) {
    sessionStorage.removeItem('memewatchAdminKey');
    throw new Error(response.status === 503 ? 'ADMIN_KEY is not configured on the server' : 'invalid admin key');
  }
  if (!response.ok) throw new Error(String(response.status));
  sessionStorage.setItem('memewatchAdminKey', key);
  return response.json();
}

function connect() {
  const stream = new EventSource('/api/stream');
  stream.onopen = () => {
    $('connDot').className = 'on';
    $('connText').textContent = 'live';
  };
  stream.onmessage = event => {
    try {
      live = JSON.parse(event.data);
      renderWatch();
      renderConvictions();
    } catch {}
  };
  stream.onerror = () => {
    $('connDot').className = '';
    $('connText').textContent = 'reconnecting';
    stream.close();
    setTimeout(connect, 3000);
  };
}

async function refresh() {
  const requests = await Promise.allSettled([
    json('/api/stats'),
    json('/api/bestbuys'),
    json('/api/calls'),
  ]);
  if (requests[0].status === 'fulfilled') stats = requests[0].value;
  if (requests[1].status === 'fulfilled') best = requests[1].value.buys || [];
  if (requests[2].status === 'fulfilled') callsData = requests[2].value;
  renderAll();
}

function renderAll() {
  renderWatch();
  renderConvictions();
  renderCalls();
  renderResults();
  $('nWatch').textContent = fmt(stats.liveWatchlist ?? live.tokens.length);
  const closedPnl = Number(callsData.summary?.closedPnlUsd || 0);
  $('nPnl').textContent = money(closedPnl);
  $('nPnl').classList.toggle('positive', closedPnl > 0);
  $('nPnl').classList.toggle('negative', closedPnl < 0);
}

function alertedContracts() {
  return new Set([
    ...(callsData.current || []),
    ...(callsData.winners || []),
    ...(callsData.losers || []),
    ...(callsData.unresolved || []),
  ].map(call => call.ca));
}

const laneName = lane => ({
  smart: 'Smart-wallet conviction',
  pregrad: 'Pre-graduation conviction',
  secondwave: 'Second-wave conviction',
  organic: 'Organic conviction',
}[lane] || 'Conviction');

function convictionRows() {
  const alerted = alertedContracts();
  return best
    .filter(item => !alerted.has(item.ca))
    .map(item => ({ ...live.tokens.find(token => token.ca === item.ca), ...item }))
    .sort((left, right) => (right.score || 0) - (left.score || 0));
}

function convictionCard(card) {
  const cautions = card.cautions?.length
    ? `<p class="negative">Watch: ${card.cautions.map(esc).join(' · ')}</p>` : '';
  return `<article class="card convictionCard">
    <div class="cardTop"><span class="badge">${esc(laneName(card.lane))}</span><span class="coin">$${esc(card.symbol || '?')}</span><span class="score">${Math.round(card.score || 0)}</span></div>
    <div class="pendingCall"><i></i><b>Waiting for buy-alert timing</b></div>
    <p class="proof">${esc(card.label || 'The token is strong enough to prepare, but the entry trigger has not fired.')}</p>
    <div class="metrics">
      <div class="metric"><small>Grade</small><b>${esc(card.grade || card.rank?.grade || '—')}</b></div>
      <div class="metric"><small>Timing</small><b>${esc(card.timing || card.rank?.timing || 'Watching')}</b></div>
      <div class="metric"><small>Liquidity</small><b>$${fmt(card.liq)}</b></div>
      <div class="metric"><small>Buy / Sell</small><b>${card.buys || 0}:${card.sells || 0}</b></div>
      <div class="metric"><small>Smart wallets</small><b>${card.smart || 0}</b></div>
      <div class="metric"><small>Held in slot</small><b>${card.heldMin || 0}m</b></div>
    </div>
    ${cautions}
    <div class="links"><a target="_blank" rel="noopener" href="${chartUrl(card)}">Chart</a><a target="_blank" rel="noopener" href="https://solscan.io/token/${encodeURIComponent(card.ca)}">Contract</a></div>
  </article>`;
}

function renderConvictions() {
  const rows = convictionRows();
  $('nConvictions').textContent = rows.length;
  $('convictionCount').textContent = rows.length;
  const smart = rows.filter(row => row.lane === 'smart').length;
  const avgScore = rows.length ? Math.round(rows.reduce((sum, row) => sum + Number(row.score || 0), 0) / rows.length) : null;
  $('convictionStats').innerHTML = stat('Preparing', rows.length)
    + stat('Smart-wallet sourced', smart)
    + stat('Average score', avgScore ?? '—')
    + stat('Status', rows.length ? 'Waiting for trigger' : 'No pending call');
  $('convictionList').innerHTML = rows.length
    ? rows.map(convictionCard).join('')
    : '<div class="empty">No coin is waiting in conviction right now. The bot is still monitoring the watchlist.</div>';

  const current = new Set(rows.map(row => row.ca));
  for (const ca of current) if (!previousConvictions.has(ca)) ding();
  previousConvictions = current;
}

function renderWatch() {
  const rows = (live.tokens || []).filter(token => filter === 'ALL' || token.state === filter);
  $('watchCount').textContent = live.tokens?.length || 0;
  $('watchRows').innerHTML = rows.length ? rows.map(token => `<tr>
    <td><b>$${esc(token.symbol)}</b><br><small class="muted">${esc(token.name || '').slice(0, 22)}${token.source === 'wallet' ? ' · wallet' : ''}</small></td>
    <td><span class="state ${esc(token.state)}">${esc(token.state)}</span></td>
    <td>${Math.round(token.score || 0)}</td><td>${token.ageMin || 0}m</td><td>$${fmt(token.liq)}</td>
    <td class="${token.buys > token.sells ? 'positive' : token.buys < token.sells ? 'negative' : ''}">${token.buys || 0}:${token.sells || 0}</td>
    <td class="${token.chg5m >= 0 ? 'positive' : 'negative'}">${token.chg5m > 0 ? '+' : ''}${token.chg5m || 0}%</td>
    <td class="${token.movedPct >= 0 ? 'positive' : 'negative'}">${token.movedPct > 0 ? '+' : ''}${token.movedPct || 0}%</td>
    <td>${token.smart || '—'}</td><td><a target="_blank" rel="noopener" href="${chartUrl(token)}">chart</a></td>
  </tr>`).join('') : '<tr><td colspan="10" class="muted">No matching live coins.</td></tr>';
}
document.querySelectorAll('[data-filter]').forEach(button => {
  button.onclick = () => {
    filter = button.dataset.filter;
    document.querySelectorAll('[data-filter]').forEach(item => item.classList.toggle('on', item === button));
    renderWatch();
  };
});

function executionLabel(call) {
  if (call.executionEligible) return 'Jupiter entry verified';
  if (call.quoteStatus === 'quote_pending') return 'Entry quote pending';
  return 'Market-price paper entry';
}

function callCard(call, resolved = false) {
  const pnlClass = call.pnlPct > 0 ? 'positive' : call.pnlPct < 0 ? 'negative' : '';
  const outcome = resolved ? (call.status === 'win' ? 'WIN' : 'LOSS') : 'OPEN CALL';
  const reason = resolved && call.exitReason ? `<small class="exitReason">Closed: ${esc(call.exitReason.replaceAll('_', ' '))}</small>` : '';
  return `<article class="callCard ${esc(call.status)}">
    <div class="callTop"><span class="badge ${call.status === 'win' ? 'winBadge' : call.status === 'loss' ? 'lossBadge' : ''}">${outcome}</span><span class="coin">$${esc(call.symbol)}</span><span class="callPnl ${pnlClass}">${percent(call.pnlPct)}</span></div>
    <div class="dollarPnl ${pnlClass}">${money(call.normalizedPnlUsd)} <small>on hypothetical $${call.normalizedStakeUsd}</small></div>
    <div class="metrics compactMetrics">
      <div class="metric"><small>Alert entry</small><b>${price(call.entryPrice)}</b></div>
      <div class="metric"><small>${resolved ? 'Exit' : 'Current mark'}</small><b>${price(call.markPrice)}</b></div>
      <div class="metric"><small>Current multiple</small><b>${Number(call.multiple).toFixed(2)}x</b></div>
      <div class="metric"><small>Peak multiple</small><b>${Number(call.peakMultiple).toFixed(2)}x</b></div>
      <div class="metric"><small>Alert type</small><b>${esc(call.signal)}</b></div>
      <div class="metric"><small>Entry evidence</small><b>${esc(executionLabel(call))}</b></div>
    </div>
    <p class="callTime">Alerted ${new Date(call.entryAt).toLocaleString()}</p>${reason}
    <div class="links"><a target="_blank" rel="noopener" href="${chartUrl(call)}">Chart</a><a target="_blank" rel="noopener" href="https://solscan.io/token/${encodeURIComponent(call.ca)}">Contract</a></div>
  </article>`;
}

function renderCalls() {
  const rows = callsData.current || [];
  const summary = callsData.summary || {};
  $('nCalls').textContent = rows.length;
  $('callCount').textContent = rows.length;
  $('callStats').innerHTML = stat('Open calls', rows.length)
    + stat('Open hypothetical P&L', money(summary.openPnlUsd || 0), Number(summary.openPnlUsd) >= 0 ? 'positive' : 'negative')
    + stat('Open return', percent(summary.openReturnPct), Number(summary.openReturnPct) >= 0 ? 'positive' : 'negative')
    + stat('Comparison size', `$${callsData.normalizedStakeUsd || 100} per call`);
  $('callList').innerHTML = rows.length
    ? rows.map(row => callCard(row)).join('')
    : '<div class="empty">There are no open buy alerts right now. Convictions remain separate until an alert is actually sent.</div>';

  const current = new Set(rows.map(row => row.ca));
  for (const ca of current) if (!previousCalls.has(ca)) ding(true);
  previousCalls = current;
}

function renderResults() {
  const summary = callsData.summary || {};
  const winners = callsData.winners || [];
  const losers = callsData.losers || [];
  const unresolved = callsData.unresolved || [];
  const closedPnl = Number(summary.closedPnlUsd || 0);
  $('resultStats').innerHTML = stat('Overall hypothetical P&L', money(closedPnl), closedPnl >= 0 ? 'positive' : 'negative')
    + stat('Overall return', percent(summary.closedReturnPct), Number(summary.closedReturnPct) >= 0 ? 'positive' : 'negative')
    + stat('Win rate', summary.winRatePct == null ? '—' : `${Number(summary.winRatePct).toFixed(1)}%`)
    + stat('Wins / losses', `${winners.length} / ${losers.length}`)
    + stat('Resolved calls', summary.resolvedCalls || 0)
    + stat('Capital modeled', `$${fmt(summary.normalizedCapitalDeployedUsd || 0)}`);

  $('winnerCount').textContent = winners.length;
  $('loserCount').textContent = losers.length;
  $('winnerList').innerHTML = winners.length
    ? winners.map(row => callCard(row, true)).join('')
    : '<div class="empty">No resolved winning calls yet.</div>';
  $('loserList').innerHTML = losers.length
    ? losers.map(row => callCard(row, true)).join('')
    : '<div class="empty">No resolved losing calls yet.</div>';

  $('unresolvedNote').classList.toggle('hidden', !unresolved.length);
  $('unresolvedNote').textContent = unresolved.length
    ? `${unresolved.length} call${unresolved.length === 1 ? '' : 's'} lost reliable price tracking and are excluded from P&L and win-rate calculations.` : '';
}

async function copyToolText() {
  if (!lastToolText) return;
  try {
    await navigator.clipboard.writeText(lastToolText);
    $('copyTool').textContent = 'Copied ✓';
    setTimeout(() => { $('copyTool').textContent = 'Copy'; }, 1800);
  } catch {
    $('copyTool').textContent = 'Select text below';
  }
}
$('copyTool').onclick = copyToolText;

async function runTool(url, loading, autoCopy = false) {
  const output = $('toolOutput');
  output.textContent = loading;
  $('copyTool').classList.add('hidden');
  try {
    const data = await adminJson(url);
    lastToolText = data.review || data.read || JSON.stringify(data, null, 2);
    output.textContent = lastToolText;
    $('copyTool').classList.remove('hidden');
    if (autoCopy) await copyToolText();
  } catch (error) {
    lastToolText = '';
    output.textContent = `Request failed: ${error.message}`;
  }
  output.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

$('report').onclick = () => runTool('/api/report?days=7', 'Building the private weekly report…', true);
$('aiReview').onclick = () => runTool('/api/ai-review', 'Running the private AI review…');
$('systemMonitor').onclick = () => runTool('/api/system-monitor', 'Reading the private system state…');
$('walletDebug').onclick = () => runTool('/api/wallet-debug', 'Inspecting wallet intelligence…');
$('runDiscovery').onclick = () => runTool('/api/discover', 'Running winner-first wallet discovery…');
$('activityMine').onclick = () => runTool('/api/wallet-activity-mine', 'Finding heavily active Pump.fun wallets and validating realized profitability…');
$('walletRankings').onclick = () => runTool('/api/wallet-rankings', 'Loading wallet rankings…');
$('clearAdminKey').onclick = () => {
  sessionStorage.removeItem('memewatchAdminKey');
  lastToolText = '';
  $('toolOutput').textContent = 'Admin key cleared from this browser session.';
  $('copyTool').classList.add('hidden');
};

connect();
refresh();
setInterval(refresh, 10_000);
go('home');
