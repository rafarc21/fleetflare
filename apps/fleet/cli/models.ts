// apps/fleet/cli/models.ts — `fleet models [assign <studio> <model> |
// promote <model> | demote <model>]` (#717: the operator surface for the
// non-Claude lead model pool). Same request-building shape
// cli/accounts.ts's postAccountsVerb/fetchAccountsApi already use — one
// Access-headers GET for the list, one POST per write verb, a thrown Error
// on anything but a 2xx.
import { accessHeaders, type Credentials } from "./fleet";
import { errText, ERROR_SNIPPET_MAX_CHARS } from "./diag";

interface ModelsListRow {
  key: string;
  id: string;
  state: string;
  smokePassed: boolean;
}

interface ModelsListResponse {
  models: ModelsListRow[];
  assignments: Record<string, string>;
}

async function fetchModelsList(creds: Credentials): Promise<ModelsListResponse> {
  let res: Response;
  try {
    res = await fetch(new URL("/studio/models", creds.workerUrl), {
      headers: { ...accessHeaders(creds), Accept: "application/json" },
    });
  } catch (err) {
    throw new Error(`fleet models: could not reach ${creds.workerUrl}: ${errText(err)}`);
  }
  if (!res.ok) {
    throw new Error(`fleet models: ${res.status} ${(await res.text()).slice(0, ERROR_SNIPPET_MAX_CHARS)}`);
  }
  return (await res.json()) as ModelsListResponse;
}

async function postModelsVerb(creds: Credentials, verb: "assign" | "promote" | "demote", body: object): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(new URL(`/studio/models/${verb}`, creds.workerUrl), {
      method: "POST",
      headers: { ...accessHeaders(creds), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(`fleet models ${verb}: could not reach ${creds.workerUrl}: ${errText(err)}`);
  }
  if (!res.ok) {
    throw new Error(`fleet models ${verb}: ${res.status} ${(await res.text()).slice(0, ERROR_SNIPPET_MAX_CHARS)}`);
  }
  return res.json();
}

/** `fleet models` (bare): the pool table, then every studio's own
 *  assignment — two tables rather than one join, since not every pool
 *  model has a studio pointed at it (and not every studio has an explicit
 *  assignment — see router.ts's own round-robin default for what fills
 *  the gap). */
export async function cmdModelsLs(creds: Credentials): Promise<void> {
  try {
    const { models, assignments } = await fetchModelsList(creds);
    console.log("KEY       ID                                       STATE     SMOKE");
    for (const m of models) {
      console.log(`${m.key.padEnd(9)} ${m.id.padEnd(40)} ${m.state.padEnd(9)} ${m.smokePassed ? "yes" : "no"}`);
    }
    console.log("");
    console.log("STUDIO                            MODEL");
    for (const [studio, model] of Object.entries(assignments)) {
      console.log(`${studio.padEnd(33)} ${model}`);
    }
  } catch (err) {
    console.error(errText(err));
    process.exit(1);
  }
}

/** `fleet models assign <studio> <model>` — POST /studio/models/assign.
 *  `model` is either a pool key ("kimi") or the raw Workers AI id; the
 *  route resolves either (models-route.ts's own `resolve`). */
export async function cmdModelsAssign(creds: Credentials, studio: string, model: string): Promise<void> {
  try {
    await postModelsVerb(creds, "assign", { studio, model });
    console.log(`fleet models assign: ${studio} -> ${model}`);
  } catch (err) {
    console.error(errText(err));
    process.exit(1);
  }
}

/** `fleet models promote|demote <model>` — POST /studio/models/promote or
 *  /demote. */
export async function cmdModelsSet(creds: Credentials, state: "promote" | "demote", model: string): Promise<void> {
  try {
    await postModelsVerb(creds, state, { model });
    console.log(`fleet models ${state}: ${model}`);
  } catch (err) {
    console.error(errText(err));
    process.exit(1);
  }
}
