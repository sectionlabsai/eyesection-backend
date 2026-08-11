/**
 * Escape a user-supplied string so it can be used as a literal inside a MongoDB
 * `$regex` (or `new RegExp`) without the caller's metacharacters changing the
 * match semantics.
 *
 * This closes two problems at once for admin search (see admin.service.listUsers):
 *  - regex injection — input like `.*` or `^admin@` would otherwise alter the query;
 *  - ReDoS — an escaped literal has no quantifiers/alternation, so matching stays
 *    linear regardless of the input. Callers should still bound the input length.
 */
export function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
