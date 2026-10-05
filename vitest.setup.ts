/**
 * Global test setup.
 *
 * The most important line here is UPVOTE_OFFLINE. The machine running the tests
 * may have real provider credentials in its environment, and without this flag
 * the CLI and desktop suites would quietly make billed network calls and time
 * out. Every test in this repo must be deterministic and offline.
 */
process.env.UPVOTE_OFFLINE = '1';

// Point every stateful integration at a throwaway directory.
process.env.UPVOTE_HOME ??= `${process.env.TEMP ?? '/tmp'}/upvote-test-home`;

// Keep web build-time checks from failing on a missing database.
process.env.DATABASE_URL ??= 'postgres://postgres:postgres@localhost:5432/upvote_test';
process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ??= 'pk_test_setup';
process.env.CLERK_SECRET_KEY ??= 'sk_test_setup';
process.env.TOKEN_ENCRYPTION_KEY ??= '0'.repeat(64);