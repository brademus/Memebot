import { pool } from '../db';
import { buildReadOnlyDiagnostics } from '../ops/read-only-diagnostics';

export type HealthStatus = 'healthy' | 'degraded' | 'unhealthy' | 'unavailable';

export function statusToHttpCode(status: HealthStatus): number {
  switch (status) {
    case 'healthy':
      return 200;
    case 'degraded':
      return 200;
    case 'unavailable':
      return 503;
    case 'unhealthy':
      return 503;
    default:
      return 503;
  }
}

export async function handleHealth() {
  if (!pool) {
    return {
      status: 'unavailable' as const,
      message: 'DATABASE_URL is not configured',
    };
  }

  try {
    // Quick database connectivity check
    const result = await pool.query('SELECT 1 AS check');
    if (!result.rows.length) {
      return { status: 'unhealthy' as const, message: 'database connectivity check failed' };
    }

    // Get full diagnostics
    const diagnostics = await buildReadOnlyDiagnostics();

    // Simple health determination
    const missingRequired = diagnostics.variables.missingRequired;
    const dbErrors = diagnostics.database.errors;

    if (missingRequired.length > 0) {
      return {
        status: 'unhealthy' as const,
        message: `Missing required environment variables: ${missingRequired.join(', ')}`,
      };
    }

    if (dbErrors && Object.keys(dbErrors).length > 0) {
      return {
        status: 'degraded' as const,
        message: 'Database operations have errors',
        errors: dbErrors,
      };
    }

    // Check critical subsystems
    const telegramDiag = diagnostics.subsystems.telegram;
    const heliusQuota = diagnostics.subsystems.heliusQuota;

    const warnings: string[] = [];

    if (telegramDiag.canaryTested && telegramDiag.canaryResult) {
      warnings.push(`Telegram configuration issue: ${telegramDiag.canaryResult.kind}`);
    }

    if (heliusQuota.circuitOpen) {
      warnings.push('Helius quota circuit is open; credits exhausted');
    }

    return {
      status: warnings.length > 0 ? ('degraded' as const) : ('healthy' as const),
      message: warnings.length > 0 ? `Warnings: ${warnings.join('; ')}` : 'Service is operational',
      uptime: diagnostics.runtime.uptimeSeconds,
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    return {
      status: 'unhealthy' as const,
      message: `Health check failed: ${(error as Error).message}`,
    };
  }
}

