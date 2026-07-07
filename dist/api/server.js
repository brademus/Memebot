"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.startServer = startServer;
exports.broadcast = broadcast;
const express_1 = __importDefault(require("express"));
const path_1 = __importDefault(require("path"));
const config_1 = require("../config");
const store_1 = require("../store");
const db_1 = require("../db");
const report_1 = require("./report");
const db_2 = require("../db");
const autotune_1 = require("../tuning/autotune");
const clients = new Set();
function startServer() {
    const app = (0, express_1.default)();
    app.use(express_1.default.json());
    app.use(express_1.default.static(path_1.default.join(process.cwd(), 'public')));
    // full history from Postgres (everything ever seen), cursor-paged
    app.get('/api/history', async (req, res) => {
        const before = req.query.before || null;
        const rows = await (0, db_2.fetchHistory)(before, parseInt(req.query.limit || '100', 10));
        res.json(rows);
    });
    // autotune's latest weight suggestion (apply manually in config.yaml)
    app.get('/api/tuning', (_req, res) => res.json((0, autotune_1.latestSuggestion)()));
    // smart-wallet admin — write ops require ADMIN_KEY header
    app.get('/api/wallets', async (_req, res) => res.json(await (0, db_2.listSmartWallets)()));
    app.post('/api/wallets', async (req, res) => {
        if (!config_1.env.ADMIN_KEY || req.header('x-admin-key') !== config_1.env.ADMIN_KEY)
            return res.status(401).json({ error: 'set ADMIN_KEY env var and pass x-admin-key header' });
        const { wallet, type } = req.body || {};
        if (!wallet || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet))
            return res.status(400).json({ error: 'invalid wallet address' });
        try {
            await (0, db_2.addSmartWallet)(wallet, type || 'unspecified');
            res.json({ ok: true, wallet });
        }
        catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
    app.delete('/api/wallets/:wallet', async (req, res) => {
        if (!config_1.env.ADMIN_KEY || req.header('x-admin-key') !== config_1.env.ADMIN_KEY)
            return res.status(401).json({ error: 'unauthorized' });
        try {
            await (0, db_2.removeSmartWallet)(req.params.wallet);
            res.json({ ok: true });
        }
        catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
    app.get('/api/tokens', (_req, res) => res.json(payload()));
    app.get('/api/stream', (req, res) => {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();
        res.write(`data: ${JSON.stringify(payload())}\n\n`);
        clients.add(res);
        req.on('close', () => clients.delete(res));
    });
    // full history straight from Postgres — everything ever logged, paged
    app.get('/api/history', async (req, res) => {
        if (!db_1.pool) {
            res.json({ rows: [], note: 'no database attached' });
            return;
        }
        const offset = parseInt(String(req.query.offset || '0'), 10) || 0;
        try {
            const r = await db_1.pool.query(`SELECT ca, symbol, name, source, first_seen, gate_result, gate_fail_reason, last_state, last_score
         FROM tokens ORDER BY first_seen DESC LIMIT 500 OFFSET $1`, [offset]);
            const c = await db_1.pool.query(`SELECT COUNT(*)::int AS n FROM tokens`);
            res.json({ total: c.rows[0].n, offset, rows: r.rows });
        }
        catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
    // weekly feedback report — JSON you paste back for tuning
    app.get('/api/report', async (_req, res) => {
        try {
            res.json(await (0, report_1.buildReport)());
        }
        catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
    app.get('/api/stats', (_req, res) => {
        const all = (0, store_1.allTokens)();
        res.json({
            seen: all.length,
            gatedOut: all.filter(t => t.gated === false).length,
            watching: all.filter(t => t.gated === true && t.state !== 'DEAD').length,
            triggers: all.filter(t => t.state === 'TRIGGER').length,
        });
    });
    app.listen(config_1.env.PORT, () => console.log(`[api] dashboard on :${config_1.env.PORT}`));
}
// push to all SSE clients — call after each scoring pass
function broadcast() {
    if (!clients.size)
        return;
    const msg = `data: ${JSON.stringify(payload())}\n\n`;
    for (const c of clients)
        c.write(msg);
}
const payload = () => ({ tokens: serialize(), scans: (0, store_1.recentScans)().slice(0, 60), seenFeed: seenFeed() });
// Every token in the store, newest first, with whatever status it currently has.
// This is the raw "everything that came through" view — including tokens still
// pending gates (no liquidity yet) that never appear in the watchlist or scan feed.
function seenFeed() {
    return (0, store_1.allTokens)()
        .sort((a, b) => b.firstSeen - a.firstSeen)
        .slice(0, 150)
        .map(t => {
        let status;
        if (t.gated === null)
            status = 'PENDING'; // seen, waiting for liquidity to run gates
        else if (t.gated === false)
            status = 'KILLED';
        else
            status = t.state; // WATCHING/HEATING/TRIGGER/etc.
        return {
            ca: t.ca, symbol: t.symbol, source: t.source, status,
            reason: t.gateFailReason,
            ageMin: Math.round((Date.now() - t.firstSeen) / 60000),
            liq: Math.round(t.liquidityUsd),
            score: t.gated === true ? t.score : null,
        };
    });
}
const STATE_ORDER = { TRIGGER: 0, HEATING: 1, WATCHING: 2, EXTENDED: 3, DYING: 4 };
function serialize() {
    return (0, store_1.activeTokens)()
        .sort((a, b) => (STATE_ORDER[a.state] ?? 9) - (STATE_ORDER[b.state] ?? 9) || b.score - a.score)
        .slice(0, 50)
        .map(pick);
}
function pick(t) {
    return {
        ca: t.ca, symbol: t.symbol, name: t.name, source: t.source, state: t.state,
        score: t.score, subs: t.subs,
        ageMin: Math.round((Date.now() - t.firstSeen) / 60000),
        priceUsd: t.priceUsd, liq: Math.round(t.liquidityUsd), mcap: Math.round(t.mcapUsd),
        ratio: t.mcapUsd > 0 ? +(t.liquidityUsd / t.mcapUsd).toFixed(3) : 0,
        buys: t.buys5m, sells: t.sells5m, chg5m: t.priceChange5m,
        movedPct: t.firstScorePrice && t.priceUsd ? +(((t.priceUsd / t.firstScorePrice) - 1) * 100).toFixed(1) : 0,
        insider: t.bundle ? t.bundle.insiderPct : null,
        why: t.why,
        funded: t.bundle ? t.bundle.fundedSnipers : 0,
        smart: new Set(t.smartHits.map(h => h.wallet)).size,
        aiNote: t.aiNote,
        pair: t.pairAddress,
    };
}
