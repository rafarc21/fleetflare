export interface DeployTarget {
  id: string;
  project: string;
  repo: string;
  ref: string;
  workdir: string;
  command: string;
  secrets: string[];
  env: string;
}

interface Row {
  id: string; project: string; repo: string; ref: string;
  workdir: string; command: string; secrets: string; env: string;
}

/**
 * Returns null for an unknown id. Callers must refuse rather than substitute a
 * default: a deploy that runs the wrong command is worse than one that does not
 * run at all.
 */
export async function getDeployTarget(
  db: D1Database, id: string,
): Promise<DeployTarget | null> {
  const r = await db
    .prepare(`SELECT * FROM deploy_targets WHERE id = ?`)
    .bind(id)
    .first<Row>();
  if (!r) return null;
  return { ...r, secrets: JSON.parse(r.secrets) as string[] };
}
