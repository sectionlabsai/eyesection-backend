// C0 control chars (incl. newlines/tabs) plus DEL — replaced with spaces so a
// stored value can't forge new prompt lines. Built via RegExp(string) to keep
// literal control bytes out of the source file.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = new RegExp('[\\u0000-\\u001F\\u007F]', 'g');

/**
 * Neutralize user-supplied text before it is interpolated into an LLM prompt.
 *
 * Collapses newlines/tabs/repeated whitespace into single spaces (so a stored
 * value can't forge new prompt lines or headings), strips control characters,
 * and truncates to a hard cap. This is defense-in-depth on top of the model's
 * guardrails: profile fields are already length-bounded at write time
 * (account.controller), but sanitizing at the injection point guarantees the
 * surrounding prompt structure can't be broken out of no matter what is stored.
 */
export function sanitizeForPrompt(value: string, maxLen = 200): string {
  return value
    .replace(CONTROL_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

/** Sanitize a list of user-supplied strings, dropping any that end up empty. */
export function sanitizeListForPrompt(values: string[], maxLen = 60): string[] {
  return values.map((v) => sanitizeForPrompt(v, maxLen)).filter(Boolean);
}
