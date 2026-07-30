import { pool } from '../../db';
import { env } from '../../config';
import { ExecutionEvent } from './execution';
import { PaperCall, StrategyCandidate } from './types';

export type BtcAlertType = 'setup' | 'entry' | 'partial_exit' | 'stop_update' | 'exit' | 'liquidation' | 'missed';

interface DeliveryResult {
  attempted: boolean;
  sent: boolean;
  statusCode: number | null;
  attemptCount: number;
  latencyMs: number;
  errorKind: string | null;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const money = (value: number): string => `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const percent = (value: number): string => `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;

async function claimDelivery(
  idempotencyKey: string,
  alertType: BtcAlertType,
  call: PaperCall | null,
  candidate: StrategyCandidate | null,
  channel: 'dashboard' | 'telegram',
  payload: Record<string, unknown>,
): Promise<boolean> {
  if (!pool) return true;
  const result = await pool.query(`INSERT INTO btc_alert_deliveries
    (call_id,candidate_id,alert_type,channel,status,payload,idempotency_key)
    VALUES($1,$2,$3,$4,'pending',$5::jsonb,$6)
    ON CONFLICT(idempotency_key) DO NOTHING`, [
    call?.id || null, candidate?.id || null, alertType, channel, JSON.stringify(payload), idempotencyKey,
  ]);
  return (result.rowCount || 0) > 0;
}

async function completeDelivery(
  idempotencyKey: string,
  status: 'sent' | 'failed' | 'skipped' | 'stale',
  result: DeliveryResult,
): Promise<void> {
  if (!pool) return;
  await pool.query(`UPDATE btc_alert_deliveries SET status=$2,attempted_at=now(),
    delivered_at=CASE WHEN $2='sent' THEN now() ELSE delivered_at END,attempt_count=$3,
    latency_ms=$4,error_kind=$5 WHERE idempotency_key=$1`, [
    idempotencyKey, status, result.attemptCount, result.latencyMs, result.errorKind,
  ]);
}

async function sendTelegram(text: string): Promise<DeliveryResult> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    return { attempted: false, sent: false, statusCode: null, attemptCount: 0, latencyMs: 0, errorKind: 'telegram_credentials_missing' };
  }
  const startedAt = Date.now();
  let statusCode: number | null = null;
  let errorKind: string | null = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    try {
      const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
        signal: controller.signal,
      });
      statusCode = response.status;
      if (response.ok) {
        clearTimeout(timeout);
        return { attempted: true, sent: true, statusCode, attemptCount: attempt, latencyMs: Date.now() - startedAt, errorKind: null };
      }
      errorKind = response.status === 429 ? 'rate_limited'
        : response.status >= 500 ? 'telegram_server_error'
          : response.status === 401 || response.status === 403 ? 'unauthorized'
            : 'telegram_request_rejected';
      if (response.status !== 429 && response.status < 500) break;
    } catch (error) {
      errorKind = (error as Error).name === 'AbortError' ? 'timeout' : 'network_error';
    } finally {
      clearTimeout(timeout);
    }
    if (attempt < 3) await sleep(500 * 2 ** (attempt - 1));
  }
  return { attempted: true, sent: false, statusCode, attemptCount: 3, latencyMs: Date.now() - startedAt, errorKind };
}

function entryText(call: PaperCall): string {
  const tier = String(call.features.actionableTier || 'standard');
  const title = tier === 'a_plus'
    ? `🔥 BTC A+ ${call.direction.toUpperCase()} ALERT`
    : `🚨 BTC STANDARD ${call.direction.toUpperCase()} ALERT`;
  const resolved = Number(call.features.expectancyResolvedCalls || 0);
  const required = Number(call.features.expectancyRequiredResolvedCalls || 0);
  return [
    title,
    `${call.strategyName} · ${call.strategyVersion}`,
    `Entry: ${money(call.entryPrice)}`,
    `Leverage: ${call.leverage}x isolated paper`,
    `Margin: ${money(call.marginUsd)} · Notional: ${money(call.notionalUsd)}`,
    `Stop: ${money(call.stopPrice)}`,
    `Liquidation estimate: ${money(call.liquidationPrice)}`,
    `Target: ${money(call.targetPrice)}${call.extendedTargetPrice ? ` · Runner: ${money(call.extendedTargetPrice)}` : ''}`,
    `Projected target ROI: ${Number(call.features.estimatedTargetRoiPct || 0).toFixed(1)}%`,
    `Projected net R:R: ${Number(call.features.estimatedNetRR || 0).toFixed(2)}R`,
    `Research evidence: ${resolved}/${required} resolved · ${Number(call.features.expectancyAverageR || 0).toFixed(2)} avg R`,
    `Confidence: ${call.confidence}`,
    `Paper only — no exchange order was placed.`,
  ].join('\n');
}

