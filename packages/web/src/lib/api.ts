import { NextResponse } from 'next/server';
import { UnauthorizedError } from './auth';

/** Uniform JSON error shape so the client never has to guess. */
export interface ApiError {
  error: string;
  code: string;
  details?: unknown;
}

export function ok<T>(data: T, init?: ResponseInit): NextResponse {
  return NextResponse.json(data as object, { status: 200, ...init });
}

export function created<T>(data: T): NextResponse {
  return NextResponse.json(data as object, { status: 201 });
}

export function badRequest(message: string, details?: unknown): NextResponse {
  return NextResponse.json<ApiError>({ error: message, code: 'bad_request', details }, { status: 400 });
}

export function unauthorized(message = 'Not signed in.'): NextResponse {
  return NextResponse.json<ApiError>({ error: message, code: 'unauthorized' }, { status: 401 });
}

export function forbidden(message: string): NextResponse {
  return NextResponse.json<ApiError>({ error: message, code: 'forbidden' }, { status: 403 });
}

export function notFound(message = 'Not found.'): NextResponse {
  return NextResponse.json<ApiError>({ error: message, code: 'not_found' }, { status: 404 });
}

export function tooManyRequests(message: string, retryAfterSeconds = 60): NextResponse {
  return NextResponse.json<ApiError>(
    { error: message, code: 'rate_limited' },
    { status: 429, headers: { 'retry-after': String(retryAfterSeconds) } },
  );
}

export function serverError(message: string): NextResponse {
  return NextResponse.json<ApiError>({ error: message, code: 'server_error' }, { status: 500 });
}

/**
 * Run a route handler and translate thrown errors into responses.
 * Without this, every handler repeats the same try/catch.
 *
 * Accepts any `Response`, not only `NextResponse`, so handlers can hand back a
 * bare redirect when that is the right shape.
 */
export async function handler(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof UnauthorizedError) return unauthorized(error.message);
    if (error instanceof Error) {
      if (error.message.includes('Unique constraint')) return badRequest('That record already exists.');
      if (error.message.includes('rate limit')) return tooManyRequests(error.message);
      if (process.env.NODE_ENV !== 'production') return serverError(`${error.name}: ${error.message}`);
    }
    return serverError('Something went wrong.');
  }
}

/** Per-user in-memory rate limit for write endpoints. */
const buckets = new Map<string, { count: number; resetAt: number }>();

export function rateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt < now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  bucket.count += 1;
  return bucket.count <= limit;
}

// Keep the map from growing without bound in a long-lived server process.
if (typeof setInterval !== 'undefined') {
  const interval = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) if (bucket.resetAt < now) buckets.delete(key);
  }, 60_000);
  interval.unref?.();
}