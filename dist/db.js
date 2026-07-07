"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.pool = void 0;
exports.initDb = initDb;
exports.upsertToken = upsertToken;
exports.logOutcome = logOutcome;
exports.bumpDeployer = bumpDeployer;
exports.isBlacklistedDeployer = isBlacklistedDeployer;
exports.markRug = markRug;
exports.fetchHistory = fetchHistory;
exports.addSmartWallet = addSmartWallet;
exports.removeSmartWallet = removeSmartWallet;
exports.listSmartWallets = listSmartWallets;
exports.markTrigger = markTrigger;
const pg_1 = require("pg");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const config_1 = require("./config");
exports.pool = config_1.env.DATABASE_URL
    ? new pg_1.Pool({ connectionString: config_1.env.DATABASE_URL, ssl: config_1.env.DATABASE_URL.includes('railway') ? { rejectUnauthorized: false } : undefined })
    : null;
async function initDb() {
    if (!exports.pool) {
        console.warn('[db] no DATABASE_URL — running memory-only (outcomes will NOT be logged)');
        return;
    }
    const schema = fs_1.default.readFileSync(path_1.default.join(process.cwd(), 'schema.sql'), 'utf8');
    await exports.pool.query(schema);
    console.log('[db] schema ready');
}
async function upsertToken(t) {
    if (!exports.pool)
        return;
    await exports.pool.query(`INSERT INTO tokens (ca, symbol, name, creator, source, first_seen, gate_result, gate_fail_reason, first_score_price, peak_score, last_state, last_score, subs)
     VALUES ($1,$2,$3,$4,$5,to_timestamp($6/1000.0),$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (ca) DO UPDATE SET gate_result=$7, gate_fail_reason=$8, first_score_price=COALESCE(tokens.first_score_price,$9), peak_score=GREATEST(tokens.peak_score,$10), last_state=$11, last_score=$12, subs=COALESCE($13, tokens.subs)`, [t.ca, t.symbol, t.name, t.creator, t.source, t.firstSeen,
        t.gated === null ? null : t.gated ? 'passed' : 'failed',
        t.gateFailReason, t.firstScorePrice, t.peakScore, t.state, t.score,
        t.gated === true ? JSON.stringify(t.subs) : null]).catch(e => console.error('[db] upsert', e.message));
}
async function logOutcome(ca, minutes, price, liq, mcap, firstPrice) {
    if (!exports.pool)
        return;
    await exports.pool.query(`INSERT INTO outcomes (ca, snapshot_minutes, price_usd, liquidity_usd, mcap_usd, multiple_from_first)
     VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (ca, snapshot_minutes) DO NOTHING`, [ca, minutes, price, liq, mcap, firstPrice ? price / firstPrice : null]).catch(e => console.error('[db] outcome', e.message));
}
async function bumpDeployer(wallet) {
    if (!exports.pool || !wallet)
        return;
    await exports.pool.query(`INSERT INTO deployers (wallet) VALUES ($1)
     ON CONFLICT (wallet) DO UPDATE SET tokens_launched = deployers.tokens_launched + 1, last_seen = now()`, [wallet]).catch(() => { });
}
async function isBlacklistedDeployer(wallet) {
    if (!exports.pool || !wallet)
        return false;
    const r = await exports.pool.query(`SELECT blacklisted FROM deployers WHERE wallet=$1`, [wallet]).catch(() => null);
    return !!r?.rows[0]?.blacklisted;
}
async function markRug(ca) {
    if (!exports.pool)
        return;
    // called by outcome logger when a token round-trips to ~zero: increment deployer rug count, auto-blacklist at 2+
    await exports.pool.query(`UPDATE deployers d SET rugs = rugs + 1, blacklisted = (rugs + 1 >= 2)
     FROM tokens t WHERE t.ca = $1 AND d.wallet = t.creator`, [ca]).catch(() => { });
}
async function fetchHistory(before, limit) {
    if (!exports.pool)
        return [];
    const r = await exports.pool.query(`SELECT t.ca, t.symbol, t.source, t.first_seen, t.gate_result, t.gate_fail_reason,
            t.last_state, t.last_score, o.multiple_from_first AS multiple_4h
     FROM tokens t LEFT JOIN outcomes o ON o.ca = t.ca AND o.snapshot_minutes = 240
     WHERE ($1::timestamptz IS NULL OR t.first_seen < $1)
     ORDER BY t.first_seen DESC LIMIT $2`, [before, Math.min(limit, 200)]).catch(() => null);
    return r ? r.rows : [];
}
async function addSmartWallet(wallet, type) {
    if (!exports.pool)
        throw new Error('no database');
    await exports.pool.query(`INSERT INTO smart_wallets (wallet, type, active, last_validated) VALUES ($1,$2,TRUE,now())
     ON CONFLICT (wallet) DO UPDATE SET active=TRUE, type=$2`, [wallet, type]);
}
async function removeSmartWallet(wallet) {
    if (!exports.pool)
        throw new Error('no database');
    await exports.pool.query(`UPDATE smart_wallets SET active=FALSE WHERE wallet=$1`, [wallet]);
}
async function listSmartWallets() {
    if (!exports.pool)
        return [];
    const r = await exports.pool.query(`SELECT wallet, type, active, last_validated FROM smart_wallets ORDER BY last_validated DESC`).catch(() => null);
    return r ? r.rows : [];
}
async function markTrigger(ca, price) {
    if (!exports.pool)
        return;
    await exports.pool.query(`UPDATE tokens SET triggered_at = COALESCE(triggered_at, now()), trigger_price = COALESCE(trigger_price, $2) WHERE ca = $1`, [ca, price]).catch(() => { });
}
