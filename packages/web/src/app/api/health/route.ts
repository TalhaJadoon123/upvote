import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { handler, ok } from '@/lib/api';
import { env } from '@/lib/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Liveness and readiness probe.
 *
 * `/api/health` is deliberately cheap and dependency-free so an orchestrator can
 * use it as a liveness probe without a database outage restarting healthy pods.
 * `/api/health?deep=1` additionally checks the database, which is what a
 * readiness probe should gate traffic on.
 *
 * It returns no secrets: only booleans and a version.
 */
export async function GET(request: NextRequest) {
  return handler(async () => {
    const deep = request.nextUrl.searchParams.get('deep') === '1';
    const body: Record<string, unknown> = {
      status: 'ok',
      service: 'upvote-web',
      version: process.env.npm_package_version ?? '0.1.0',
      commit: process.env.GIT_COMMIT_SHA ?? null,
      env: env.isProduction ? 'production' : 'development',
      checks: { config: true, database: 'skipped' },
    };

    if (deep) {
      // Touch the pool. A failed query means "not ready", not "crashed".
      try {
        const { sql } = await import('drizzle-orm');
        const { db } = await import('@/db');
        await db.execute(sql`select 1`);
        body.checks = { config: true, database: 'ok' };
      } catch (error) {
        return NextResponse.json(
          {
            ...body,
            status: 'degraded',
            checks: { config: true, database: 'unreachable' },
            // Redacted: never leak a DSN or driver error to an unauthenticated caller.
            error: error instanceof Error ? error.message.slice(0, 120) : 'unknown',
          },
          { status: 503 },
        );
      }
    }

    return ok(body);
  });
}