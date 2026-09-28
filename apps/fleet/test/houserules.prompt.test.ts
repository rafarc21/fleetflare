import { describe, it, expect } from "vitest";
import { appendHouseRules, HOUSE_RULES, roleBringupEnv } from "../src/studio/blueprint";
import { collapseWs } from "./collapse-ws";
import { studioBringupEnv } from "../src/studio/studio-blueprint";
import type { Role } from "../src/studio/blueprint";
import type { Studio } from "../src/studio/studio-blueprint";

const decode = (b64: string) => new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));

const role: Role = {
  name: "pilot", prompt: "you are the pilot", allowedTools: "Bash(fleet *)", keep_alive: false,
} as unknown as Role;

const studio: Studio = {
  name: "web-studio", title: "Web Studio", lead: "Web Designer",
  prompt: "you are the lead", allowedTools: "Bash(fleet *)",
  skills: [], secrets: [], mcp: [], keep_alive: true,
} as unknown as Studio;

// The rules are TEXT in the system prompt, not a declared skill: SKILL.md
// carries `disable-model-invocation: true`, so vendoring alone would never
// make the shape always-on. These assertions are what "always-on" means.
//
// Issue #330 round 2 (maestro review): the "operator-output contract"
// describe block that used to live here (caveman/i-have-adhd shape rules,
// a "presentation only" clause, an operator-message scope statement) pinned
// content that round 1 correctly moved OUT of the neutral, product-wide
// default — it is operator-owned overlay content now (see
// test/studio.blueprint.test.ts's "HOUSE_RULES — neutral default (issue
// #330)" for the negative regression guard: none of those strings belong
// here). Those four tests are deleted, not fixed, because the behavior they
// pinned is gone by design, not by bug.
describe("HOUSE_RULES — repository language (issue #66)", () => {
  // Board issue #66: a standing rule every studio inherits, WHAT and WHY.
  it("says all repository content is English, and why", () => {
    expect(HOUSE_RULES).toMatch(/all repository content is English/i);
    expect(HOUSE_RULES).toMatch(/board issues/i);
    expect(HOUSE_RULES).toMatch(/commit messages/i);
    expect(HOUSE_RULES).toMatch(/do not share the operator's first language/i);
  });

  // #128 review N1: the rules reach studios on EVERY repo, some of whose
  // product copy is Portuguese. UX copy is exempt.
  //
  // Round 2 review item 7: the OLD text here ("This project's own CI
  // enforces it via its english-check gate.") reads as a blanket claim that
  // EVERY deployment of this software runs the same english-check CI gate
  // rafarc21/fleetflare does — false for a stranger who clones this software
  // and wires no such gate. Reworded to state the rule conditionally: CI
  // enforcement is described as something a deployment MAY have, never
  // asserted as universal, and the repo-named form ("In rafarc21/fleetflare,
  // CI enforces it") stays out of the neutral default for the same reason
  // any other hardcoded repo slug does (see this file's own "MOVED OUT" doc
  // comment on HOUSE_RULES in blueprint.ts).
  it("exempts UX copy and states CI enforcement conditionally, never as a universal claim", () => {
    const language = HOUSE_RULES.slice(HOUSE_RULES.indexOf("repository language"));
    expect(language).toMatch(/UX copy/);
    expect(language).toMatch(/product's own language/);
    expect(language).toMatch(/an english-check gate/i);
    expect(language).toMatch(/the rule applies/i);
    expect(language).not.toMatch(/This project's own CI enforces it/);
    expect(language).not.toMatch(/rafarc21\/fleetflare/);
  });

  // Board issue #267's own fix ("GitHub Actions is disabled on
  // rafarc21/fleetflare, CI is the local-ci commit status instead") is ONE
  // operator's own CI infrastructure choice, not a universal default —
  // round 1 already moved it out (blueprint.ts's own "MOVED OUT" doc
  // comment). This is the regression guard proving it stays out: the OLD
  // version of this test asserted the OPPOSITE (that this content WAS
  // present), which is exactly the bug round 1 fixed and round 2 re-checks.
  it("never hardcodes this repo's own CI infrastructure (local-ci commit status, Actions disabled) — that is operator overlay content now", () => {
    expect(HOUSE_RULES).not.toMatch(/local-ci\/fleet-check/);
    expect(HOUSE_RULES).not.toMatch(/Actions is disabled/);
    expect(HOUSE_RULES).not.toMatch(/commits\/<sha>\/status/);
  });
});

// Issue #330 round 2 (maestro review item 4): "every link is a full URL" is
// generic engineering communication discipline, not one operator's own
// preference — round 1 swept it out of the neutral default BY MISTAKE,
// alongside the genuinely operator-specific caveman/i-have-adhd mandate, in
// the same diff hunk (git history: e7b38c1). Restored here, genericized:
// the original text's own broken-URL EXAMPLE named one operator's own infra
// (a maestro name, a workers.dev URL under that operator's own project) —
// the example stays out, the rule itself stays in, because it is true for
// every operator.
describe("HOUSE_RULES — links are full URLs (issue #330 round 2, restored to the neutral default)", () => {
  const rules = () => collapseWs(HOUSE_RULES);

  it("names the section", () => {
    expect(HOUSE_RULES).toContain("## House rules — links are full URLs");
  });

  it("states the rule: full URLs only, never a bare slug or path fragment", () => {
    expect(rules()).toMatch(
      /Every link you write is a full URL \(https:\/\/host\/path\), never a bare slug or path fragment/,
    );
  });

  it("says the full GitHub URL IS the link for a PR or issue, #number a trailing label only", () => {
    expect(rules()).toMatch(
      /the full GitHub URL IS the link; #number is a trailing label next to it, never the link itself/,
    );
  });

  it("carries none of the operator-specific broken-URL example this rule used to ship with", () => {
    const lower = HOUSE_RULES.toLowerCase();
    expect(lower).not.toContain("acme");
    expect(lower).not.toContain("examplehost");
  });
});

// Board issue #160. The #98 "one heavy gate at a time" rule was read as a rule
// about the DIFF. Cost lives in the VERIFICATION. Measured 2026-09-24 ~18:45Z:
// one-line task mutation-tested a heavy repo invariant; RED+GREEN ran FOUR vite
// builds in one container, hit the 11.65 GiB ceiling, wedged.
describe("HOUSE_RULES — the gate budget counts verification, not just the diff", () => {
  // Collapse before matching (test/collapse-ws.ts): HOUSE_RULES is an array of
  // wrapped lines, so a whole clause straddles a newline. Same helper the other
  // two gate-rule pin files use, so a rewrap breaks none of the three.
  const rules = () => collapseWs(HOUSE_RULES);

  // #171 item 3: HOUSE_RULES is the ONLY always-on copy maestro, pilot and
  // scratch ever see — no studio.md gate paragraph behind it. So it, not the
  // studio files, has to state the base rule and what a heavy gate IS.
  it("states the base rule and names what a heavy gate is", () => {
    expect(rules()).toMatch(
      /One heavy gate at a time: full test suite, vite build, repo-wide tsc, e2e, pre-push hooks\./,
    );
  });

  it("says the verification a task demands counts toward the gate budget", () => {
    expect(rules()).toMatch(/counts toward the gate budget/i);
  });

  // #171 item 1: the clause WHOLE. /twice/ alone also matched the e.g. example
  // one sentence later, so deleting this clause left the pin green — a pin that
  // cannot fail is not a pin.
  it("says a RED\/GREEN mutation test of a heavy check runs that check twice", () => {
    expect(rules()).toMatch(/RED\/GREEN mutation test of a heavy check runs that check twice/);
  });

  it("says one step at a time, never in parallel, never alongside another gate", () => {
    expect(rules()).toMatch(/one step at a time/i);
    expect(rules()).toMatch(/never in parallel/i);
    expect(rules()).toMatch(/never alongside another gate/i);
  });

  it("tells a task author to name heavy verification in the task's Boundaries", () => {
    expect(rules()).toMatch(/task author/i);
    expect(rules()).toMatch(/Boundaries/);
  });

  // #171 item 4: the incident stays in the rule, its numbers are NOT pinned.
  // `11.65 GiB` and the date are prose that gets reworded; pinning them made
  // the suite brittle without protecting one word of the rule.
});

// Board issue #235, measured 2026-09-25 by the BETA maestro: a studio container
// carries no CLOUDFLARE_API_TOKEN, so a task telling a studio to `wrangler
// deploy` or `d1 migrations apply --remote` cannot be completed inside one.
// BETA PR #829 hit exactly this; its release-studio found the gap, searched its
// own env, and correctly stopped — but only after burning minutes on it. This
// section says so up front so no studio has to rediscover it again.
describe("HOUSE_RULES — studios never hold Cloudflare deploy credentials", () => {
  // Collapse before matching, same reason as the gate-budget block above: a
  // whole clause can straddle the line-wrap boundary in the source array.
  const rules = () => collapseWs(HOUSE_RULES);

  it("states plainly that no studio ever holds Cloudflare deploy credentials", () => {
    expect(rules()).toMatch(/No studio ever holds Cloudflare deploy credentials/);
  });

  it("names both Cloudflare credentials: the wrangler var and the fleet's own deploy secret", () => {
    expect(rules()).toMatch(
      /No Cloudflare credential exists in any studio container: no CLOUDFLARE_API_TOKEN \(what wrangler reads\) and no CLOUDFLARE_DEPLOY_TOKEN \(the fleet's deploy secret, held only by the Worker-side deploy container\)/,
    );
  });

  // The whole clause, not a lone /deploy/ or /wrangler/ match: either word
  // alone also appears in unrelated prose elsewhere on the surface, so a lone
  // keyword pin would stay green even if this exact instruction were deleted.
  it("tells a studio to stop and say so instead of running the deploy commands itself", () => {
    expect(rules()).toMatch(
      /If a task tells you to `wrangler deploy` or `d1 migrations apply --remote`, stop and say so/,
    );
  });

  it("says deploys run Worker-side through fleet or by the operator directly, never on an in-container credential", () => {
    expect(rules()).toMatch(
      /Deploys run Worker-side through `fleet`, on the operator's own credential, or by the operator directly — never on a credential inside this container/,
    );
    expect(rules()).toMatch(/A studio's job after a deploy happens is verification/);
  });
});

// Board issue #253, measured 2026-09-25 06:02Z: a bare `git push` from a
// worktree whose branch carried `origin/main` as its upstream landed 6
// commits on main with no PR, no review, no CI. Provision-time git config +
// the /usr/local/bin/git wrapper (credentials.ts) close the mechanism; this
// section states the rule in the always-on prompt text too, for a studio that
// routes around its own tooling.
describe("HOUSE_RULES — studios never push the default branch", () => {
  const rules = () => collapseWs(HOUSE_RULES);

  it("states plainly that every change to the default branch goes through a PR", () => {
    expect(rules()).toMatch(
      /Every change to the default branch goes through a pull request: open one and let review \+ CI land it\./,
    );
  });

  // The whole clause, not a lone /push/ or /main/ keyword — either appears
  // in unrelated prose elsewhere on the surface (e.g. the deploy-credentials
  // section above), so a lone-keyword pin would stay green even if this
  // exact instruction were deleted.
  it("names both the bare push and the explicit refspec form, regardless of triviality", () => {
    expect(rules()).toMatch(
      /Never push the default branch directly — not with a bare `git push`, not with an explicit `git push origin HEAD:main`/,
    );
    expect(rules()).toMatch(/regardless of how trivial or test-only the change looks/);
  });

  // Maestro review of PR #259: the two workarounds a studio reaches for the
  // moment a push is refused. Both have to be named in the prompt text, not
  // only blocked by the wrapper — `--no-verify` does nothing to the wrapper
  // (it is not a hook), but a studio that believes it does will try it and
  // then go looking for something that works, and `/usr/bin/git` is what it
  // finds.
  it("forbids the two named workarounds around a refusal: --no-verify and calling /usr/bin/git directly", () => {
    expect(rules()).toMatch(
      /If a push is refused, that refusal is the answer: open a PR\. Never reach for `--no-verify` around it, and never call `\/usr\/bin\/git` \(or any other path\) to get around the `git` on your PATH\./,
    );
  });

  // Maestro round 2 of PR #259: git prepends its own exec-path onto the PATH of
  // anything it runs, and that directory holds a SECOND real git binary — so a
  // push issued from inside anything git itself spawns never reaches the
  // wrapper. The wrapper refuses a `!` alias whose text mentions push; the
  // other four routes (rebase -x, hooks, submodule foreach, bisect run) are a
  // named residual gap, which makes stating them in the prompt the only cover
  // they currently have.
  it("names the indirect routes the wrapper cannot see: a '!' alias, rebase -x, a hook, submodule foreach, bisect run", () => {
    expect(rules()).toMatch(
      /Never wrap a push in a `!` shell alias, a `git rebase -x` step, a `git hook`, a `submodule foreach` or a `git bisect run` command either\./,
    );
  });

  // Maestro round 3 of PR #259, item 6. A `git` wrapper on PATH cannot see a
  // command that never resolves through PATH, never runs git, or runs on
  // GitHub's side instead. Those routes are out of scope for the guard BY
  // CONSTRUCTION, which makes this text the only thing that covers them — so
  // each one is named here rather than left to be rediscovered.
  it("says plainly that the out-of-scope routes are forbidden by the rule itself", () => {
    expect(rules()).toMatch(
      /Some routes go around a `git` wrapper by construction, so nothing in the container can refuse them — they are forbidden by this rule alone\./,
    );
  });

  it("names the absolute-path and plumbing routes: /usr/bin/git, git-core's git-push, send-pack, http-push", () => {
    expect(rules()).toMatch(
      /Never run the real git by absolute path \(`\/usr\/bin\/git`, `\/usr\/lib\/git-core\/git-push`\), and never reach for the push plumbing \(`git send-pack`, `git http-push`\)\./,
    );
  });

  it("names the routes that skip git entirely: a gh api ref update, gh repo sync, gh pr merge", () => {
    expect(rules()).toMatch(
      /Never land a change on the default branch with a tool that skips git either: no `gh api` call that updates a ref, no `gh repo sync`, no `gh pr merge` of your own PR\./,
    );
  });
});

// Board issue #269: a repo can run several studios of one role. Every rule
// below is a FULL sentence, collapsed first, for the reason collapse-ws.ts
// states — a lone /branch/ would stay green with the whole section deleted,
// since the word appears in unrelated prose on this surface already.
describe("HOUSE_RULES — one branch per studio (#269)", () => {
  const rules = () => collapseWs(HOUSE_RULES);

  it("names the section so a lead can find it", () => {
    expect(HOUSE_RULES).toContain("## House rules — one branch per studio");
  });

  it("says instances of a role share the repo checkout convention and names the id shapes", () => {
    expect(rules()).toMatch(
      /Your repo checkout follows the same convention every studio's does, and a repo can be running several studios of your role at once/,
    );
    expect(rules()).toMatch(/`<repo>--<role>`, `<repo>--<role>--2`, `<repo>--<role>--3`/);
    expect(rules()).toMatch(/Each one has its own container and its own checkout/);
  });

  it("forbids sharing a branch outright, in those words", () => {
    expect(rules()).toMatch(/Never share a branch with another studio/);
    expect(rules()).toMatch(
      /Work on your own branch, always, even when another instance of your role is working on the same repo/,
    );
  });

  it("says WHY — the collision multiple instances exist to avoid — not just that it is forbidden", () => {
    expect(rules()).toMatch(
      /Two leads committing and pushing to one branch is exactly the collision multiple instances exist to avoid/,
    );
    expect(rules()).toMatch(/the pushes race, a force-push destroys the other's work/i);
  });

  it("tells a lead to stop and say so rather than commit onto another studio's branch", () => {
    expect(rules()).toMatch(
      /If a task seems to need another studio's branch, say so and stop — do not commit onto it/,
    );
  });
});

describe("appendHouseRules", () => {
  it("appends, never replaces — the prompt survives byte for byte as the prefix", () => {
    expect(appendHouseRules("lead prompt")).toBe(`lead prompt\n\n${HOUSE_RULES}\n`);
  });

  it("appends to an empty prompt too — there is no opt-out branch", () => {
    expect(appendHouseRules("")).toContain(HOUSE_RULES);
  });
});

// The property this task exists for: a role/studio gets the rules because it
// is built by the blueprint, not because its own .md file remembered to ask.
describe("every prompt the blueprint builds carries the house rules", () => {
  it("role path: with NO memory index and NO brief", () => {
    const prompt = decode(roleBringupEnv(role).ROLE_PROMPT_B64);
    expect(prompt).toContain(HOUSE_RULES);
    expect(prompt).toContain("you are the pilot");
  });

  it("studio path: with NO memory index and NO brief", () => {
    const prompt = decode(studioBringupEnv(studio, []).ROLE_PROMPT_B64);
    expect(prompt).toContain(HOUSE_RULES);
    expect(prompt).toContain("you are the lead");
  });

  it("role path: survives alongside a brief AND a memory index, all three present", () => {
    const prompt = decode(roleBringupEnv(role, "TASK BRIEF", "MEM INDEX").ROLE_PROMPT_B64);
    expect(prompt).toContain(HOUSE_RULES);
    expect(prompt).toContain("MEM INDEX");
    expect(prompt).toContain("TASK BRIEF");
  });

  it("studio path: survives alongside a brief AND a memory index, all three present", () => {
    const prompt = decode(studioBringupEnv(studio, [], "TASK BRIEF", "MEM INDEX").ROLE_PROMPT_B64);
    expect(prompt).toContain(HOUSE_RULES);
    expect(prompt).toContain("MEM INDEX");
    expect(prompt).toContain("TASK BRIEF");
  });
});

// The wrap composes; it must not truncate or reorder what was already there.
describe("the wrap never truncates or reorders role.prompt", () => {
  it("role.prompt stays the literal first bytes of the built prompt", () => {
    const prompt = decode(roleBringupEnv(role, "TASK BRIEF", "MEM INDEX").ROLE_PROMPT_B64);
    expect(prompt.startsWith("you are the pilot")).toBe(true);
  });

  it("a multi-line, multi-paragraph role.prompt survives intact and in order", () => {
    const body = "line one\n\nline two\n  indented three\n\nline four";
    const multi = { ...role, prompt: body } as unknown as Role;
    const prompt = decode(roleBringupEnv(multi, "TASK BRIEF", "MEM INDEX").ROLE_PROMPT_B64);
    expect(prompt.startsWith(body)).toBe(true);
  });

  it("house rules sit BEFORE the memory index and the brief — the task stays last and most salient", () => {
    const prompt = decode(roleBringupEnv(role, "TASK BRIEF", "MEM INDEX").ROLE_PROMPT_B64);
    expect(prompt.indexOf(HOUSE_RULES)).toBeGreaterThan(prompt.indexOf("you are the pilot"));
    expect(prompt.indexOf("MEM INDEX")).toBeGreaterThan(prompt.indexOf(HOUSE_RULES));
    expect(prompt.indexOf("TASK BRIEF")).toBeGreaterThan(prompt.indexOf("MEM INDEX"));
  });
});

// Issue #1: the fleet now develops in a PUBLIC repo. Every studio is told
// what public means, and what a leak-gate refusal looks like.
describe("HOUSE_RULES — public repositories (issue #1)", () => {
  it("says a public repo is world-readable and bans private names in it", () => {
    const rules = collapseWs(HOUSE_RULES);
    expect(rules).toMatch(/If the repo you work in is public, everything you write there is world-readable/);
    expect(rules).toMatch(/Never write client names, operator ids, emails, internal hostnames or tokens/);
    expect(rules).toMatch(/Tests use fake names/);
  });

  it("explains a leak-gate refusal: a pattern number, rewrite the text, never bypass", () => {
    const rules = collapseWs(HOUSE_RULES);
    expect(rules).toMatch(/names a pattern number, never the term/);
    expect(rules).toMatch(/Rewrite the text; never route around the gate/);
  });
});
