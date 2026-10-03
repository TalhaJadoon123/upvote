/**
 * Optional BullMQ + Redis worker.
 *
 * The pure scheduler in `scheduler.ts` decides *what* to do; this file only
 * handles *when to wake up*. Both bullmq and ioredis are optionalDependencies,
 * so the CLI and tests never need Redis.
 */
import { describeQueue, dueItems, failItem, type SchedulerState } from './scheduler.js';

export const QUEUE_NAME = 'upvote:post';
export const DIGEST_QUEUE = 'upvote:digest';

export interface QueueOptions {
  connection: { host: string; port: number; password?: string; tls?: boolean };
  /** Called for each due item; throw to trigger a retry. */
  publish: (item: { draftId: string; userId: string; subreddit: string; runAt: string }) => Promise<void>;
  /** Called after a publish succeeds, to record the reddit id. */
  onPublished?: (draftId: string) => Promise<void>;
  /** Called on the final failure. */
  onFailed?: (draftId: string, error: string) => Promise<void>;
  state: SchedulerState;
  maxAttempts?: number;
  lockSeconds?: number;
}

type BullModule = typeof import('bullmq');

/** Minimal structural type for the Redis client we depend on. */
type RedisLike = { quit: () => Promise<unknown>; on: (event: string, cb: (...args: never[]) => void) => unknown };
type RedisConstructor = new (options: Record<string, unknown>) => RedisLike;

/** True when both optional dependencies are installed. */
export async function queueAvailable(): Promise<boolean> {
  try {
    await import('bullmq');
    await import('ioredis');
    return true;
  } catch {
    return false;
  }
}

/**
 * Start the worker. Throws a helpful error if Redis deps are missing, which is
 * the common case for someone running the CLI locally.
 */
export async function startWorker(options: QueueOptions): Promise<{ close: () => Promise<void> }> {
  let BullMQ: BullModule;
  let IORedis: RedisConstructor;
  try {
    BullMQ = await import('bullmq');
    const mod = (await import('ioredis')) as unknown as { default?: RedisConstructor } & RedisConstructor;
    IORedis = mod.default ?? mod;
  } catch {
    throw new Error(
      'Redis scheduling is not installed. Run `pnpm add -w bullmq ioredis`, or use the built-in scheduler ' +
        '(`upvote schedule --tick`) which needs no external services.',
    );
  }

  const connection = new IORedis({
    host: options.connection.host,
    port: options.connection.port,
    ...(options.connection.password ? { password: options.connection.password } : {}),
    ...(options.connection.tls ? { tls: {} } : {}),
    maxRetriesPerRequest: null,
  });

  const queue = new BullMQ.Queue(QUEUE_NAME, { connection: connection as never });
  const worker = new BullMQ.Worker(
    QUEUE_NAME,
    async (job) => {
      const item = job.data as { draftId: string; userId: string; subreddit: string; runAt: string };
      await options.publish(item);
      await options.onPublished?.(item.draftId);
      return { ok: true };
    },
    { connection: connection as never, concurrency: 1, lockDuration: (options.lockSeconds ?? 120) * 1000 },
  );

  worker.on('failed', async (job, error) => {
    const draftId = job?.data?.draftId;
    if (!draftId) return;
    const result = failItem(options.state, draftId, error.message, { maxAttempts: options.maxAttempts });
    if (result.exhausted) await options.onFailed?.(draftId, error.message);
  });

  return {
    async close() {
      await worker.close();
      await queue.close();
      await connection.quit();
    },
  };
}

/**
 * Tick-based scheduler: no Redis required.
 * Call this every minute from cron (or `setInterval`) to publish anything due.
 */
export async function tick(options: {
  state: SchedulerState;
  publish: (item: { draftId: string; userId: string; subreddit: string; runAt: string }) => Promise<void>;
  onPublished?: (draftId: string) => Promise<void>;
  now?: Date;
  maxAttempts?: number;
}): Promise<{ processed: number; failed: number; summary: string }> {
  const now = options.now ?? new Date();
  const due = dueItems(options.state, now);
  let processed = 0;
  let failed = 0;

  for (const item of due) {
    try {
      await options.publish(item);
      await options.onPublished?.(item.draftId);
      processed++;
    } catch (error) {
      const result = failItem(options.state, item.draftId, (error as Error).message, {
        maxAttempts: options.maxAttempts,
      });
      if (result.exhausted) failed++;
    }
  }

  return { processed, failed, summary: describeQueue(options.state, now) };
}

/**
 * Cron expression for the daily digest: 08:07 UTC every day.
 * The odd minute avoids the top-of-hour stampede every cron user shares.
 */
export const DIGEST_CRON = '7 8 * * *';

/** Cron for the metrics poller: every 15 minutes. */
export const METRICS_CRON = '*/15 * * * *';