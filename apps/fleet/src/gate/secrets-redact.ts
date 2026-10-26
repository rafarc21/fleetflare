// #1346: redact a GRANTED secret's exact value out of a leg's own result
// body before it reaches R2 -- the one place a value can leak into something
// every later `fleet gate log` call reads back (log.ts's own
// LegOutput.stdout/stderr). Exact-value, not shape-based: studio/redact.ts's
// regexes match fixed-prefix token shapes (ghs_..., tskey-auth-..., sk-ant-...)
// that a GitHub/Tailscale/Anthropic token happens to have; an
// operator-chosen staging credential has no such shape to match on. This
// Worker minted every value it is ever asked to scrub (it read it from its
// own Env, or minted it itself for the AI route), so it always knows the
// exact string -- exact-value redaction is strictly tighter than a regex
// guess here, never weaker.

export function redactKnownSecretValues(text: string, values: readonly string[]): string {
  let out = text;
  for (const value of values) {
    if (value === "") continue;
    out = out.split(value).join("«redacted»");
  }
  return out;
}