function eventText(event: ExecutionEvent): string {
  const call = event.call;
  const title = event.type === 'partial_take_profit' ? '💰 BTC PARTIAL TAKE PROFIT'
    : event.type === 'stop_updated' ? '🛡 BTC STOP UPDATED'
      : event.type === 'position_liquidated' ? '🧨 BTC PAPER LIQUIDATION'
        : call.netPnlUsd >= 0 ? '✅ BTC EXIT ALERT' : '🛑 BTC EXIT ALERT';
  return [
    title,
    `${call.direction.toUpperCase()} · ${call.strategyName}`,
    `Price: ${money(event.price)}`,
    `Reason: ${event.reason}`,
    `Net P&L: ${money(call.netPnlUsd)} (${percent(call.roiPct)})`,
    `Result: ${call.resultR === null ? call.currentR.toFixed(2) : call.resultR.toFixed(2)}R`,
    `Remaining: ${(call.remainingFraction * 100).toFixed(0)}%`,
    call.trailingStopPrice ? `Protected stop: ${money(call.trailingStopPrice)}` : '',
    `Paper only — no exchange order was placed.`,
  ].filter(Boolean).join('\n');
}

export async function publishEntryAlert(call: PaperCall, candidate: StrategyCandidate): Promise<DeliveryResult> {
  if (call.book !== 'actionable') {
    return { attempted: false, sent: false, statusCode: null, attemptCount: 0, latencyMs: 0, errorKind: 'research_book_not_alerted' };
  }
  const payload = { callId: call.id, candidateId: candidate.id, status: call.status, entry: call.entryPrice };
  const dashboardKey = `${call.id}:entry:dashboard`;
  if (await claimDelivery(dashboardKey, 'entry', call, candidate, 'dashboard', payload)) {
    await completeDelivery(dashboardKey, 'sent', { attempted: true, sent: true, statusCode: 200, attemptCount: 1, latencyMs: 0, errorKind: null });
  }
  const key = `${call.id}:entry:telegram`;
  if (!(await claimDelivery(key, 'entry', call, candidate, 'telegram', payload))) {
    return { attempted: false, sent: false, statusCode: null, attemptCount: 0, latencyMs: 0, errorKind: 'duplicate_suppressed' };
  }
  const result = await sendTelegram(entryText(call));
  await completeDelivery(key, result.sent ? 'sent' : result.attempted ? 'failed' : 'skipped', result);
  return result;
}

export async function publishExecutionAlert(event: ExecutionEvent): Promise<DeliveryResult> {
  const call = event.call;
  if (call.book !== 'actionable' || event.type === 'pnl_snapshot') {
    return { attempted: false, sent: false, statusCode: null, attemptCount: 0, latencyMs: 0, errorKind: 'event_not_alertable' };
  }
  const alertType: BtcAlertType = event.type === 'partial_take_profit' ? 'partial_exit'
    : event.type === 'stop_updated' ? 'stop_update'
      : event.type === 'position_liquidated' ? 'liquidation' : 'exit';
  const priceKey = Math.round(event.price * 10) / 10;
  const payload = { callId: call.id, eventType: event.type, price: event.price, reason: event.reason };
  const dashboardKey = `${call.id}:${event.type}:${priceKey}:dashboard`;
  if (await claimDelivery(dashboardKey, alertType, call, null, 'dashboard', payload)) {
    await completeDelivery(dashboardKey, 'sent', { attempted: true, sent: true, statusCode: 200, attemptCount: 1, latencyMs: 0, errorKind: null });
  }
  const key = `${call.id}:${event.type}:${priceKey}:telegram`;
  if (!(await claimDelivery(key, alertType, call, null, 'telegram', payload))) {
    return { attempted: false, sent: false, statusCode: null, attemptCount: 0, latencyMs: 0, errorKind: 'duplicate_suppressed' };
  }
  const result = await sendTelegram(eventText(event));
  await completeDelivery(key, result.sent ? 'sent' : result.attempted ? 'failed' : 'skipped', result);
  return result;
}
