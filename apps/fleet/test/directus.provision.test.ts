// P5c — the project card's provisioning wiring, and the ruling that matters
// most about it: "Directus must be optional at boot: a studio still comes up
// when it is unreachable. A fifth store that can block provisioning is a
// fifth way to have no fleet." (design §7)
//
// Mocking style copied from test/studio.provision.test.ts, deliberately: a
// path-routed fetchBlueprintFile fake, a Map behind StudioStorage, sbExec
// tracked only for the bring-up exec's env argument.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import {
  provisionWithStorage, resolveBringupEnv, composePromptBlocks, ROLE_ENV_KEY, BRINGUP_CMD,
  type ProvisionDeps, type StudioStorage, type RoleEnv, type StudioEnv,
  type HealAttempt,
  type OperationInFlight,
} from "../src/studio/provision";
import { appendHouseRules } from "../src/studio/blueprint";
import { resolveProjectCard, type CardDeps } from "../src/directus/card";
import { recordStudio } from "../src/studio/registry";
import type { ProvisionConfig, StudioStatus } from "../src/studio/types";
import type { Env } from "../src/env";

const REPO_SLUG = "acme-org/websites";

const FAKE_FLEET_JSON = JSON.stringify({
  blueprint: { repo: REPO_SLUG, ref: "main" }, roles: ["pilot", "scratch"], instance_type: "standard-2",
});
const FAKE_ORG_JSON = JSON.stringify({ edges: { cto: ["release"] }, gates: { merge: ["release"] } });
const ROLE_PROMPT = "You are scratch. Sandbox role, low stakes.";
const FAKE_ROLE_MD = `---
name: scratch
skills: []
allowedTools: Bash(git *) Read
may_spawn: []
reports_to: operator
gates: []
---
${ROLE_PROMPT}
`;
const STUDIO_PROMPT = "You are the Web Designer, lead of Web Studio.";
const FAKE_STUDIO_MD = `---
name: web-studio
title: Web Studio
lead: Web Designer
skills: []
secrets: []
mcp: []
allowedTools: Bash(git *) Read
keep_alive: false
---
${STUDIO_PROMPT}
`;

const CARD = "## Estate — BETA landing (project key `beta`)\nSTAKES: go-live 2026-09-15 · fixed price.";
const BRIEF = "## Task #42\nShip the hero.";

function notFound(path: string, ref: string): Error {
  return new Error(`fetch ${path}@${ref} failed (404): Not Found`);
}

function blueprintFetch(): ProvisionDeps["fetchBlueprintFile"] {
  return vi.fn(async (_repo: string, path: string, ref: string) => {
    if (path === "fleet.json") return FAKE_FLEET_JSON;
    if (path === "fleet/blueprint/roles/scratch.md") return FAKE_ROLE_MD;
    if (path === "fleet/blueprint/org.json") return FAKE_ORG_JSON;
    if (path === "fleet/blueprint/studios/web-studio/studio.md") return FAKE_STUDIO_MD;
    throw notFound(path, ref);
  });
}

function fakeStorage(): StudioStorage {
  const map = new Map<string, StudioStatus | RoleEnv | StudioEnv | boolean | HealAttempt | OperationInFlight | string | number | null>();
  return {
    get: (async (key: string) => map.get(key)) as StudioStorage["get"],
    put: async (key: string, value: StudioStatus | RoleEnv | StudioEnv | boolean | HealAttempt | OperationInFlight | string | number | null) => { map.set(key, value); },
  };
}

function deps(sbExec?: ProvisionDeps["sbExec"]): ProvisionDeps {
  return {
    sbExec: sbExec ?? vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
    recordStudio: (status: StudioStatus) => recordStudio(env as unknown as Env, status),
    now: () => "2026-08-24T00:00:00.000Z",
    fetchBlueprintFile: blueprintFetch(),
  };
}

const prompt = (e: RoleEnv | StudioEnv): string =>
  new TextDecoder().decode(Uint8Array.from(atob(e.ROLE_PROMPT_B64), (c) => c.charCodeAt(0)));

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM fleet_state").run();
});

describe("composePromptBlocks — one append block, card before brief", () => {
  it("puts standing estate context ahead of the specific task", () => {
    expect(composePromptBlocks(CARD, BRIEF)).toBe(`${CARD}\n\n${BRIEF}`);
  });

  it("collapses to whichever half exists", () => {
    expect(composePromptBlocks(CARD, undefined)).toBe(CARD);
    expect(composePromptBlocks(undefined, BRIEF)).toBe(BRIEF);
  });

  it("yields undefined when neither exists — byte-identical to the pre-P5c call", () => {
    expect(composePromptBlocks(undefined, undefined)).toBeUndefined();
    expect(composePromptBlocks("", "   ")).toBeUndefined();
  });
});

