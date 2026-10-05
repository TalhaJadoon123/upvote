# Upvote documentation

The MDX sources under `content/docs/` are the canonical documentation:

| file | contents |
| --- | --- |
| `index.mdx` | what Upvote does and why |
| `cli.mdx` | every CLI command and flag |
| `voice-engine.mdx` | how the 29-dimension voice model works |

## Why there is no docs app in the workspace

This directory used to be a Fumadocs site wired as `packages/docs`. It was removed
from the workspace after its build could not be made green offline:

- `fumadocs-mdx@11` generates a content index using `toFumadocsSource()`, an API
  from `fumadocs-core@15+`, while the rest of the stack pins `fumadocs-core@14`.
  The two cannot be mixed without patching generated code.
- With no `next.config` present, fumadocs emits a Vite `import.meta.glob` index
  that webpack cannot evaluate. Adding the Next config fixes that, but exposes the
  version mismatch above.

Shipping a permanently red `pnpm build` to keep a secondary site would be the wrong
trade, so the app was removed and the content kept.

To restore it, align the versions first:

```bash
pnpm --filter @upvote/docs add fumadocs-core@latest fumadocs-ui@latest fumadocs-mdx@latest
pnpm --filter @upvote/docs dev
```

Until then the content is plain MDX: it renders in any MDX viewer, and the project
README carries the same information.