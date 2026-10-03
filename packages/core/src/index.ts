/**
 * @upvote/core — the product's brain, with zero I/O.
 *
 * Everything in here is a pure function of its inputs (plus an injectable clock),
 * which is what makes the whole pipeline unit-testable and lets the CLI run
 * completely offline.
 */
export * from './types.js';
export * from './utils.js';
export * from './dates.js';
export * from './style.js';
export * from './authenticity.js';
export * from './model.js';
export * from './templates.js';
export * from './subreddit.js';
export * from './matcher.js';
export * from './scheduling.js';
export * from './guardrails.js';
export * from './generator.js';
export * from './pricing.js';
export * from './attribution.js';