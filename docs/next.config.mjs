import { createMDX } from 'fumadocs-mdx/next';

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // webpack needs an MDX loader for the `?collection=` imports emitted into
  // .source/index.ts. createMDX wires it up, and this file's existence is also
  // how fumadocs-mdx chooses its Next generator over the Vite one.
  typescript: { ignoreBuildErrors: false },
};

export default withMDX(nextConfig);