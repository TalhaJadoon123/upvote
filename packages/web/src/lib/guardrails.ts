import { GuardrailConfigSchema, type GuardrailConfig } from '@upvote/core';

/** Defaults identical to the CLI so behaviour does not diverge by surface. */
export function defaultGuardrails(): GuardrailConfig {
  return GuardrailConfigSchema.parse({});
}

/** Map a settings row into the core guardrail shape. */
export function guardrailsFromRow(row: {
  maxPostsPerDay: number;
  maxPostsPerSubredditPerWeek: number;
  cooldownHoursAfterRemoval: number;
  blocklist: string[];
  requireManualApproval: boolean;
  requirePriorEngagement: boolean;
  minAuthenticityScore: number;
}): GuardrailConfig {
  return GuardrailConfigSchema.parse({
    maxPostsPerDay: row.maxPostsPerDay,
    maxPostsPerSubredditPerWeek: row.maxPostsPerSubredditPerWeek,
    cooldownHoursAfterRemoval: row.cooldownHoursAfterRemoval,
    blocklist: row.blocklist,
    requireManualApproval: row.requireManualApproval,
    requirePriorEngagement: row.requirePriorEngagement,
    minAuthenticityScore: row.minAuthenticityScore,
  });
}