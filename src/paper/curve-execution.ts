import { cfg } from '../config';
import { TokenRecord } from '../types';
import { clamp01, round } from '../model/math';
import { rpcUrl } from './rpc-sim';
import { executionSettings, ExecutableQuote } from './execution';
import { getSolUsd } from '../state/sol-price';

/**
 * PRE-GRADUATION EXECUTION ADAPTER (PumpPortal Local Transaction API).
 *
 * PumpPortal builds the real unsigned pump.fun transaction. We then simulate it
 * with sigVerify=false and request every static writable account back from RPC.
 * Comparing those accounts before and after simulation gives the actual lamport
 * debit and raw SPL-token output without signing, custody, or broadcasting.
 *
 * The adapter fails closed whenever the transaction hides the destination token
 * account behind an address lookup table or RPC omits an account state. A route
 * build alone remains evidence, never eligibility.
 */

const TRADE_LOCAL_URL = 'https://pumpportal.fun/api/trade-local';
const PROBE_TIMEOUT_MS = 8_000;
const STABILITY_GAP_MS = 350;
const RATE_LIMIT_PER_MINUTE = 12;
const SELL_PROBE_TOKEN_AMOUNT = 1_000;
const PRIORITY_FEE_SOL = 0.0005;
const MAX_SIMULATION_ACCOUNTS = 20;
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

const recentProbeTimestamps: number[] = [];
const diag = {
  probes: 0, buysBuilt: 0, sellsBuilt: 0, buildFailures: 0,
  simulationsOk: 0, simulationsBlockedUnfunded: 0, simulationsFailed: 0,
  pricedFills: 0, fillAccountsMissing: 0, rateLimited: 0,
  lastStatus: null as string | null, lastAt: null as string | null,
};
export const curveExecutionDiag = () => ({ ...diag });
export function __resetCurveExecutionForTest() {
  recentProbeTimestamps.length = 0;
  for (const key of Object.keys(diag) as Array<keyof typeof diag>) {
    (diag as any)[key] = typeof diag[key] === 'number' ? 0 : null;
  }
}

function rateLimited(now: number): boolean {
  while (recentProbeTimestamps.length && now - recentProbeTimestamps[0] > 60_000) recentProbeTimestamps.shift();
  if (recentProbeTimestamps.length >= RATE_LIMIT_PER_MINUTE) return true;
  recentProbeTimestamps.push(now);
  return false;
}

function shadowWallet(): string {
  return process.env.SIMULATION_WALLET || process.env.EXECUTION_SHADOW_PUBKEY || '';
}

function probeEnabled(): boolean {
  if (process.env.CURVE_PROBE_DISABLED === '1') return false;
  return (cfg().signal_model as any).curve_probe_enabled !== false;
}

interface CurveBuild {
  built: boolean;
  status: string;
  transactionBase64: string | null;
  latencyMs: number;
}

interface ParsedMessageAccounts {
  payer: string;
  writable: string[];
}

interface CurveFill {
  ok: boolean;
  status: string;
  simulationError: string | null;
  unitsConsumed: number | null;
  tokenAmountRaw: bigint | null;
  tokenDecimals: number | null;
  lamportsDebited: number | null;
  accountCount: number;
}

function readShortVec(bytes: Buffer, start: number): { value: number; next: number } | null {
  let value = 0;
  let shift = 0;
  let offset = start;
  while (offset < bytes.length && shift <= 28) {
    const byte = bytes[offset++];
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value, next: offset };
    shift += 7;
  }
  return null;
}

