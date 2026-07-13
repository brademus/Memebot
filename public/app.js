const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));
const fmt = value => {
  const n = Number(value) || 0;
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M`
    : n >= 1e3 ? `${(n / 1e3).toFixed(0)}K`
    : Math.round(n).toString();
};
const stat = (label, value) => `<div class="stat"><small>${esc(label)}</small><b>${esc(value)}</b></div>`;

let live = { tokens: [], scans: [], seenFeed: [] };
let stats = {};
let analytics = {};
let best = [];
let filter = 'ALL';
let histOffset = 0;
let sound = false;
let previousOpportunities = new Set();

const views = [...document.querySelectorAll('.view')];
function go(name) {
  views.forEach(view => view.classList.toggle('active', view.id === name));
  $('back').classList.toggle('hidden', name === 'home');
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (name === 'wins') loadWins();
  if (name === 'wallets') loadAnalytics();
  if (name === 'performance') loadPerformance();
  if (name === 'scanned') renderScanned();
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
  const Audio = window.AudioContext || window.webkitAudioContext;
  const context = new Audio();
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

async function adminJson(url) {
  let key = sessionStorage.getItem('memewatchAdminKey') || '';
  if (!key) key = window.prompt('Enter the MEMEWATCH admin key for this private diagnostic:') || '';
  if (!key) throw new Error('admin key required');
  const response = await fetch(url, { headers: { 'x-admin-key': key } });
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
    live = JSON.parse(event.data);
    renderLive();
  };
  stream.onerror = () => {
    $('connDot').className = '';
    $('connText').textContent = 'reconnecting';
    stream.close();
    setTimeout(connect, 3000);
  };
}

async function refresh() {
  try {
    stats = await json('/api/stats');
    $('nWatch').textContent = fmt(stats.liveWatchlist ?? stats.watching);
    $('nSeen').textContent = fmt(stats.seen);
    $('nKilled').textContent = fmt(stats.killed ?? stats.gatedOut);
  } catch {}
  try {
    best = (await json('/api/bestbuys')).buys || [];
    renderOpportunities();
  } catch {}
  try {
    analytics = await json('/api/analytics');
    $('nWallets').textContent = fmt(analytics.activeWallets ?? analytics.topWallets?.filter(w => w.active).length);
  } catch {}
  try {
    const wins = await json('/api/wins');
    $('nWins').textContent = fmt(wins.summary?.won_3x ?? wins.wins?.filter(w => w.execution_eligible).length);
  } catch {}
}

const laneName = lane => ({
  smart: 'Smart wallet',
  pregrad: 'Pre-graduation',
  secondwave: 'Second wave',
  organic: 'Organic',
}[lane] || 'Opportunity');

function mergedOpportunities() {
  const map = new Map();
  for (const token of live.tokens.filter(t => t.conviction && !['DYING', 'DEAD', 'EXTENDED'].includes(t.state))) {
    map.set(token.ca, {
      ...token,
      category: 'confirmed',
      laneLabel: 'Confirmed conviction',
      grade: token.rank?.grade || 'A',
      label: token.aiNote || token.rank?.label || 'All conviction checks are currently passing.',
      cautions: token.rank?.cautions || [],
      strict: true,
    });
  }
  for (const opportunity of best) {
    const token = live.tokens.find(t => t.ca === opportunity.ca) || {};
    const confirmed = map.get(opportunity.ca);
    if (confirmed) {
      map.set(opportunity.ca, {
        ...token,
        ...opportunity,
        ...confirmed,
        laneLabel: `Confirmed · ${laneName(opportunity.lane)}`,
        strict: true,
        category: 'confirmed',
      });
    } else {
      map.set(opportunity.ca, {
        ...token,
        ...opportunity,
        laneLabel: laneName(opportunity.lane),
        strict: false,
        category: 'early',
      });
    }
  }
  return [...map.values()].sort((a, b) => Number(b.strict) - Number(a.strict) || (b.score || 0) - (a.score || 0));
}

function opportunityCard(card) {
  return `<article class="card ${card.strict ? 'hot' : ''}">
    <div class="cardTop"><span class="badge ${card.strict ? 'hot' : ''}">${esc(card.laneLabel)}</span><span class="coin">$${esc(card.symbol || '?')}</span><span class="score">${Math.round(card.score || 0)}</span></div>
    <p class="proof">${esc(card.label || 'This token currently holds one of the bot’s strongest opportunity slots.')}</p>
    <div class="metrics">
      <div class="metric"><small>Status</small><b>${card.strict ? 'Triggered + confirmed' : 'Not yet triggered'}</b></div>
      <div class="metric"><small>Grade</small><b>${esc(card.grade || card.rank?.grade || '—')}</b></div>
      <div class="metric"><small>Liquidity</small><b>$${fmt(card.liq)}</b></div>
      <div class="metric"><small>Buy / Sell</small><b>${card.buys || 0}:${card.sells || 0}</b></div>
      <div class="metric"><small>Smart wallets</small><b>${card.smart || 0}</b></div>
    </div>
    ${card.cautions?.length ? `<p class="negative">Watch: ${card.cautions.map(esc).join(' · ')}</p>` : ''}
    <div class="links"><a target="_blank" rel="noopener" href="https://dexscreener.com/solana/${card.pair || card.ca}">Chart</a><a target="_blank" rel="noopener" href="https://jup.ag/swap/SOL-${card.ca}">Swap</a><a target="_blank" rel="noopener" href="https://solscan.io/token/${card.ca}">Contract</a></div>
  </article>`;
}

function renderOpportunities() {
  const list = mergedOpportunities();
  const confirmed = list.filter(item => item.strict);
  const early = list.filter(item => !item.strict);
  $('nOpp').textContent = list.length;
  $('oppCount').textContent = list.length;
  const current = new Set(list.map(item => item.ca));
  for (const ca of current) if (!previousOpportunities.has(ca)) ding(true);
  previousOpportunities = current;

  let html = '';
  html += `<h3 style="grid-column:1/-1">Confirmed convictions (${confirmed.length})</h3>`;
  html += confirmed.length ? confirmed.map(opportunityCard).join('') : '<div class="empty">No trigger-based conviction is active right now.</div>';
  html += `<h3 style="grid-column:1/-1">Early opportunities (${early.length})</h3>`;
  html += early.length ? early.map(opportunityCard).join('') : '<div class="empty">No earlier Best Buy lane is active right now.</div>';
  $('oppList').innerHTML = html;
}

function renderLive() {
  renderOpportunities();
  renderWatch();
  renderScanned();
}

function renderWatch() {
  const rows = live.tokens.filter(token => filter === 'ALL' || token.state === filter);
  $('watchRows').innerHTML = rows.length ? rows.map(token => `<tr>
    <td>$${esc(token.symbol)}<br><small class="muted">${esc(token.name || '').slice(0, 18)}</small></td>
    <td><span class="state ${token.state}">${esc(token.state)}</span></td>
    <td>${Math.round(token.score || 0)}</td><td>${token.ageMin || 0}m</td><td>$${fmt(token.liq)}</td>
    <td class="${token.buys > token.sells ? 'positive' : 'negative'}">${token.buys || 0}:${token.sells || 0}</td>
    <td class="${token.chg5m >= 0 ? 'positive' : 'negative'}">${token.chg5m > 0 ? '+' : ''}${token.chg5m || 0}%</td>
    <td class="${token.movedPct >= 0 ? 'positive' : 'negative'}">${token.movedPct > 0 ? '+' : ''}${token.movedPct || 0}%</td>
    <td>${token.smart || '—'}</td><td><a target="_blank" rel="noopener" href="https://dexscreener.com/solana/${token.pair || token.ca}">chart</a></td>
  </tr>`).join('') : '<tr><td colspan="10" class="muted">No matching live coins.</td></tr>';
}
document.querySelectorAll('[data-filter]').forEach(button => {
  button.onclick = () => {
    filter = button.dataset.filter;
    document.querySelectorAll('[data-filter]').forEach(item => item.classList.toggle('on', item === button));
    renderWatch();
  };
});

async function loadWins() {
  try {
    const data = await json('/api/wins');
    const summary = data.summary || {};
    const executable = Number(summary.executable_calls || 0);
    const resolved = Number(summary.resolved_calls || 0);
    const hits = Number(summary.won_3x || 0);
    $('winStats').innerHTML = stat('Executable calls', executable)
      + stat('Resolved', resolved)
      + stat('Hit 3x', hits)
      + stat('Resolved hit rate', resolved ? `${Math.round(100 * hits / resolved)}%` : '—');
    const wins = (data.wins || []).filter(win => win.execution_eligible);
    $('winList').innerHTML = wins.length ? wins.map(win => `<div class="item">
      <span class="big">${Number(win.best_multiple || 3).toFixed(2)}x</span>
      <div><b>$${esc(win.symbol || '?')}</b><br><small>${esc(win.signal)} · ${new Date(win.entry_at).toLocaleString()}</small></div>
      <span>score ${win.entry_score || '—'}</span><a target="_blank" rel="noopener" href="https://dexscreener.com/solana/${win.ca}">chart</a>
    </div>`).join('') : '<div class="empty">No executable entry has reached 3x yet.</div>';
  } catch {
    $('winList').innerHTML = '<div class="empty">Executable call evidence could not be loaded.</div>';
  }
}

async function loadAnalytics() {
  try {
    analytics = await json('/api/analytics');
    const wallets = analytics.topWallets || [];
    const days = wallets.map(wallet => wallet.day).filter(Boolean);
    const pnl = days.reduce((sum, day) => sum + Number(day.realizedPnlSol || 0), 0);
    $('walletStats').innerHTML = stat('Tracking', analytics.activeWallets ?? wallets.filter(w => w.active).length)
      + stat('Active today', analytics.walletsActiveToday ?? wallets.filter(w => Number(w.hours_since_active) < 24).length)
      + stat('Measured P&L today', `${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} SOL`)
      + stat('Wallets sampled', days.length);
    $('walletList').innerHTML = wallets.length ? wallets.map(wallet => {
      const short = `${wallet.wallet.slice(0, 5)}…${wallet.wallet.slice(-5)}`;
      const pnlToday = wallet.day?.measured ? Number(wallet.day.realizedPnlSol) : null;
      return `<div class="item"><span class="big ${pnlToday === null ? 'muted' : pnlToday >= 0 ? 'positive' : 'negative'}">${pnlToday === null ? '—' : `${pnlToday >= 0 ? '+' : ''}${pnlToday.toFixed(2)} SOL`}</span><div><b>${short}</b><br><small>${wallet.quality_verdict || 'UNRATED'} · ${Math.round(Number(wallet.win_rate || 0) * 100)}% historical win rate</small></div><span>${wallet.winners_hit || 0} winners · ${wallet.wins_2x || 0} measured 2x</span><a target="_blank" rel="noopener" href="https://solscan.io/account/${wallet.wallet}">solscan</a></div>`;
    }).join('') : '<div class="empty">No qualified wallets are being tracked yet.</div>';
  } catch {
    $('walletList').innerHTML = '<div class="empty">Wallet analytics could not be loaded.</div>';
  }
}

async function loadPerformance() {
  try {
    const [missed, currentStats, evidence] = await Promise.all([
      json('/api/missed'),
      json('/api/stats'),
      json('/api/evidence?days=30'),
    ]);
    $('perfStats').innerHTML = stat('Triggers 24h', currentStats.triggers24h || 0)
      + stat('Confirmed 24h', currentStats.confirmedConvictions24h || 0)
      + stat('Live early slots', currentStats.liveOpportunitySlots || 0)
      + stat('Lifetime triggers', currentStats.triggeredTotal || 0);
    const lanes = evidence.lanes || [];
    $('evidence').innerHTML = lanes.length ? lanes.map(lane => `<div class="item">
      <span class="big">${lane.pct_3x_executable == null ? '—' : `${lane.pct_3x_executable}%`}</span>
      <div><b>${esc(lane.signal)}</b><br><small>${esc(lane.evidence_status)}</small></div>
      <span>${lane.hits_3x || 0} hits · ${lane.resolved_executable || 0} resolved</span>
    </div>`).join('') : '<div class="empty">Executable forward evidence is still collecting.</div>';
    $('missed').innerHTML = (missed.misses || []).map(item => `<div class="item"><span class="big negative">${esc(item.peak)}</span><div><b>$${esc(item.symbol)}</b><br><small>${esc(item.whyMissed)}</small></div><span>${esc(item.now || '')}</span></div>`).join('') || '<div class="empty">No 5x misses found in the current window.</div>';
  } catch {
    $('evidence').innerHTML = '<div class="empty">Performance evidence could not be loaded.</div>';
  }
}

function renderScanned() {
  const seen = live.seenFeed || [];
  $('seenFeed').innerHTML = seen.length ? seen.map(item => `<div class="feedItem"><b>$${esc(item.symbol)}</b><small>${esc(item.status)} · ${item.ageMin || 0}m</small></div>`).join('') : '<div class="empty">Waiting for token feed.</div>';
  $('scanFeed').innerHTML = (live.scans || []).map(scan => `<div class="item"><span class="big ${scan.verdict === 'PASS' ? 'positive' : 'negative'}">${esc(scan.verdict)}</span><div><b>$${esc(scan.symbol)}</b><br><small>${esc(scan.reason || 'passed all gates')}</small></div><span>${Math.max(0, Math.round((Date.now() - scan.at) / 60000))}m ago</span></div>`).join('');
}

$('loadHistory').onclick = async () => {
  try {
    const data = await json(`/api/history?offset=${histOffset}`);
    $('history').insertAdjacentHTML('beforeend', (data.rows || []).map(row => `<div class="item"><span class="big ${row.gate_result === 'passed' ? 'positive' : 'negative'}">${row.gate_result === 'passed' ? 'PASS' : row.gate_result === 'failed' ? 'KILL' : '—'}</span><div><b>$${esc(row.symbol || '?')}</b><br><small>${new Date(row.first_seen).toLocaleString()} · ${esc(row.gate_fail_reason || row.last_state || '')}</small></div><a target="_blank" rel="noopener" href="https://dexscreener.com/solana/${row.ca}">chart</a></div>`).join(''));
    histOffset += (data.rows || []).length;
    $('loadHistory').textContent = (data.rows || []).length < 500 ? 'All loaded' : 'Load 500 more';
  } catch {
    $('loadHistory').textContent = 'History failed';
  }
};

async function runTool(url, loading) {
  const output = $('toolOutput');
  output.classList.remove('hidden');
  output.textContent = loading;
  try {
    const data = await adminJson(url);
    output.textContent = data.review || data.read || JSON.stringify(data, null, 2);
  } catch (error) {
    output.textContent = `Request failed: ${error.message}`;
  }
  output.scrollIntoView({ behavior: 'smooth' });
}
$('report').onclick = () => runTool('/api/report', 'Building private weekly report…');
$('aiReview').onclick = () => runTool('/api/ai-review', 'Running private AI review…');
$('systemMonitor').onclick = () => runTool('/api/system-monitor', 'Reading private system state…');

connect();
refresh();
setInterval(refresh, 10_000);
go('home');
