import { createHash } from 'node:crypto';
import { cfg } from '../config';
import { pool } from '../db';
import { leadershipDiag } from '../leadership';
import { pumpfunStreamDiag } from '../ingest/pumpfun';
import { pumpPortalGuardDiag } from '../ingest/pumpportal-guard';
import { heliusHealth } from '../helius';
import { webhookDiag } from '../wallets/webhook';
import { paperDiag } from '../paper/paper';
import { geminiConfigured, geminiLastError } from '../ai/gemini';

const REQUIRED_VARIABLES = [
  'DATABASE_URL',
  'HELIUS_API_KEY',
  'PUMPPORTAL_API_KEY',
  'JUPITER_API_KEY',
  'SIMULATION_WALLET',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHAT_ID',
] as const;

const OPTIONAL_VARIABLES = [
  'GEMINI_API_KEY',
  'ANTHROPIC_API_KEY',
  'TELEGRAM_CANARY_ENABLED',
  'PUMPPORTAL_MAX_ACTIVE_TOKENS',
  'PUMPPORTAL_MAX_PAID_EVENTS_PER_BOOT',
  'WORKER_LOCK_KEY',
] as const;

const CORE_TABLES = [
  'tokens',
  'outcomes',
  'paper_trades',
  'paper_trade_snapshots',
  'paper_trade_events',
  'trade_events',
  'smart_wallets',
  'wallet_hits',
  'leadership_claims',
] as const;

const iso = (value: unknown) => value ? new Date(String(value)).toISOString() : null;

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 10);
}

