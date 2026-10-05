import defaultComponents from 'fumadocs-ui/mdx';
import { Callout } from 'fumadocs-ui/components/callout';
import { Steps, Step } from 'fumadocs-ui/components/steps';

/**
 * Components available inside every MDX file.
 *
 * MDX resolves unknown capitalised tags as variables, so a `<Callout>` with no
 * definition here fails at prerender time rather than at author time. Declaring
 * them explicitly keeps the content files portable and self-checking.
 *
 * The export is intentionally untyped: fumadocs' own component map does not
 * satisfy MDXComponents' index signature, and annotating it forces a cast that
 * would hide real mismatches.
 */
const components = {
  ...defaultComponents,
  Callout,
  Steps,
  Step,

  /** The onboarding callout, rendered as an instruction rather than an ad. */
  Install: () =>
    (
      <div className="not-prose my-4 rounded-lg border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-900">
        <div className="font-medium">Get started</div>
        <div className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
          The CLI needs no API keys, no database and no daemon to generate drafts.
        </div>
      </div>
    ),
};

export function useMDXComponents(components?: Record<string, unknown>) {
  return { ...components };
}

export default components;