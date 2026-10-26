// #1346: redact a GRANTED secret's exact value (and its common encodings) out
// of a leg's own free-text result fields before they reach R2 or the
// Workflow step's own return value -- the places a value can leak into
// something every later `fleet gate log`/`fleet gate watch` read surfaces.
// Exact-value, not shape-based: studio/redact.ts's regexes match fixed-prefix
// token shapes (ghs_..., tskey-auth-..., sk-ant-...) that a GitHub/Tailscale/
// Anthropic token happens to have; an operator-chosen staging credential has
// no such shape to match on. This Worker minted every value it is ever asked
// to scrub (it read it from its own Env, or minted it itself for the AI
// route), so it always knows the exact string.
//
// Field-scoped, not whole-blob (#1346 correctness review r1): a short or
// common granted value (literally "success", "ok", a single word) run as a
// blind string replace over a WHOLE JSON document can corrupt a structural
// token instead of an actual echoed secret -- `"state":"success"` becoming
// `"state":"«redacted»"` would break the verdict itself, not just scrub a
// leak. redactLegResultFields (below) only ever touches the named free-text
// fields, never `state` or any JSON structure around them.

/** Every textual encoding of a granted value worth scanning for, beyond the
 *  literal string (#1346 security review r1 item 4): JSON-escaped (what the
 *  value looks like once embedded as a JSON string -- a secret containing a
 *  quote or backslash reads differently once escaped), base64 and base64url
 *  (a test or script that encodes the secret before printing or logging it),
 *  and percent/URL-encoded (a value embedded in a querystring or a
 *  Basic-auth-style URL). Deduped: a value with no special characters has the
 *  same raw and JSON-escaped form, so there is no reason to scan for it twice. */
function encodedForms(value: string): string[] {
  const forms = new Set<string>([value]);
  forms.add(JSON.stringify(value).slice(1, -1));
  try {
    const b64 = btoa(value);
    forms.add(b64);
    forms.add(b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""));
  } catch {
    // btoa only accepts Latin1-range code points; a secret outside that
    // range (unlikely, but not this function's job to assume) has no base64
    // form worth adding -- the raw and JSON-escaped forms above still apply.
  }
  forms.add(encodeURIComponent(value));
  return [...forms].filter((f) => f !== "");
}

/** #1346 security review r2: container/gate-server.ts keeps only the LAST
 *  OUTPUT_TAIL_CHARS (32k) of stdout/stderr before this ever reaches the
 *  Worker -- that cut can land in the MIDDLE of a granted secret, leaving
 *  just its trailing fragment sitting at the very START of the kept text.
 *  encodedForms' own full-value matching (below) never finds a fragment
 *  shorter than the whole value, so that leading fragment would otherwise
 *  leak untouched. This is a Worker-side-only fix (no container/image
 *  change): checked once per value, longest candidate first -- if `text`'s
 *  own prefix equals some SUFFIX of `value` at least MIN_LEADING_PARTIAL_CHARS
 *  long, that leading fragment is redacted too. The threshold exists so a
 *  short, coincidental overlap (two or three characters any real text could
 *  share with any secret) never triggers a redaction that would read like a
 *  bug rather than a fix. */
const MIN_LEADING_PARTIAL_CHARS = 8;

function redactLeadingPartial(text: string, value: string): string {
  const maxLen = Math.min(value.length, text.length);
  for (let len = maxLen; len >= MIN_LEADING_PARTIAL_CHARS; len--) {
    if (text.startsWith(value.slice(value.length - len))) {
      return `«redacted»${text.slice(len)}`;
    }
  }
  return text;
}

/** Exact-value (and common-encoding) substring redaction for ONE string
 *  field's own text, plus a tail-cut-safe leading-partial check (above).
 *  Never applied to a whole JSON blob -- see redactLegResultFields, below,
 *  which is what every real call site in this codebase uses. Exported on its
 *  own for direct testing of the encoding forms, and as the fallback when a
 *  result body is not parseable JSON at all (outbound-handler.ts). */
export function redactKnownSecretValues(text: string, values: readonly string[]): string {
  let out = text;
  for (const value of values) {
    if (value === "") continue;
    for (const form of encodedForms(value)) out = out.split(form).join("«redacted»");
    out = redactLeadingPartial(out, value);
  }
  return out;
}

/** The free-text fields a leg result may carry, across both shapes this
 *  feature redacts: the DO's own LegResult (description, summary -- run-leg.ts)
 *  and the container's full LegOutput written to R2 (adds stdout, stderr --
 *  log.ts). Every field is optional because either shape may omit any of them. */
export interface RedactableLegFields {
  description?: string;
  summary?: string;
  stdout?: string;
  stderr?: string;
}

/** Redacts ONLY these four free-text fields -- never `state` (a fixed enum)
 *  and never any other key or structural token -- so a granted value can
 *  never corrupt the result's own shape, however short or common it is. An
 *  empty `values` list returns `result` unchanged (no allocation). */
export function redactLegResultFields<T extends RedactableLegFields>(result: T, values: readonly string[]): T {
  if (values.length === 0) return result;
  const redact = (s: string | undefined): string | undefined => (s === undefined ? undefined : redactKnownSecretValues(s, values));
  return {
    ...result,
    ...(result.description === undefined ? {} : { description: redact(result.description) }),
    ...(result.summary === undefined ? {} : { summary: redact(result.summary) }),
    ...(result.stdout === undefined ? {} : { stdout: redact(result.stdout) }),
    ...(result.stderr === undefined ? {} : { stderr: redact(result.stderr) }),
  };
}
