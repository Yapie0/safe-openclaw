/**
 * safe-openclaw: outbound message secret redaction.
 *
 * Scans AI responses before they are delivered to any messaging channel and
 * replaces sensitive values with "**********".
 *
 * Two layers of protection:
 *   1. Value-based: collects all secret strings from the live config and
 *      replaces any exact match regardless of format.
 *   2. Pattern-based: catches well-known token formats as a safety net
 *      (e.g. if a secret was resolved from an env-var and is not literally
 *      present in the config object).
 */

import type { OpenClawConfig } from "../config/config.js";
import { collectSensitiveValues } from "../config/redact-snapshot.js";
import { replaceSensitiveValuesInRaw } from "../config/redact-snapshot.raw.js";

export const OUTPUT_REDACT_PLACEHOLDER = "**********";

/** Minimum length for a value to be considered a secret (avoids false positives). */
const MIN_SECRET_LENGTH = 8;

/** Regex patterns for well-known token formats. */
const SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9]{20,}/g, // OpenAI API keys
  /sk-ant-[A-Za-z0-9_-]{80,}/g, // Anthropic API keys
  /AIza[A-Za-z0-9_-]{35}/g, // Google API keys
  /gh[pousr]_[A-Za-z0-9]{36,}/g, // GitHub tokens
  /xox[bpas]-[A-Za-z0-9-]{10,}/g, // Slack tokens
  /[0-9]{8,10}:[A-Za-z0-9_-]{30,}/g, // Telegram bot tokens
];

/**
 * Redact secrets from an outbound message text.
 *
 * Returns the text with all detected secret values replaced by
 * {@link OUTPUT_REDACT_PLACEHOLDER}.
 */
export function redactSecretsFromOutput(text: string, cfg: OpenClawConfig): string {
  if (!text) return text;

  // Layer 1: value-based — replace known secret strings from config
  const secrets = collectSensitiveValues(cfg).filter((s) => s.length >= MIN_SECRET_LENGTH);
  let result = replaceSensitiveValuesInRaw({
    raw: text,
    sensitiveValues: secrets,
    redactedSentinel: OUTPUT_REDACT_PLACEHOLDER,
  });

  // Layer 2: pattern-based — catch known token formats not in config
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, OUTPUT_REDACT_PLACEHOLDER);
  }

  return result;
}
