// #1348: the one scrub every evidence/log description passes through.
// Defense-in-depth: a WalkEngine should never echo storageState in a
// description, but if one does, it never reaches disk or a log line intact.
export function redact(text: string | undefined, secret: string): string | undefined {
  if (text === undefined || secret === "") return text;
  return text.split(secret).join("[REDACTED]");
}
