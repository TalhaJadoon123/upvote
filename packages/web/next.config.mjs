/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Workspace packages ship TypeScript source; Next compiles them with the app.
  transpilePackages: [
    '@upvote/core',
    '@upvote/voice',
    '@upvote/gh',
    '@upvote/reddit',
    '@upvote/scheduler',
    '@upvote/analytics',
  ],
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: false },
  // BullMQ and ioredis are optional dependencies of the scheduler. They are only
  // used by the standalone worker, never by the Next.js runtime, and bundling
  // them drags in native glibc binaries that fail to resolve.
  serverExternalPackages: ['bullmq', 'ioredis', '@valkey/valkey-glide'],

  experimental: {
    // Server Actions receive a signed-in user id, not a token.
    serverActions: { bodySizeLimit: '2mb' },
  },

  /**
   * The workspace packages ship TypeScript source with `.js` import specifiers
   * (required for Node ESM). webpack does not map those to `.ts` the way esbuild
   * and vitest do, so teach it explicitly. Without this the production build
   * fails with "Can't resolve './types.js'".
   */
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      '.js': ['.ts', '.tsx', '.js'],
    };
    return config;
  },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ];
  },
};

export default nextConfig;