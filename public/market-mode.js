(() => {
  const STORAGE_KEY = 'memewatchDashboardMarket';
  const validModes = new Set(['memecoins', 'btc']);
  const brand = document.querySelector('.brand');
  const back = document.getElementById('back');
  const themeMeta = document.querySelector('meta[name="theme-color"]');
  const modeButtons = [...document.querySelectorAll('[data-market-mode]')];
  const baseGo = typeof window.go === 'function' ? window.go.bind(window) : null;

  let market = 'memecoins';
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (validModes.has(saved)) market = saved;
  } catch {}

  const homeForMarket = () => market === 'btc' ? 'btcHome' : 'home';

  function openView(target) {
    const resolved = target === 'home' ? homeForMarket() : target;
    if (baseGo) {
      baseGo(resolved);
    } else {
      document.querySelectorAll('.view').forEach(view => view.classList.toggle('active', view.id === resolved));
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
    if (back) {
      back.classList.toggle('hidden', resolved === homeForMarket());
      back.textContent = market === 'btc' ? '← Bitcoin Dashboard' : '← Dashboard';
    }
  }

  function bindNavigation() {
    document.querySelectorAll('[data-go]').forEach(button => {
      button.onclick = () => openView(button.dataset.go || 'home');
    });
  }

  function applyMarket(nextMarket, navigateHome = true) {
    market = validModes.has(nextMarket) ? nextMarket : 'memecoins';
    document.body.dataset.market = market;

    modeButtons.forEach(button => {
      const active = button.dataset.marketMode === market;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });

    if (market === 'btc') {
      if (brand) brand.innerHTML = '<span>BTC</span>WATCH';
      document.title = 'BTCWATCH — Bitcoin Dashboard';
      if (themeMeta) themeMeta.setAttribute('content', '#05070f');
    } else {
      if (brand) brand.innerHTML = '<span>MEME</span>WATCH';
      document.title = 'MEMEWATCH';
      if (themeMeta) themeMeta.setAttribute('content', '#07090d');
    }

    try { localStorage.setItem(STORAGE_KEY, market); } catch {}
    if (navigateHome) openView('home');
  }

  modeButtons.forEach(button => {
    button.onclick = () => applyMarket(button.dataset.marketMode || 'memecoins');
  });

  bindNavigation();
  applyMarket(market);
})();
