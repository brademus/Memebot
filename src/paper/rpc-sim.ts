/**
 * Shared Solana RPC simulation plumbing for execution adapters (Jupiter AMM and
 * PumpPortal bonding curve). Simulation is sigVerify:false against a serialized
 * unsigned transaction: nothing here can ever sign or broadcast.
 */
export function rpcUrl(): string {
  if (process.env.SOLANA_RPC_URL) return process.env.SOLANA_RPC_URL;
  return process.env.HELIUS_API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}` : '';
}

export async function simulateTransaction(transaction: string, signal: AbortSignal): Promise<{ ok: boolean; error: string | null; units: number | null }> {
  const url = rpcUrl();
  if (!url) return { ok: false, error: 'solana_rpc_missing', units: null };
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'simulateTransaction',
      params: [transaction, { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'processed' }],
    }),
    signal,
  });
  const data: any = await response.json().catch(() => ({}));
  if (!response.ok || data.error) return { ok: false, error: `simulation_rpc_${response.status || 'error'}`, units: null };
  const error = data.result?.value?.err;
  return {
    ok: error == null,
    error: error == null ? null : `simulation_failed:${JSON.stringify(error).slice(0, 240)}`,
    units: Number.isFinite(Number(data.result?.value?.unitsConsumed)) ? Number(data.result.value.unitsConsumed) : null,
  };
}
