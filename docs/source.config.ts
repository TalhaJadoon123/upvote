import { defineDocs, defineConfig } from 'fumadocs-mdx/config';

/**
 * Fumadocs MDX source configuration.
 * Run `pnpm postinstall` after adding content files under content/docs.
 */
export const docs = defineDocs({
  dir: 'content/docs',
});

export default defineConfig();