/**
 * Environment validation.
 *
 * Missing secrets are fatal at boot, not at 3am when a scheduled post fires.
 * In development we substitute honest placeholders so `pnpm dev` works before
 * anyone has signed up for anything.
 */
export const env = {
  get clerkPublishableKey(): string {
    return require_('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', 'pk_test_placeholder');
  },
  get clerkSecretKey(): string {
    return require_('CLERK_SECRET_KEY', 'sk_test_placeholder');
  },
  get stripeSecretKey(): string {
    return require_('STRIPE_SECRET_KEY', 'sk_test_placeholder');
  },
  get stripeWebhookSecret(): string {
    return require_('STRIPE_WEBHOOK_SECRET', 'whsec_placeholder');
  },
  get githubWebhookSecret(): string {
    return require_('GITHUB_WEBHOOK_SECRET', 'github_webhook_placeholder');
  },
  /** Encrypts OAuth tokens at rest. Must be 32 bytes. */
  get tokenEncryptionKey(): string {
    return require_('TOKEN_ENCRYPTION_KEY', '0'.repeat(32));
  },
  get redditClientId(): string {
    return require_('REDDIT_CLIENT_ID', '');
  },
  get redditClientSecret(): string {
    return require_('REDDIT_CLIENT_SECRET', '');
  },
  get githubClientId(): string {
    return require_('GITHUB_CLIENT_ID', '');
  },
  get githubClientSecret(): string {
    return require_('GITHUB_CLIENT_SECRET', '');
  },
  get redisUrl(): string {
    return require_('REDIS_URL', '');
  },
  get appUrl(): string {
    return require_('NEXT_PUBLIC_APP_URL', 'http://localhost:3000');
  },
  get resendApiKey(): string {
    return require_('RESEND_API_KEY', '');
  },
  get isProduction(): boolean {
    return process.env.NODE_ENV === 'production';
  },
  get isConfigured(): boolean {
    return Boolean(process.env.DATABASE_URL) && Boolean(process.env.CLERK_SECRET_KEY);
  },
};

function require_(key: string, fallback: string): string {
  const value = process.env[key];
  if (value) return value;
  if (process.env.NODE_ENV === 'production') {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return fallback;
}

/** One place to check before running anything that writes. */
export function assertWritable(): void {
  if (env.isProduction && !process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL must be set in production. Refusing to run without it.');
  }
}