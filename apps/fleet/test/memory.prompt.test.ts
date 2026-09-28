import { describe, it, expect, vi } from "vitest";
import { resolveBringupEnv, type ProvisionDeps } from "../src/studio/provision";
import { memoryIndexPrompt, MEMORY_INDEX_MAX_LINES } from "../src/memory/prompt";
import { appendHouseRules, appendMemoryIndex, roleBringupEnv } from "../src/studio/blueprint";
import { studioBringupEnv } from "../src/studio/studio-blueprint";
import type { Role } from "../src/studio/blueprint";
import type { Studio } from "../src/studio/studio-blueprint";

const INDEX = "# Fleet memory index\n\nblurb\n\n- [CF rollout](websites--pilot/a.md) — bump rollout_step_percentage to 100\n- [ipv6 bind](websites--web-studio/b.md) — curl 127.0.0.1 fakes a dead server\n";

const decode = (b64: string) => new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));

describe("memoryIndexPrompt", () => {
  it("carries the lines and nothing else — the index is the only tier that costs tokens", () => {
    const block = memoryIndexPrompt(INDEX)!;
    expect(block).toContain("- [CF rollout](websites--pilot/a.md) — bump rollout_step_percentage to 100");
    expect(block).toContain("- [ipv6 bind]");
    expect(block).not.toContain("blurb");
  });

  it("tells the studio where the files themselves are, and that archive/ is greppable", () => {
    const block = memoryIndexPrompt(INDEX)!;
    // #341: the store is its own repo, cloned at /opt/memory.
    expect(block).toContain("/opt/memory");
    expect(block).not.toContain("/opt/blueprint");
    expect(block).toContain("fleet/memory");
    expect(block).toMatch(/archive/);
  });

  it("is null for an empty or entry-less index — never an empty heading with nothing under it", () => {
    expect(memoryIndexPrompt("")).toBeNull();
    expect(memoryIndexPrompt("# Fleet memory index\n\nnothing yet\n")).toBeNull();
  });

  it("is null for an index it cannot parse, rather than pasting junk into a system prompt", () => {
    expect(memoryIndexPrompt("- [broken](a.md\n")).toBeNull();
  });

  it("truncates a runaway index and SAYS it truncated, naming where the rest is", () => {
    const many = Array.from({ length: MEMORY_INDEX_MAX_LINES + 10 }, (_, i) => `- [t${i}](s/${i}.md) — fact ${i}`).join("\n");
    const block = memoryIndexPrompt(many)!;
    expect(block).toContain(`- [t${MEMORY_INDEX_MAX_LINES - 1}](s/${MEMORY_INDEX_MAX_LINES - 1}.md)`);
    expect(block).not.toContain(`- [t${MEMORY_INDEX_MAX_LINES}](`);
    expect(block).toMatch(/truncat/i);
    expect(block).toContain("fleet/memory/INDEX.md");
  });
});

describe("appendMemoryIndex", () => {
  it("appends, never replaces", () => {
    expect(appendMemoryIndex("lead prompt", "MEM")).toBe("lead prompt\n\nMEM\n");
  });
  it("returns the prompt byte for byte when there is no index — every studio that predates this", () => {
    expect(appendMemoryIndex("lead prompt", null)).toBe("lead prompt");
    expect(appendMemoryIndex("lead prompt", "")).toBe("lead prompt");
  });
});

describe("the index rides the ROLE_PROMPT_B64 channel that is already there", () => {
  const role: Role = {
    name: "pilot", prompt: "you are the pilot", allowedTools: "Bash(fleet *)",
    keep_alive: false,
  } as unknown as Role;
  const studio: Studio = {
    name: "web-studio", title: "Web Studio", lead: "Web Designer",
    prompt: "you are the lead", allowedTools: "Bash(fleet *)",
    skills: [], secrets: [], mcp: [], keep_alive: true,
  } as unknown as Studio;

  it("role path: memory before the brief, so the task stays last and most salient", () => {
    const env = roleBringupEnv(role, "TASK BRIEF", memoryIndexPrompt(INDEX));
    const prompt = decode(env.ROLE_PROMPT_B64);
    expect(prompt.indexOf("Fleet memory")).toBeGreaterThan(prompt.indexOf("you are the pilot"));
    expect(prompt.indexOf("TASK BRIEF")).toBeGreaterThan(prompt.indexOf("Fleet memory"));
  });

  it("studio path: same one channel, no second env var to forget", () => {
    const env = studioBringupEnv(studio, [], "TASK BRIEF", memoryIndexPrompt(INDEX));
    expect(decode(env.ROLE_PROMPT_B64)).toContain("rollout_step_percentage");
    expect(Object.keys(env)).not.toContain("MEMORY_INDEX_B64");
  });

  it("no index means the prompt is unchanged — a studio still boots when memory is unreachable", () => {
    // Unchanged BY MEMORY: the house rules every prompt carries
    // unconditionally are the baseline, not something the index added.
    expect(decode(studioBringupEnv(studio, [], undefined, null).ROLE_PROMPT_B64))
      .toBe(appendHouseRules("you are the lead"));
  });
});

