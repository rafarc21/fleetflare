/**
 * Issue #7: who is calling the write proxy, and which repo it may write.
 *
 * The spawn token is the container's one Worker credential (same as
 * /fleet/tasks and /fleet/junior). git sends it as a Basic-auth password
 * (a credential helper scoped to the Worker URL, see container-config.ts);
 * fleet-gh-proxy sends the X-Fleet-Spawn-Token header. Either is accepted.
 *
 * A studio writes its OWN work repo only -- the row's bound repo, else the
 * fleet default, exactly as the board resolves it -- so the Worker's write
 * token is never lent to a repo the studio was not bound to.
 */
import { resolveSpawnParent, SPAWN_TOKEN_HEADER, type SpawnParent } from "../studio/spawn";
import type { StudioStatus } from "../studio/types";

function basicPassword(header: string | null): string | null {
  const m = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(header ?? "");
  if (!m) return null;
  let decoded: string;
  try {
    decoded = atob(m[1]);
  } catch {
    return null;
  }
  const colon = decoded.indexOf(":");
  return colon < 0 ? null : decoded.slice(colon + 1);
}

export async function studioFromRequest(req: Request, rows: StudioStatus[]): Promise<SpawnParent | null> {
  const presented = req.headers.get(SPAWN_TOKEN_HEADER) ?? basicPassword(req.headers.get("authorization"));
  return resolveSpawnParent(rows, presented);
}

export function studioWorkRepo(studio: SpawnParent, defaultRepo: string): string {
  return (studio.repoSlug ?? defaultRepo).toLowerCase();
}
