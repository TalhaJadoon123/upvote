/**
 * Untrusted-input sanitisation.
 *
 * Everything Upvote feeds to a model arrives from outside our trust boundary:
 * commit messages, PR bodies, release notes, issue text, subreddit sidebars.
 * A malicious repository (or a scraped subreddit) could otherwise smuggle
 * instructions into the prompt and steer the draft.
 *
 * This module is deliberately conservative: it strips the shapes that are used
 * for injection and prompt hijacking, normalises whitespace, and bounds length.
 * It is defence in depth, not a guarantee - the human approval step is the
 * control that actually matters.
 */

/** Roles the model treats as authoritative, plus the delimiters we use. */
const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(?:all\s+)?(?:previous|prior|above|earlier)\s+(?:instructions?|prompts?|rules?)/gi,
  /disregard\s+(?:all\s+)?(?:previous|prior|above|earlier)\s+(?:instructions?|prompts?|rules?)/gi,
  /forget\s+(?:everything|all)\s+(?:above|before)/gi,
  /you\s+are\s+now\s+/gi,
  /new\s+(?:system\s+)?(?:instructions?|prompt)\s*:/gi,
  /system\s*(?:prompt|message)\s*:/gi,
  /^\s*###\s*(?:system|instruction)/gim,
  /\[\s*(?:system|inst)\s*\]/gi,
  /<\s*(?:system|important)\s*>/gi,
  /\{\{.*?\}\}/g,
  /<%.*?%>/g,
];

/**
 * Strip instruction-like content from text that will be shown to a model.
 * Returns a string safe to interpolate into a prompt.
 */
export function sanitizeForPrompt(input: string, maxLength = 4000): string {
  let text = input
    // Control characters, including bidi overrides used to hide text.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/[\u202A-\u202E\u2066-\u2069]/g, '');

  for (const pattern of INJECTION_PATTERNS) text = text.replace(pattern, '');

  text = text
    // Zero-width and other invisible formatting.
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    // Collapse runaway blank lines that can be used to pad a prompt.
    .replace(/\n{4,}/g, '\n\n')
    .trim();

  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}\n[truncated]`;
}

/**
 * Sanitise a body we are about to *publish*. Less aggressive than the prompt
 * filter because we are not building a prompt, but we still refuse to publish
 * characters that would corrupt a post or hide its contents.
 */
export function sanitizeForPublish(input: string, maxLength = 40_000): string {
  return input
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/[\u202A-\u202E\u2066-\u2069]/g, '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .trim()
    .slice(0, maxLength);
}

/**
 * Neutralise a title: single line, bounded, no markdown that would let a
 * scraped string inject formatting into the subreddit listing.
 */
export function sanitizeTitle(input: string, maxLength = 300): string {
  return sanitizeForPublish(input, maxLength)
    .replace(/[\r\n]+/g, ' ')
    .replace(/[#*_`~|]/g, '')
    .replace(/\s{2,}/g, ' ')
    .slice(0, maxLength)
    .trim();
}

/** A subreddit name we are willing to send an API call for. */
export function isValidSubredditName(name: string): boolean {
  return /^[A-Za-z0-9_]{2,32}$/.test(name);
}

/** Truncate an API error before it reaches a log or a UI. */
export function safeErrorMessage(error: unknown, maxLength = 300): string {
  const message = error instanceof Error ? error.message : String(error);
  // Strip anything that looks like a bearer token or a connection string.
  return message
    .replace(/(gh[pousr]_[A-Za-z0-9]{16,})/g, '[redacted-token]')
    // Provider keys use both separators in practice: sk- and sk_.
    .replace(/\b(sk|pk|rk|api)[-_][A-Za-z0-9_-]{16,}/gi, '[redacted-key]')
    .replace(/:\/\/[^:@/]+:[^@/]+@/g, '://[redacted]@')
    .slice(0, maxLength);
}