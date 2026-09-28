import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ALLOWLIST, findPortuguese, formatFinding, LINE_ALLOWLIST, REPO_ROOT, scanFile, scanRepo } from "../../scripts/english-check";

/**
 * Board issue #66 — all repository content is English, and this keeps it so.
 *
 * The check is deliberately small: a line is flagged only when it contains a
 * whole word from a short list of Portuguese markers that are not English
 * words and not identifiers anyone in this repo uses, or a word carrying the
 * Portuguese-only nasal vowels ã/õ. A noisy check gets disabled, which is
 * worse than no check, so every negative case below is a real false positive
 * the heuristic must not produce.
 */
describe("findPortuguese — the line heuristic", () => {
  test("flags an unaccented Portuguese comment, naming the line and marker", () => {
    const text = "// fine English line\n// Nao sao segredos: um id nao e credencial.\n";
    const hits = findPortuguese(text);
    expect(hits).toHaveLength(1);
    expect(hits[0].line).toBe(2);
    expect(hits[0].marker.toLowerCase()).toBe("nao");
  });

  test("flags a word with a Portuguese nasal vowel even when no marker word is present", () => {
    expect(findPortuguese("a questão fica aqui")).toHaveLength(1);
  });

  test("flags the operator's own imperative quotes (NAO mudes, porque)", () => {
    expect(findPortuguese('the operator: "NAO mudes o prefixo"')).toHaveLength(1);
    expect(findPortuguese("so porque sim")).toHaveLength(1);
  });

  test("reports each flagged line once, however many markers it holds", () => {
    expect(findPortuguese("nao, nunca, porque, ficheiro, janela")).toHaveLength(1);
  });

  test("ignores English, code identifiers, URLs and accented loanwords", () => {
    const clean = [
      "const naoResult = await janelaWidth(nunca_used);",
      "see https://example.com/nao-sao/porque-path for details",
      "deploy the site NOW — 100% done? café, naïve, façade, crédits",
      "Sao Paulo and Uma Thurman are proper nouns, not sentences",
      "no, do, a, as, se, me, ja, com — short words are English or code",
    ].join("\n");
    expect(findPortuguese(clean)).toEqual([]);
  });

  test("matches a decomposed (NFD) accent the same as a composed one", () => {
    expect(findPortuguese("na\u0303o")).toHaveLength(1);
  });

  test("flags the operator's quote that carries no original marker (mexer)", () => {
    expect(findPortuguese('("Investiga 3 ANTES de mexer em 1 e 2")')).toHaveLength(1);
  });

  test("flags the Worker's old Portuguese close comment (fechada, promovido)", () => {
    expect(findPortuguese("fechada por deadbeef")).toHaveLength(1);
    expect(findPortuguese("x promovido a main")).toHaveLength(1);
  });

  test("a trailing `english-check: allow` exempts that one line only", () => {
    expect(findPortuguese("Rua João, São Paulo // english-check: allow")).toEqual([]);
    expect(findPortuguese("Rua João, São Paulo")).toHaveLength(1);
  });

  test("formats a finding as path:line so a false positive is cheap to find", () => {
    const [hit] = findPortuguese("x\n// isso nao presta");
    expect(formatFinding("docs/a.md", hit)).toMatch(/^docs\/a\.md:2: /);
  });
});

describe("the repository itself", () => {
  test("every allowlisted path still exists and says why it is exempt", () => {
    for (const [path, reason] of Object.entries(ALLOWLIST)) {
      expect(() => readFileSync(join(REPO_ROOT, path))).not.toThrow();
      expect(reason.length).toBeGreaterThan(20);
    }
  });

  test("every line-allowlisted line is still in its file, word for word", () => {
    for (const [path, { reason, lines }] of Object.entries(LINE_ALLOWLIST)) {
      const text = readFileSync(join(REPO_ROOT, path), "utf8").split("\n").map((l) => l.trim());
      for (const line of lines) expect(text).toContain(line);
      expect(reason.length).toBeGreaterThan(20);
    }
  });

  test("studio-bringup.sh holds no Portuguese, and a NEW Portuguese line in it is flagged", () => {
    const path = "apps/fleet/container/studio-bringup.sh";
    const text = readFileSync(join(REPO_ROOT, path), "utf8");
    expect(scanFile(path, text)).toEqual([]);
    const hits = scanFile(path, `${text}\n# isto nao pode ficar\n`);
    expect(hits).toHaveLength(1);
    expect(hits[0].marker).toBe("isto");
  });

  // Issue #389: `scanRepo()` is a real, linear scan over every tracked file
  // in the repo (`git ls-files -z` once, then one read+decode+regex pass per
  // file — see its own doc comment, no quadratic behavior, nothing to fix in
  // the scan itself) — its wall-clock time is genuinely IO/CPU-bound and
  // scales with repo size and host load, not a fixed cost. No explicit
  // timeout here meant this test inherited bun:test's own 5000ms default.
  // Real local-CI measurements: typical ~400ms, loaded 1.2s/2.7s/2.9s, then
  // killed at exactly 5000.72ms on a host-load-9 run — that run's TRUE time
  // is unknown (the timeout fired before the scan could finish), so 2.9s is
  // only a lower bound on how bad a loaded host gets. This blocked PR #356's
  // auto-merge queue on a flake, not a real regression. No sibling test in
  // this file already budgets a wider ceiling to match (unlike #385's own
  // SIGTERM-timing fix), so 30s is chosen directly: 10x the worst NATURAL
  // (non-killed) time seen, comfortable headroom for a real full-repo scan
  // under load without masking a genuine hang (a scan-side infinite loop
  // would still fail this, just later).
  test("holds no Portuguese outside the allowlist", async () => {
    const findings = await scanRepo();
    expect(findings.map((f) => formatFinding(f.path, f))).toEqual([]);
  }, 30_000);

  test("the fleet-cockpit skill carries the English-only rule", () => {
    const skill = readFileSync(join(REPO_ROOT, "skills", "fleet-cockpit", "SKILL.md"), "utf8");
    expect(skill).toMatch(/all repository content is English/i);
  });
});