describe("the card reaches the lead prompt", () => {
  it("appends it to a ROLE prompt, ahead of the task brief", async () => {
    const cfg: ProvisionConfig = { repo: "beta", role: "scratch", projectCard: CARD, briefPrompt: BRIEF };
    const { bringupEnv } = await resolveBringupEnv(deps(), cfg, REPO_SLUG, REPO_SLUG);
    expect(prompt(bringupEnv)).toBe(`${appendHouseRules(ROLE_PROMPT)}\n\n${CARD}\n\n${BRIEF}\n`);
  });

  it("appends it to a STUDIO prompt too — one composition, not two", async () => {
    const cfg: ProvisionConfig = { repo: "beta", role: "web-studio", projectCard: CARD };
    const { bringupEnv } = await resolveBringupEnv(deps(), cfg, REPO_SLUG, REPO_SLUG);
    expect(prompt(bringupEnv)).toBe(`${appendHouseRules(STUDIO_PROMPT)}\n\n${CARD}\n`);
  });

  it("leaves the prompt untouched when there is no card and no brief", async () => {
    const { bringupEnv } = await resolveBringupEnv(deps(), { repo: "beta", role: "scratch" }, REPO_SLUG, REPO_SLUG);
    // Untouched BY THE CARD — the house rules are the unconditional baseline.
    expect(prompt(bringupEnv)).toBe(appendHouseRules(ROLE_PROMPT));
  });

  it("rides into stored ROLE_ENV, so a restart reuses it without Directus being reachable", async () => {
    const storage = fakeStorage();
    const status = await provisionWithStorage(
      deps(), storage, { repo: "beta", role: "scratch", projectCard: CARD }, REPO_SLUG,
    );
    expect(status.state).toBe("running");
    const stored = (await storage.get(ROLE_ENV_KEY)) as RoleEnv;
    expect(prompt(stored)).toContain(CARD);
  });

  it("is the exact env handed to bring-up", async () => {
    const bringupEnvs: (Record<string, string> | undefined)[] = [];
    const sbExec = vi.fn(async (cmd: string, execEnv?: Record<string, string>) => {
      if (cmd === BRINGUP_CMD) bringupEnvs.push(execEnv);
      return { code: 0, stdout: "", stderr: "" };
    });
    const storage = fakeStorage();
    await provisionWithStorage(deps(sbExec), storage, { repo: "beta", role: "scratch", projectCard: CARD }, REPO_SLUG);
    expect(bringupEnvs).toHaveLength(1);
    expect(bringupEnvs[0]).toEqual(await storage.get(ROLE_ENV_KEY));
  });
});

describe("FAIL-OPEN: a studio boots with Directus absent, broken or unreachable", () => {
  // The ruling, in one sentence: a fifth store that can block provisioning is
  // a fifth way to have no fleet. Each case below resolves the card exactly
  // as src/studio/routes.ts does, then provisions with whatever came back.
  const provisionAsRouteWould = async (
    workerEnv: Partial<Env>, cardDeps: CardDeps,
  ): Promise<{ status: StudioStatus; card: string | null }> => {
    const card = await resolveProjectCard(
      { ...(env as unknown as Env), ...workerEnv } as Env, "beta", cardDeps,
    );
    const cfg: ProvisionConfig = {
      repo: "beta", role: "scratch", ...(card === null ? {} : { projectCard: card }),
    };
    const status = await provisionWithStorage(deps(), fakeStorage(), cfg, REPO_SLUG);
    return { status, card };
  };

  const exploding: CardDeps = { fetchEstate: () => { throw new Error("must not be called"); } };
  const rejecting = (err: unknown): CardDeps => ({ fetchEstate: () => Promise.reject(err) });

  it("boots with NO credential configured — P5c's shipped state", async () => {
    const { status, card } = await provisionAsRouteWould(
      { DIRECTUS_URL: undefined, DIRECTUS_TOKEN: undefined }, exploding,
    );
    expect(card).toBeNull();
    expect(status.state).toBe("running");
    expect(status.error).toBeNull();
  });

  it("boots when Directus is unreachable", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { status, card } = await provisionAsRouteWould(
      { FLEET_DIRECTUS: "on", DIRECTUS_URL: "https://estate.example.com", DIRECTUS_TOKEN: "tok" },
      rejecting(new TypeError("Network connection lost")),
    );
    expect(card).toBeNull();
    expect(status.state).toBe("running");
    vi.restoreAllMocks();
  });

  it("boots when Directus answers 500", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { status } = await provisionAsRouteWould(
      { FLEET_DIRECTUS: "on", DIRECTUS_URL: "https://estate.example.com", DIRECTUS_TOKEN: "tok" },
      rejecting(new Error("directus estate_projects failed (500): boom")),
    );
    expect(status.state).toBe("running");
    vi.restoreAllMocks();
  });

  it("boots when Directus times out", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const timeout = Object.assign(new Error("The operation was aborted"), { name: "TimeoutError" });
    const { status } = await provisionAsRouteWould(
      { FLEET_DIRECTUS: "on", DIRECTUS_URL: "https://estate.example.com", DIRECTUS_TOKEN: "tok" }, rejecting(timeout),
    );
    expect(status.state).toBe("running");
    vi.restoreAllMocks();
  });

  it("boots when the repo has no estate row at all", async () => {
    const { status, card } = await provisionAsRouteWould(
      { FLEET_DIRECTUS: "on", DIRECTUS_URL: "https://estate.example.com", DIRECTUS_TOKEN: "tok" },
      { fetchEstate: () => Promise.resolve(null) },
    );
    expect(card).toBeNull();
    expect(status.state).toBe("running");
  });

  it("produces a bring-up env identical to the pre-P5c one when there is no card", async () => {
    // The strongest version of "optional": not merely "does not fail", but
    // "is not observable at all". A fleet with no Directus must be the fleet
    // that existed before this feature landed.
    const withoutFeature = await resolveBringupEnv(deps(), { repo: "beta", role: "scratch" }, REPO_SLUG, REPO_SLUG);
    const { card } = await provisionAsRouteWould({}, exploding);
    const asRouted = await resolveBringupEnv(
      deps(), { repo: "beta", role: "scratch", ...(card === null ? {} : { projectCard: card }) }, REPO_SLUG, REPO_SLUG,
    );
    expect(asRouted.bringupEnv).toEqual(withoutFeature.bringupEnv);
  });
});
