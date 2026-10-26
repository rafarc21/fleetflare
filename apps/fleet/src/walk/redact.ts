// #1348: the one scrub every evidence/log description passes through.
// Defense-in-depth: a WalkEngine should never echo a secret value in a
// description, but if one does, it never reaches disk or a log line intact.
export function redact(text: string | undefined, secret: string): string | undefined {
  if (text === undefined || secret === "") return text;
  return text.split(secret).join("[REDACTED]");
}

function toBase64(value: string): string {
  try {
    return btoa(value);
  } catch {
    // Non-Latin1 input (btoa's own limit): no base64 form to scrub against.
    return "";
  }
}

function toJsonEscaped(value: string): string {
  // JSON.stringify("x") -> '"x"'; strip the surrounding quotes to get just
  // the escaped body, the form a value takes nested inside another string.
  return JSON.stringify(value).slice(1, -1);
}

/** Every textual form one secret value might appear in. #1348 review r1
 *  item 3: a probe found a lone value leaking re-encoded (JSON-escaped,
 *  URL-encoded, base64) past a redact() call scoped to the whole blob — each
 *  form is scrubbed independently of how the rest of the text is shaped. */
function variantsOf(value: string): string[] {
  return [...new Set([value, toJsonEscaped(value), encodeURIComponent(value), toBase64(value)].filter((v) => v !== ""))];
}

/** Scrubs every encoding of every value in `values` out of `text`. The
 *  caller passes individual secret values (storage-state.ts's
 *  secretValues()), never the whole storage-state blob: a value redacted on
 *  its own catches it wherever it surfaces, blob-wide substring matching on
 *  the whole secret does not. */
export function redactValues(text: string | undefined, values: string[]): string | undefined {
  let out = text;
  for (const value of values) {
    if (value === "") continue;
    for (const variant of variantsOf(value)) {
      out = redact(out, variant);
    }
  }
  return out;
}
