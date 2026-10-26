// #1348 review r1 item 2: "no usable auth" is a property of the VALUE, not
// just its presence. "" and a Playwright storage state with no cookies and
// no origin localStorage entries both carry zero real secret values, same
// as a missing credential — none of the three may reach the engine.
interface ParsedStorageState {
  cookies: { value?: unknown }[];
  origins: { localStorage?: { value?: unknown }[] }[];
}

function tryParse(raw: string): ParsedStorageState | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const p = parsed as Record<string, unknown>;
  return {
    cookies: Array.isArray(p.cookies) ? (p.cookies as { value?: unknown }[]) : [],
    origins: Array.isArray(p.origins) ? (p.origins as { localStorage?: { value?: unknown }[] }[]) : [],
  };
}

/** Every individual secret value this storage state carries: each cookie's
 *  value, each origin's localStorage entry value. Non-JSON input (not
 *  Playwright-shaped) falls back to the whole string as one opaque value —
 *  still sensitive, just not in the expected shape. */
export function secretValues(raw: string): string[] {
  if (raw === "") return [];
  const parsed = tryParse(raw);
  if (parsed === null) return [raw];
  const values: string[] = [];
  for (const cookie of parsed.cookies) {
    if (typeof cookie.value === "string" && cookie.value !== "") values.push(cookie.value);
  }
  for (const origin of parsed.origins) {
    for (const entry of origin.localStorage ?? []) {
      if (typeof entry.value === "string" && entry.value !== "") values.push(entry.value);
    }
  }
  return values;
}

export function hasUsableAuth(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  return secretValues(raw).length > 0;
}
