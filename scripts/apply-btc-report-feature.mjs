// One-time source integration; removed after the generated source commit lands.
import fs from 'node:fs';

function read(path) {
  return fs.readFileSync(path, 'utf8');
}

function write(path, value) {
  fs.writeFileSync(path, value);
}

function replaceOnce(path, source, target) {
  const value = read(path);
  if (value.includes(target)) return;
  if (!value.includes(source)) throw new Error(`${path}: patch marker not found`);
  write(path, value.replace(source, target));
}

replaceOnce(
  'src/api/server.ts',
  "import { reportJobs } from './report-jobs';",
  "import { reportJobs } from './report-jobs';\nimport { btcReportJobs } from './btc-report-jobs';",
);

const btcRoutes = `  app.post('/api/btc-review-jobs', expensiveApiLimit, adminOnly, (req, res) => {
    const days = Math.min(3650, Math.max(1, parseInt(String(req.query.days || '3650'), 10) || 3650));
    res.status(202).json(btcReportJobs.start(days));
  });

  app.get('/api/btc-review-jobs/:id/chunks/:index', adminOnly, (req, res) => {
    const index = parseInt(req.params.index, 10);
    const chunk = btcReportJobs.getChunk(req.params.id, index);
    if (!chunk) {
      res.status(404).json({ error: 'BTC report chunk is unavailable or the report job expired' });
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.json(chunk);
  });

  app.get('/api/btc-review-jobs/:id', adminOnly, (req, res) => {
    const job = btcReportJobs.get(req.params.id);
    if (!job) {
      res.status(404).json({ error: 'BTC report job was not found or expired' });
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.json(job);
  });

`;
replaceOnce(
  'src/api/server.ts',
  "  app.get('/api/wallet-rankings', async (_req, res) => {",
  `${btcRoutes}  app.get('/api/wallet-rankings', async (_req, res) => {`,
);

const entryTelemetry = `      entrySellAbsorptionScore: context.orderFlow.sellAbsorptionScore ?? null,
      entryLastPrice: context.prices.last,
      entryBidPrice: context.prices.bid,
      entryAskPrice: context.prices.ask,
      entryMarkPrice: context.prices.mark,
      entryIndexPrice: context.prices.index,
      entryCoinbaseSpot: context.prices.coinbaseSpot,
      entryKrakenSpot: context.prices.krakenSpot,
      entryConsolidatedFair: context.prices.consolidatedFair,
      entryFundingRate: context.derivatives.fundingRate,
      entryPredictedFundingRate: context.derivatives.predictedFundingRate,
      entryNextFundingAt: context.derivatives.nextFundingAt,
      entryOpenInterest: context.derivatives.openInterest,
      entryOpenInterestValue: context.derivatives.openInterestValue,
      entryOpenInterestChangePct: context.derivatives.openInterestChangePct,
      entryLongLiquidationUsd5m: context.derivatives.longLiquidationUsd5m,
      entryShortLiquidationUsd5m: context.derivatives.shortLiquidationUsd5m,
      entryBasisBps: context.derivatives.basisBps,
      entryAggressiveBuyUsd1m: context.orderFlow.aggressiveBuyUsd1m,
      entryAggressiveSellUsd1m: context.orderFlow.aggressiveSellUsd1m,
      entryAggressiveBuyUsd5m: context.orderFlow.aggressiveBuyUsd5m,
      entryAggressiveSellUsd5m: context.orderFlow.aggressiveSellUsd5m,
      entryTopBookImbalance: context.orderFlow.topBookImbalance,
      entryCrossAssetHealthy: context.crossAsset?.healthy ?? null,
      entryEthSpot: context.crossAsset?.ethSpot ?? null,
      entryEthReturn5mPct: context.crossAsset?.ethReturn5mPct ?? null,
      entryEthReturn15mPct: context.crossAsset?.ethReturn15mPct ?? null,
      entryBtcReturn5mPct: context.crossAsset?.btcReturn5mPct ?? null,
      entryBtcReturn15mPct: context.crossAsset?.btcReturn15mPct ?? null,
      entryRelativeReturn5mPct: context.crossAsset?.relativeReturn5mPct ?? null,
      entryRelativeReturn15mPct: context.crossAsset?.relativeReturn15mPct ?? null,`;
replaceOnce(
  'src/btc/platform/execution.ts',
  '      entrySellAbsorptionScore: context.orderFlow.sellAbsorptionScore ?? null,',
  entryTelemetry,
);

const index = read('public/index.html');
if (!index.includes('/btc-review.js')) {
  if (!index.includes('</body>')) throw new Error('public/index.html: closing body marker not found');
  write('public/index.html', index.replace(
    '</body>',
    '<script src="/btc-review.js?v=20260731-btc-trade-report" defer></script>\n</body>',
  ));
}

console.log('BTC downloadable report feature patched successfully.');
