import { loader } from 'fumadocs-core/source';
import * as generated from '../source.generated';

/**
 * Typed source tree generated from content/docs by fumadocs-mdx.
 * The generated module is excluded from typecheck (it is emitted code), so the
 * cast keeps the rest of the app honest.
 */
export const source = loader({
  baseUrl: '/',
  source: generated as unknown as Parameters<typeof loader>[0]['source'],
});