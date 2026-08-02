// Central config. All values come from the environment so the same code runs
// locally and on the cloud host (see plan/backend.md).

/** Port the HTTP server binds. Cloud hosts inject PORT; default suits local dev. */
export const PORT = Number(process.env.PORT) || 5174;

/** The chat model. Override with CLAUDE_MODEL if desired. */
export const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-opus-4-8';

/**
 * Shared secret(s) the app must send as the `x-app-secret` header. Two sources, merged:
 *  - APP_SHARED_SECRET — the original variable (another project still uses it); accepts
 *    a single value or a comma-separated list.
 *  - iphoneAppSecretKey — this app's own variable, added separately on the HF Space so
 *    the original secret never has to be edited. Also accepts a comma-separated list.
 * Each client app holds its own secret, so one can be rotated without breaking the rest.
 * When BOTH are empty (the local-dev default) the gate is OPEN — convenient for `curl`.
 * ALWAYS set at least one on the public cloud host, or anyone can spend your
 * subscription. (plan/backend.md)
 */
export const APP_SHARED_SECRETS: string[] = [
  process.env.APP_SHARED_SECRET,
  process.env.iphoneAppSecretKey,
]
  .flatMap((v) => (v ?? '').split(','))
  .map((s) => s.trim())
  .filter((s) => s.length > 0);