export function base58Encode(bytes: Uint8Array): string {
  if (!bytes.length) return '';
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let index = 0; index < digits.length; index++) {
      const value = digits[index] * 256 + carry;
      digits[index] = value % 58;
      carry = Math.floor(value / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let leading = 0;
  while (leading < bytes.length && bytes[leading] === 0) leading++;
  return '1'.repeat(leading) + digits.reverse().map(value => BASE58_ALPHABET[value]).join('');
}

export function base58Decode(value: string): Buffer | null {
  if (!value) return Buffer.alloc(0);
  const bytes = [0];
  for (const character of value) {
    const digit = BASE58_ALPHABET.indexOf(character);
    if (digit < 0) return null;
    let carry = digit;
    for (let index = 0; index < bytes.length; index++) {
      const next = bytes[index] * 58 + carry;
      bytes[index] = next & 0xff;
      carry = next >> 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  let leading = 0;
  while (leading < value.length && value[leading] === '1') leading++;
  const decoded = Buffer.from([...new Array(leading).fill(0), ...bytes.reverse()]);
  return decoded;
}

/** Parse the static writable account keys from a legacy or v0 serialized transaction. */
export function parseStaticWritableAccounts(transactionBase64: string): ParsedMessageAccounts | null {
  try {
    const bytes = Buffer.from(transactionBase64, 'base64');
    let offset = 0;
    const signatures = readShortVec(bytes, offset);
    if (!signatures) return null;
    offset = signatures.next + signatures.value * 64;
    if (offset + 4 >= bytes.length) return null;
    if ((bytes[offset] & 0x80) !== 0) offset++; // versioned message prefix
    const requiredSignatures = bytes[offset++];
    const readonlySigned = bytes[offset++];
    const readonlyUnsigned = bytes[offset++];
    const count = readShortVec(bytes, offset);
    if (!count || count.value <= 0 || count.value > 256) return null;
    offset = count.next;
    if (offset + count.value * 32 > bytes.length) return null;
    const keys: string[] = [];
    for (let index = 0; index < count.value; index++) {
      keys.push(base58Encode(bytes.subarray(offset + index * 32, offset + (index + 1) * 32)));
    }
    const writable = keys.filter((_, index) => {
      if (index < requiredSignatures) return index < requiredSignatures - readonlySigned;
      return index < keys.length - readonlyUnsigned;
    });
    if (!keys[0] || !writable.includes(keys[0])) return null;
    return { payer: keys[0], writable };
  } catch {
    return null;
  }
}

function accountData(account: any): Buffer | null {
  const encoded = Array.isArray(account?.data) ? account.data[0] : account?.data;
  if (typeof encoded !== 'string') return null;
  try { return Buffer.from(encoded, 'base64'); }
  catch { return null; }
}

/** Standard SPL Token account layout: mint[0..32], owner[32..64], amount u64[64..72]. */
export function decodeTokenAccountAmount(account: any, mintBytes: Buffer): bigint | null {
  const data = accountData(account);
  if (!data || data.length < 72 || mintBytes.length !== 32) return null;
  if (!data.subarray(0, 32).equals(mintBytes)) return null;
  return data.readBigUInt64LE(64);
}

async function rpc(method: string, params: unknown[], signal: AbortSignal): Promise<any> {
  const url = rpcUrl();
  if (!url) throw new Error('curve_rpc_missing');
  const response = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal,
  });
  const data: any = await response.json().catch(() => ({}));
  if (!response.ok || data.error) throw new Error(`curve_rpc_${method}_${response.status || 'error'}`);
  return data.result;
}

async function getAccounts(addresses: string[], signal: AbortSignal): Promise<any[]> {
  const result = await rpc('getMultipleAccounts', [addresses, { encoding: 'base64', commitment: 'processed' }], signal);
  return Array.isArray(result?.value) ? result.value : [];
}

async function tokenDecimals(mint: string, signal: AbortSignal): Promise<number | null> {
  try {
    const result = await rpc('getTokenSupply', [mint, { commitment: 'processed' }], signal);
    const decimals = Number(result?.value?.decimals);
    return Number.isInteger(decimals) && decimals >= 0 && decimals <= 18 ? decimals : null;
  } catch { return null; }
}

function sumTokenAmount(accounts: any[], mintBytes: Buffer): bigint {
  return accounts.reduce((sum, account) => sum + (decodeTokenAccountAmount(account, mintBytes) || 0n), 0n);
}

function unfundedShadowError(error: string | null): boolean {
  const value = String(error || '').toLowerCase();
  return value.includes('insufficientfunds') || value.includes('insufficient funds')
    || value.includes('insufficient lamports') || value.includes('accountnotfound');
}

async function simulateMeasuredFill(transaction: string, mint: string, signal: AbortSignal): Promise<CurveFill> {
  const parsed = parseStaticWritableAccounts(transaction);
  const mintBytes = base58Decode(mint);
  if (!parsed || !mintBytes || mintBytes.length !== 32) {
    return { ok: false, status: 'curve_fill_accounts_unparseable', simulationError: null, unitsConsumed: null,
      tokenAmountRaw: null, tokenDecimals: null, lamportsDebited: null, accountCount: 0 };
  }
  const addresses = [parsed.payer, ...parsed.writable.filter(address => address !== parsed.payer)]
    .slice(0, MAX_SIMULATION_ACCOUNTS);
  const pre = await getAccounts(addresses, signal);
  if (pre.length !== addresses.length || !pre[0]) {
    return { ok: false, status: 'curve_fill_pre_accounts_missing', simulationError: null, unitsConsumed: null,
      tokenAmountRaw: null, tokenDecimals: null, lamportsDebited: null, accountCount: addresses.length };
  }
  const result = await rpc('simulateTransaction', [transaction, {
    encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'processed',
    accounts: { encoding: 'base64', addresses },
  }], signal);
  const value = result?.value || {};
  const simulationError = value.err == null ? null : `simulation_failed:${JSON.stringify(value.err).slice(0, 240)}`;
  const units = Number.isFinite(Number(value.unitsConsumed)) ? Number(value.unitsConsumed) : null;
  if (simulationError) {
    return { ok: false, status: unfundedShadowError(simulationError) ? 'curve_sim_blocked_shadow_unfunded' : 'curve_simulation_failed',
      simulationError, unitsConsumed: units, tokenAmountRaw: null, tokenDecimals: null,
      lamportsDebited: null, accountCount: addresses.length };
  }
  const post = Array.isArray(value.accounts) ? value.accounts : [];
  if (post.length !== addresses.length || !post[0]) {
    return { ok: false, status: 'curve_fill_post_accounts_missing', simulationError: null, unitsConsumed: units,
      tokenAmountRaw: null, tokenDecimals: null, lamportsDebited: null, accountCount: addresses.length };
  }
  const preLamports = Number(pre[0]?.lamports);
  const postLamports = Number(post[0]?.lamports);
  const lamportsDebited = preLamports - postLamports;
  const preToken = sumTokenAmount(pre, mintBytes);
  const postToken = sumTokenAmount(post, mintBytes);
  const tokenAmountRaw = postToken - preToken;
  const decimals = await tokenDecimals(mint, signal);
  if (!(lamportsDebited > 0) || tokenAmountRaw <= 0n || decimals === null) {
    return { ok: false, status: 'curve_fill_delta_unmeasured', simulationError: null, unitsConsumed: units,
      tokenAmountRaw: tokenAmountRaw > 0n ? tokenAmountRaw : null, tokenDecimals: decimals,
      lamportsDebited: lamportsDebited > 0 ? lamportsDebited : null, accountCount: addresses.length };
  }
  return { ok: true, status: 'curve_fill_measured', simulationError: null, unitsConsumed: units,
    tokenAmountRaw, tokenDecimals: decimals, lamportsDebited, accountCount: addresses.length };
}

async function buildCurveTransaction(
  action: 'buy' | 'sell', mint: string, amount: number, denominatedInSol: boolean, signal: AbortSignal,
): Promise<CurveBuild> {
  const startedAt = Date.now();
  try {
    const response = await fetch(TRADE_LOCAL_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        publicKey: shadowWallet(), action, mint, amount,
        denominatedInSol: denominatedInSol ? 'true' : 'false',
        slippage: Math.max(1, Math.round(executionSettings.slippageBps / 100)),
        priorityFee: PRIORITY_FEE_SOL, pool: 'pump',
      }), signal,
    });
    if (!response.ok) {
      return { built: false, status: `curve_build_http_${response.status}`, transactionBase64: null, latencyMs: Date.now() - startedAt };
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length < 200) {
      return { built: false, status: 'curve_build_rejected', transactionBase64: null, latencyMs: Date.now() - startedAt };
    }
    return { built: true, status: 'curve_built', transactionBase64: bytes.toString('base64'), latencyMs: Date.now() - startedAt };
  } catch (error) {
    const status = error instanceof Error && error.name === 'AbortError' ? 'curve_build_timeout' : 'curve_build_error';
    return { built: false, status, transactionBase64: null, latencyMs: Date.now() - startedAt };
  }
}

