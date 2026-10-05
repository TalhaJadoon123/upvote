# Security

Upvote holds bearer credentials for the founder's own GitHub and Reddit accounts.
That makes security a product requirement rather than a checklist item, so the
threats below are enumerated with what actually mitigates them.

## Trust boundaries

| Input | Trusted? | Where it is sanitised |
| --- | --- | --- |
| Reddit OAuth tokens | No | Encrypted with AES-256-GCM before storage |
| GitHub webhook payloads | No | HMAC verified, then `sanitizeForPrompt` |
| Commit messages, PR bodies, release notes | No | `sanitizeForPrompt` at moment construction |
| Manual "what I shipped" text | Partly | `sanitizeForPrompt` + `sanitizeTitle` |
| Subreddit sidebars | No | Parsed into a closed rule enum, never executed |
| Model output | No | `sanitizeForPublish` before publishing |
| `x-forwarded-for` | No | Used only as a rate-limit key, never for authorisation |

## What is implemented

**Token encryption at rest.** OAuth access and refresh tokens are sealed with
AES-256-GCM (`v1.iv.tag.data`, base64url) using `TOKEN_ENCRYPTION_KEY`. A random
12-byte IV per encryption; a wrong key or tampered ciphertext throws rather than
returning garbage. Rotating the key invalidates every stored token, so rotation
requires re-connecting accounts.

**Webhook signature verification.** GitHub uses `timingSafeEqual` over
`sha256=HMAC(secret, body)` after a length check. Both webhook endpoints fail
closed when the secret is unset — a misconfigured server never accepts a forged
event.

**Constant-time secret comparison.** Cron endpoints authenticate with
`requireSecret()` (`packages/web/src/lib/secrets.ts`), which uses
`timingSafeEqual`. A plain `!==` leaks the first differing byte through timing.

**Replay rejection.** Paddle signatures embed a timestamp; `verifyPaddleSignature`
rejects anything outside a 300-second window, so a captured request cannot be
replayed to grant a plan.

**Billing fail-closed.** An unrecognised Lemon Squeezy variant id or Paddle price
id resolves to the free plan. A price we do not recognise must never grant paid
features.

**Open-redirect prevention.** `/api/track` is linked from public Reddit posts, so
its `to` parameter is a phishing primitive if left open. `safeRedirect()` only
honours same-origin destinations plus an explicit `PRODUCT_ALLOWED_HOST`.

**OAuth state binding.** The Reddit callback requires an exact `upvote:<userId>`
state match. Substring matching would have let an attacker prepend text to a
valid id.

**Prompt-injection defence in depth.** Untrusted text reaching a model is passed
through `sanitizeForPrompt`, which strips instruction overrides, role
reassignment, system markers, bidi overrides, zero-width characters and control
characters, and bounds length. This is a mitigation, not a guarantee — human
approval before publishing is the control that actually matters.

**Renderer isolation (desktop).** The Electron renderer runs with
`contextIsolation: true`, `nodeIntegration: false` and `sandbox: true`. All
privileged work goes through a `contextBridge` allowlist. The window CSP blocks
remote resources, and external links open in the system browser rather than
in-app.

**Least privilege.** Upvote never posts from its own Reddit account; it uses the
founder's OAuth token. The dashboard holds no Reddit token at all — publishing
happens through a worker that does.

**Log hygiene.** `safeErrorMessage` redacts provider tokens, API keys and
credentials embedded in connection strings before an error reaches a log or UI.

## Known limitations

These are deliberate trade-offs, not oversights.

1. **Rate limiting is in-memory.** `packages/web/src/lib/api.ts` uses a `Map` with
   periodic cleanup. It resets on deploy and is per-instance. Behind multiple
   instances, or on serverless, use Redis or the hosting provider's limiter.
2. **`x-forwarded-for` is trusted for rate-limit keys.** A direct client can
   spoof the header and evade the limit. Behind a proxy that overwrites the header
   this is fine; otherwise prefer the platform's rate limiter.
3. **One unfixable dependency advisory.** `braces` (a transitive dev dependency of
   Tailwind via `fumadocs-ui`) has a published stack-exhaustion DoS advisory with
   **no patched version available**. It is build-time only, reachable only by
   feeding attacker-controlled glob patterns to a build, which never happens here.
   Re-check on the next Tailwind/fumadocs release. Everything else in the audit
   is fixed — see below.
4. **In-memory CLI state.** The CLI writes JSON to `~/.upvote` with atomic
   replace. On a shared machine that file is readable by other users; tighten with
   filesystem permissions.
5. **No CSRF token on server actions.** Next.js server actions carry an
   `Origin`/`Host` check. If you front the app with a permissive proxy, add an
   explicit origin allowlist.

## Verification

```bash
pnpm audit              # dependency advisories
pnpm lint               # static analysis
pnpm typecheck          # types across every package
pnpm test               # 363 unit tests
```

Current audit status: the critical vitest advisory (arbitrary file read via the
UI server), the drizzle-orm SQL-injection advisory, and the vite/postcss/esbuild/
image-size advisories are all resolved by pinning patched versions. The single
remaining item is limitation 3 above.