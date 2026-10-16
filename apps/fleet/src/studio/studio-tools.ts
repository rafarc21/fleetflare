// Issue #1160 (option 2): per-repo opt-in studio tools. A repo declares
// `studio.tools` in its OWN root fleet.json; bring-up installs only the
// allow-listed names it finds there. Nothing here installs anything: this
// module only parses the declaration. The install lives in
// container/studio-bringup.sh's studio-tools region, which reads the names
// from STUDIO_TOOLS, and that list must stay in step with this allow-list.
import { BlueprintError } from "./blueprint";

/** Tools a repo may declare. Anything else is a config error, not a silent
 *  skip: a typo should fail loudly at provision, not leave a studio without
 *  the tool it asked for. */
export const STUDIO_TOOL_ALLOWLIST: readonly string[] = ["azure-cli"];

/**
 * Reads `studio.tools` out of one repo's fleet.json text. Absent (no
 * `studio` block, or no `tools` key, or an empty array) means no tools. A
 * present value must be an array of allow-listed names; anything else throws
 * a BlueprintError naming the field, same contract parseFleetJson keeps.
 */
export function parseStudioTools(fleetJsonText: string): string[] {
  let raw: unknown;
  try {
    raw = JSON.parse(fleetJsonText);
  } catch (err) {
    throw new BlueprintError("studio.tools", `invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new BlueprintError("studio.tools", "fleet.json must be a JSON object");
  }
  const studio = (raw as Record<string, unknown>).studio;
  if (studio === undefined) return [];
  if (typeof studio !== "object" || studio === null || Array.isArray(studio)) {
    throw new BlueprintError("studio", "must be an object when present");
  }
  const tools = (studio as Record<string, unknown>).tools;
  if (tools === undefined) return [];
  if (!Array.isArray(tools) || !tools.every((t) => typeof t === "string")) {
    throw new BlueprintError("studio.tools", "must be an array of strings");
  }
  for (const tool of tools as string[]) {
    if (!STUDIO_TOOL_ALLOWLIST.includes(tool)) {
      throw new BlueprintError("studio.tools", `unknown tool "${tool}" (allowed: ${STUDIO_TOOL_ALLOWLIST.join(", ")})`);
    }
  }
  return [...(tools as string[])];
}