// The read side, end to end through resolveBringupEnv: a studio boots knowing
// what the fleet learned, and boots anyway when it cannot find out.
describe("resolveBringupEnv injects the index at provision (§7)", () => {
  const FLEET_JSON = JSON.stringify({
    blueprint: { repo: "o/blueprint", ref: "main" }, roles: ["pilot", "web-studio"], instance_type: "standard-2",
  });
  const ROLE_MD = "---\nname: pilot\nskills: []\nallowedTools: Bash(fleet *)\nmay_spawn: []\nreports_to: operator\ngates: []\n---\nyou are the pilot\n";
  const STUDIO_MD = "---\nname: web-studio\ntitle: Web Studio\nlead: Web Designer\nskills: []\nsecrets: []\nmcp: []\nallowedTools: Bash(fleet *)\nkeep_alive: false\n---\nyou are the lead\n";

  function deps(files: Record<string, string>, memoryRepo: string | null = "o/fleet-memory") {
    const fetchBlueprintFile = vi.fn(async (_repo: string, path: string, ref: string) => {
      const hit = files[path];
      if (hit === undefined) throw new Error(`fetch ${path}@${ref} failed (404): Not Found`);
      return hit;
    });
    return {
      sbExec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
      recordStudio: vi.fn(async () => {}),
      now: () => "2026-09-10T00:00:00.000Z",
      fetchBlueprintFile,
      memoryRepo,
    } as unknown as ProvisionDeps;
  }

  it("role path: the index reaches ROLE_PROMPT_B64", async () => {
    const d = deps({
      "fleet.json": FLEET_JSON,
      "fleet/blueprint/roles/pilot.md": ROLE_MD,
      "fleet/blueprint/org.json": "{}",
      "fleet/memory/INDEX.md": INDEX,
    });
    const { bringupEnv } = await resolveBringupEnv(d, { repo: "websites", role: "pilot" }, "o/fleet", "o/fleet");
    expect(decode(bringupEnv.ROLE_PROMPT_B64)).toContain("rollout_step_percentage");
  });

  it("studio path: same", async () => {
    const d = deps({
      "fleet.json": FLEET_JSON,
      "fleet/blueprint/studios/web-studio/studio.md": STUDIO_MD,
      "fleet/memory/INDEX.md": INDEX,
    });
    const { bringupEnv } = await resolveBringupEnv(d, { repo: "websites", role: "web-studio" }, "o/fleet", "o/fleet");
    expect(decode(bringupEnv.ROLE_PROMPT_B64)).toContain("Fleet memory (index)");
  });

  it("no index yet: the studio still provisions, prompt untouched — memory never blocks a bring-up", async () => {
    const d = deps({
      "fleet.json": FLEET_JSON,
      "fleet/blueprint/studios/web-studio/studio.md": STUDIO_MD,
    });
    const { bringupEnv } = await resolveBringupEnv(d, { repo: "websites", role: "web-studio" }, "o/fleet", "o/fleet");
    expect(decode(bringupEnv.ROLE_PROMPT_B64)).toBe(appendHouseRules("you are the lead"));
  });

  it("index read fails for a real reason: logged, still boots", async () => {
    const files: Record<string, string> = {
      "fleet.json": FLEET_JSON,
      "fleet/blueprint/studios/web-studio/studio.md": STUDIO_MD,
    };
    const fetchBlueprintFile = vi.fn(async (_r: string, path: string, ref: string) => {
      if (path === "fleet/memory/INDEX.md") throw new Error("fetch INDEX.md@main failed (500): boom");
      const hit = files[path];
      if (hit === undefined) throw new Error(`fetch ${path}@${ref} failed (404): Not Found`);
      return hit;
    });
    const d = { sbExec: vi.fn(), recordStudio: vi.fn(), now: () => "", fetchBlueprintFile } as unknown as ProvisionDeps;
    const { bringupEnv } = await resolveBringupEnv(d, { repo: "websites", role: "web-studio" }, "o/fleet", "o/fleet");
    expect(decode(bringupEnv.ROLE_PROMPT_B64)).toBe(appendHouseRules("you are the lead"));
  });

  // #341: the index lives in the memory STORE (FLEET_OPS_REPO), read at its
  // default branch -- never the blueprint repo, never the fleet repo.
  it("the index is read from the memory store at HEAD, never the blueprint or fleet repo", async () => {
    const d = deps({
      "fleet.json": FLEET_JSON,
      "fleet/blueprint/studios/web-studio/studio.md": STUDIO_MD,
      "fleet/memory/INDEX.md": INDEX,
    });
    await resolveBringupEnv(d, { repo: "websites", role: "web-studio" }, "o/fleet", "o/fleet");
    expect(d.fetchBlueprintFile).toHaveBeenCalledWith("o/fleet-memory", "fleet/memory/INDEX.md", "HEAD");
    expect(d.fetchBlueprintFile).not.toHaveBeenCalledWith("o/blueprint", "fleet/memory/INDEX.md", expect.anything());
  });

  it("no store configured (FLEET_OPS_REPO unset): the index is never fetched, and the studio still boots", async () => {
    const d = deps({
      "fleet.json": FLEET_JSON,
      "fleet/blueprint/studios/web-studio/studio.md": STUDIO_MD,
      "fleet/memory/INDEX.md": INDEX,
    }, null);
    const { bringupEnv } = await resolveBringupEnv(d, { repo: "websites", role: "web-studio" }, "o/fleet", "o/fleet");
    expect(d.fetchBlueprintFile).not.toHaveBeenCalledWith(expect.anything(), "fleet/memory/INDEX.md", expect.anything());
    expect(decode(bringupEnv.ROLE_PROMPT_B64)).toBe(appendHouseRules("you are the lead"));
  });
});
