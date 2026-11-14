/**
 * Secret redaction.
 *
 * Two different leaks are handled here:
 *
 *  1. Importing a local client config (`claude_desktop_config.json` and
 *     friends) would otherwise copy API keys from `env` blocks into the index
 *     database, which is then printed, exported, or committed.
 *  2. Remote transport headers occasionally carry `Authorization: Bearer ...`
 *     inline, and error messages love to echo request options.
 *
 * Policy: store the *names* of secret-bearing keys, never the values.
 */

export const REDACTED = "<redacted>";

const SECRET_KEY = /(token|secret|passw(or)?d|passwd|api[-_]?key|apikey|credential|authorization|auth[-_]?token|private[-_]?key|cookie|session[-_]?id|bearer|access[-_]?key)/i;

const VALUE_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: "github-pat", re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g },
  { label: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g },
  { label: "openai-key", re: /\bsk-[A-Za-z0-9_-]{16,}/g },
  { label: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{16,}/g },
  { label: "aws-access-key", re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { label: "slack-token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { label: "google-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { label: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { label: "private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { label: "bearer", re: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi },
  { label: "url-credentials", re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/gi },
  { label: "kv-secret", re: /\b(api[_-]?key|token|secret|password)\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{12,}["']?/gi },
];

export function isSecretKey(key: string): boolean {
  return SECRET_KEY.test(key);
}

/** Redact secret-looking substrings inside a single string. */
export function redactString(input: string): string {
  if (typeof input !== "string" || input.length === 0) return input;
  let output = input;
  for (const { re } of VALUE_PATTERNS) {
    output = output.replace(re, REDACTED);
  }
  return output;
}

/**
 * Deep-redact an arbitrary JSON-ish value.
 *
 * Any key that *looks* secret has its entire value replaced, which also covers
 * opaque blobs that no pattern would match.
 */
export function redactDeep<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || value === undefined) return value;

  if (typeof value === "string") return redactString(value) as unknown as T;

  if (Array.isArray(value)) {
    return value.map((item) => redactDeep(item, seen)) as unknown as T;
  }

  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (seen.has(obj)) return "<cycle>" as unknown as T;
    seen.add(obj);

    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(obj)) {
      if (isSecretKey(key) && typeof entry !== "object") {
        out[key] = REDACTED;
      } else if (isSecretKey(key) && entry !== null && typeof entry === "object") {
        out[key] = REDACTED;
      } else {
        out[key] = redactDeep(entry, seen);
      }
    }
    return out as unknown as T;
  }

  return value;
}

/**
 * Reduce an env map to `{ KEY: "<redacted>" }` for storage, or to `KEY` names.
 * Values are never persisted because they are the highest-value secret in a
 * local MCP config.
 */
export function redactEnv(env: Record<string, string> | undefined): Record<string, string> {
  if (!env) return {};
  const out: Record<string, string> = {};
  for (const key of Object.keys(env)) {
    out[key] = REDACTED;
  }
  return out;
}

export function redactEnvNames(env: Record<string, string> | undefined): string[] {
  return env ? Object.keys(env).sort() : [];
}