export function redactDiagnosticError(value: unknown): string {
  return String(value || 'unknown error')
    .replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, '[REDACTED_DATABASE_URL]')
    .replace(/([?&](?:api[-_]?key|token|secret)=)[^&\s"']+/gi, '$1[REDACTED]')
    .replace(/\b(?:sk|key|token)_[A-Za-z0-9_-]{12,}\b/g, '[REDACTED_SECRET]')
    .slice(0, 400);
}

export function compactId(value: string | undefined): string | null {
  const normalized = String(value || '').trim();
  if (!normalized) return null;
  if (normalized.length <= 12) return normalized;
  return `${normalized.slice(0, 8)}…${normalized.slice(-4)}`;
}

export function describeVariable(name: string, required: boolean, source: NodeJS.ProcessEnv = process.env) {
  const raw = String(source[name] || '');
  const normalized = raw.trim();
  const quoted = normalized.length >= 2
    && ((normalized.startsWith('"') && normalized.endsWith('"'))
      || (normalized.startsWith("'") && normalized.endsWith("'")));
  const publicWallet = name === 'SIMULATION_WALLET';
  return {
    name,
    required,
    present: normalized.length > 0,
    fingerprint: normalized ? hash(normalized) : null,
    hadSurroundingWhitespace: raw !== normalized,
    hasOuterQuotes: quoted,
    validPublicWallet: publicWallet
      ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(normalized)
      : undefined,
  };
}

async function databaseDiagnostics() {
  if (!pool) {
    return {
      configured: false,
      connected: false,
      pingMs: null,
      error: 'DATABASE_URL is not configured',
      tables: [],
      freshness: {},
    };
  }

  const output: any = {
    configured: true,
    connected: false,
    pingMs: null,
    serverVersion: null,
    databaseClock: null,
    tables: [],
    freshness: {},
    errors: {},
  };

  const step = async (name: string, fn: () => Promise<unknown>) => {
    try {
      return await fn();
    } catch (error) {
      output.errors[name] = redactDiagnosticError((error as Error).message);
      return null;
    }
  };

  const started = Date.now();
  const ping: any = await step('ping', async () => (await pool!.query(
    `SELECT now() AS database_clock, current_setting('server_version_num') AS server_version`,
  )).rows[0]);
  output.pingMs = Date.now() - started;
  output.connected = !!ping;
  output.databaseClock = iso(ping?.database_clock);
  output.serverVersion = ping?.server_version || null;

  const tables: any = await step('tables', async () => (await pool!.query(
    `SELECT relname AS table_name,
            n_live_tup::bigint::text AS estimated_rows,
            pg_total_relation_size(relid)::bigint::text AS total_bytes,
            last_analyze,
            last_autoanalyze
       FROM pg_stat_user_tables
      ORDER BY pg_total_relation_size(relid) DESC, relname ASC`,
  )).rows);
  output.tables = Array.isArray(tables) ? tables.map((row: any) => ({
    table: row.table_name,
    estimatedRows: Number(row.estimated_rows || 0),
    totalBytes: Number(row.total_bytes || 0),
    lastAnalyze: iso(row.last_analyze),
    lastAutoAnalyze: iso(row.last_autoanalyze),
  })) : [];

  const existing = new Set(output.tables.map((table: any) => table.table));
  const exactCounts: Record<string, number | null> = {};
  for (const table of CORE_TABLES) {
    if (!existing.has(table)) {
      exactCounts[table] = null;
      continue;
    }
    exactCounts[table] = await step(`count_${table}`, async () => Number(
      (await pool!.query(`SELECT COUNT(*)::bigint::text AS count FROM ${table}`)).rows[0].count,
    )) as number | null;
  }
  output.exactCounts = exactCounts;

  if (existing.has('tokens')) {
    output.freshness.tokens = await step('freshness_tokens', async () => {
      const row = (await pool!.query(
        `SELECT MAX(first_seen) AS latest_first_seen,
                MAX(triggered_at) AS latest_trigger,
                MAX(runtime_at) AS latest_runtime,
                COUNT(*) FILTER (WHERE first_seen > now() - interval '24 hours')::int AS created_24h,
                COUNT(*) FILTER (WHERE triggered_at > now() - interval '24 hours')::int AS triggered_24h
           FROM tokens`,
      )).rows[0];
      return {
        latestFirstSeen: iso(row.latest_first_seen),
        latestTrigger: iso(row.latest_trigger),
        latestRuntime: iso(row.latest_runtime),
        created24h: Number(row.created_24h || 0),
        triggered24h: Number(row.triggered_24h || 0),
      };
    });
  }

  if (existing.has('paper_trades')) {
    output.freshness.paperTrades = await step('freshness_paper_trades', async () => {
      const row = (await pool!.query(
        `SELECT MAX(entry_at) AS latest_entry,
                COUNT(*) FILTER (WHERE NOT closed)::int AS open,
                COUNT(*) FILTER (WHERE entry_at > now() - interval '24 hours')::int AS opened_24h,
                COUNT(*) FILTER (WHERE closed AND entry_at > now() - interval '24 hours')::int AS closed_from_24h
           FROM paper_trades`,
      )).rows[0];
      return {
        latestEntry: iso(row.latest_entry),
        open: Number(row.open || 0),
        opened24h: Number(row.opened_24h || 0),
        closedFrom24h: Number(row.closed_from_24h || 0),
      };
    });
  }

  if (existing.has('trade_events')) {
    output.freshness.tradeEvents = await step('freshness_trade_events', async () => {
      const row = (await pool!.query(
        `SELECT MAX(at) AS latest_event,
                COUNT(*) FILTER (WHERE at > now() - interval '24 hours')::int AS events_24h,
                COUNT(*) FILTER (WHERE source='pumpfun' AND at > now() - interval '24 hours')::int AS pumpfun_24h
           FROM trade_events`,
      )).rows[0];
      return {
        latestEvent: iso(row.latest_event),
        events24h: Number(row.events_24h || 0),
        pumpfun24h: Number(row.pumpfun_24h || 0),
      };
    });
  }

  if (!Object.keys(output.errors).length) delete output.errors;
  return output;
}

function activeConfigSnapshot() {
  const config: any = cfg();
  return {
    weights: config.weights,
    states: config.states,
    conviction: config.conviction,
    bestbuys: config.bestbuys,
    gates: {
      minLiquidityUsd: config.gates.min_liquidity_usd,
      top3HolderPctMax: config.gates.top3_holder_pct_max,
      hardRejectTopHolderPct: config.gates.hard_reject_top_holder_pct,
      maxInsiderSupplyPct: config.bundle.max_insider_supply_pct,
      maxFundedSnipers: config.bundle.max_funded_snipers,
    },
    limits: config.limits,
    learning: config.learning,
    calibration: config.calibration,
  };
}

export async function buildReadOnlyDiagnostics() {
  const memory = process.memoryUsage();
  const variables = [
    ...REQUIRED_VARIABLES.map(name => describeVariable(name, true)),
    ...OPTIONAL_VARIABLES.map(name => describeVariable(name, false)),
  ];

  return {
    reportType: 'read_only_runtime_diagnostics',
    generatedAt: new Date().toISOString(),
    safety: {
      readOnly: true,
      secretValuesIncluded: false,
      rawRowsIncluded: false,
      liveTradingEnabled: false,
      note: 'Only allowlisted metadata, aggregate database statistics, safe fingerprints, and subsystem diagnostics are included.',
    },
    deployment: {
      project: process.env.RAILWAY_PROJECT_NAME || null,
      environment: process.env.RAILWAY_ENVIRONMENT_NAME || null,
      service: process.env.RAILWAY_SERVICE_NAME || null,
      deploymentId: compactId(process.env.RAILWAY_DEPLOYMENT_ID),
      replicaId: compactId(process.env.RAILWAY_REPLICA_ID),
      commit: compactId(process.env.RAILWAY_GIT_COMMIT_SHA),
      region: process.env.RAILWAY_REPLICA_REGION || process.env.RAILWAY_REGION || null,
    },
    runtime: {
      uptimeSeconds: Math.round(process.uptime()),
      node: process.version,
      pid: process.pid,
      memoryMb: {
        rss: Math.round(memory.rss / 1_048_576),
        heapUsed: Math.round(memory.heapUsed / 1_048_576),
        heapTotal: Math.round(memory.heapTotal / 1_048_576),
      },
      leadership: leadershipDiag(),
    },
    variables: {
      required: variables.filter(variable => variable.required),
      optional: variables.filter(variable => !variable.required),
      missingRequired: variables.filter(variable => variable.required && !variable.present).map(variable => variable.name),
      formattingWarnings: variables
        .filter(variable => variable.hadSurroundingWhitespace || variable.hasOuterQuotes)
        .map(variable => variable.name),
    },
    database: await databaseDiagnostics(),
    subsystems: {
      pumpPortal: pumpfunStreamDiag(),
      pumpPortalCostGuard: pumpPortalGuardDiag(),
      helius: heliusHealth(),
      webhook: webhookDiag(),
      gemini: {
        configured: geminiConfigured(),
        lastError: geminiLastError() ? redactDiagnosticError(geminiLastError()) : null,
      },
      paper: await paperDiag(),
    },
    activeConfig: activeConfigSnapshot(),
  };
}