function curveFailure(status: string, startedAt: number, extras: Partial<ExecutableQuote> = {}): ExecutableQuote {
  diag.lastStatus = status; diag.lastAt = new Date().toISOString();
  return {
    eligible: false, status, effectiveEntryPrice: null, positionSol: null, positionUsd: null,
    quotedOutUsd: null, quotedOutAmount: null, priceImpact: null,
    slippageBps: executionSettings.slippageBps, feeLamports: null, router: 'pumpportal_curve',
    quoteTimeMs: Date.now() - startedAt, transactionBuilt: false, simulationOk: false,
    simulationError: null, executionScore: 0, routeStabilityBps: null,
    requestedPositionSol: executionSettings.positionSol, selectedRouter: 'pumpportal_curve',
    selectedMode: 'bonding_curve', unitsConsumed: null, probeSizes: [], ...extras,
  } as ExecutableQuote;
}

export async function curveQuoteExecutableEntry(
  token: TokenRecord, markPrice: number, startedAt: number,
  options?: { requireSimulation?: boolean },
): Promise<ExecutableQuote> {
  if (!probeEnabled()) return curveFailure('curve_probe_disabled', startedAt);
  if (!shadowWallet()) return curveFailure('curve_shadow_wallet_missing', startedAt);
  const requireSimulation = options?.requireSimulation ?? cfg().signal_model.require_transaction_simulation === true;
  if (!rpcUrl()) return curveFailure('curve_rpc_missing', startedAt);
  const solUsd = getSolUsd();
  if (!(solUsd > 0)) return curveFailure('curve_sol_price_missing', startedAt);
  const now = Date.now();
  if (rateLimited(now)) { diag.rateLimited++; return curveFailure('curve_probe_rate_limited', startedAt); }
  diag.probes++;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS * 4);
  try {
    const positionSol = executionSettings.positionSol;
    const buy = await buildCurveTransaction('buy', token.ca, positionSol, true, controller.signal);
    if (!buy.built || !buy.transactionBase64) { diag.buildFailures++; return curveFailure(buy.status, startedAt); }
    diag.buysBuilt++;

    const sell = await buildCurveTransaction('sell', token.ca, SELL_PROBE_TOKEN_AMOUNT, false, controller.signal);
    if (!sell.built) { diag.buildFailures++; return curveFailure('curve_sell_build_failed', startedAt, { transactionBuilt: true }); }
    diag.sellsBuilt++;

    const first = await simulateMeasuredFill(buy.transactionBase64, token.ca, controller.signal);
    if (!first.ok || first.tokenAmountRaw === null || first.tokenDecimals === null || first.lamportsDebited === null) {
      if (first.status === 'curve_sim_blocked_shadow_unfunded') diag.simulationsBlockedUnfunded++;
      else if (first.status.includes('accounts') || first.status.includes('delta')) diag.fillAccountsMissing++;
      else diag.simulationsFailed++;
      return curveFailure(first.status, startedAt, {
        transactionBuilt: true, simulationOk: false, simulationError: first.simulationError,
        unitsConsumed: first.unitsConsumed,
        probeSizes: [{ sol: positionSol, status: first.status, transactionBuilt: true,
          simulationOk: false, priceImpact: null, accountCount: first.accountCount } as any],
      });
    }
    diag.simulationsOk++;

    await new Promise(resolve => setTimeout(resolve, STABILITY_GAP_MS));
    const repeatBuild = await buildCurveTransaction('buy', token.ca, positionSol, true, controller.signal);
    if (!repeatBuild.built || !repeatBuild.transactionBase64) {
      return curveFailure('curve_route_unstable', startedAt, { transactionBuilt: true, simulationOk: true });
    }
    const repeat = await simulateMeasuredFill(repeatBuild.transactionBase64, token.ca, controller.signal);
    if (!repeat.ok || repeat.tokenAmountRaw === null) {
      return curveFailure('curve_route_unstable', startedAt, {
        transactionBuilt: true, simulationOk: true, simulationError: repeat.simulationError,
      });
    }

    const rawOut = Number(first.tokenAmountRaw);
    const repeatOut = Number(repeat.tokenAmountRaw);
    if (!(rawOut > 0) || !(repeatOut > 0)) return curveFailure('curve_fill_amount_overflow', startedAt, { transactionBuilt: true });
    const routeStabilityBps = Math.abs(repeatOut - rawOut) / rawOut * 10_000;
    const tokenAmountUi = rawOut / 10 ** first.tokenDecimals;
    const positionUsd = first.lamportsDebited / 1_000_000_000 * solUsd;
    const effectiveEntryPrice = tokenAmountUi > 0 ? positionUsd / tokenAmountUi : null;
    const priceImpact = effectiveEntryPrice && markPrice > 0 ? Math.abs(effectiveEntryPrice / markPrice - 1) : null;
    const requestedLamports = Math.round(positionSol * 1_000_000_000);
    const overheadLamports = Math.max(0, first.lamportsDebited - requestedLamports);
    const maxPositionUsd = token.liquidityUsd > 0
      ? token.liquidityUsd * executionSettings.maxLiquidityPct : Number.POSITIVE_INFINITY;
    const positionInBudget = positionUsd >= executionSettings.minPositionUsd && positionUsd <= maxPositionUsd * 1.01;
    const stable = routeStabilityBps <= cfg().signal_model.route_stability_max_bps;
    const impactOk = priceImpact !== null && priceImpact <= executionSettings.maxPriceImpact;
    const stabilityScore = clamp01(1 - routeStabilityBps / cfg().signal_model.route_stability_max_bps);
    const impactScore = priceImpact === null ? 0 : clamp01(1 - priceImpact / Math.max(0.0001, executionSettings.maxPriceImpact));
    const executionScore = clamp01(0.45 + 0.20 + 0.20 * stabilityScore + 0.15 * impactScore);
    const eligible = (!requireSimulation || first.ok) && sell.built && stable && impactOk && positionInBudget
      && executionScore >= cfg().signal_model.min_execution_score;
    const status = !positionInBudget ? 'curve_position_outside_liquidity_budget'
      : !stable ? 'curve_route_unstable'
      : !impactOk ? 'curve_price_impact_too_high'
      : executionScore < cfg().signal_model.min_execution_score ? 'curve_execution_score_too_low'
      : 'curve_executable_simulated_priced';
    diag.pricedFills++;
    diag.lastStatus = status; diag.lastAt = new Date().toISOString();
    return {
      eligible, status, effectiveEntryPrice,
      positionSol: first.lamportsDebited / 1_000_000_000, positionUsd,
      quotedOutUsd: tokenAmountUi * markPrice, quotedOutAmount: first.tokenAmountRaw.toString(),
      priceImpact, slippageBps: executionSettings.slippageBps,
      feeLamports: overheadLamports, router: 'pumpportal_curve',
      quoteTimeMs: Date.now() - startedAt, transactionBuilt: true,
      simulationOk: true, simulationError: null, executionScore: round(executionScore),
      routeStabilityBps: round(routeStabilityBps, 1), requestedPositionSol: positionSol,
      selectedRouter: 'pumpportal_curve', selectedMode: 'bonding_curve', unitsConsumed: first.unitsConsumed,
      probeSizes: [
        { sol: positionSol, status: first.status, transactionBuilt: true, simulationOk: true,
          priceImpact, outAmount: first.tokenAmountRaw.toString(), positionUsd, accountCount: first.accountCount },
        { sol: positionSol, status: repeat.status, transactionBuilt: true, simulationOk: true,
          priceImpact: null, outAmount: repeat.tokenAmountRaw.toString(), accountCount: repeat.accountCount },
      ] as any,
    } as ExecutableQuote;
  } catch (error) {
    const status = error instanceof Error && error.name === 'AbortError' ? 'curve_probe_timeout'
      : String((error as Error).message || '').startsWith('curve_rpc_') ? (error as Error).message
      : 'curve_probe_error';
    diag.buildFailures++;
    return curveFailure(status, startedAt);
  } finally { clearTimeout(timeout); }
}
