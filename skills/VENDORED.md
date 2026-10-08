# Vendored skills

Manifest of skill directories under this repo's `skills/` that are vendored
(copied, not written from scratch) from a third-party source. See
`skills/THIRD-PARTY-LICENSES.md` for the license text itself.

## skills/deep-modules/

Vendored from https://github.com/mattpocock/skills (commit b0618bc436ad), MIT License.
Source: `skills/engineering/codebase-design/` (`SKILL.md` + `DEEPENING.md` + `DESIGN-IT-TWICE.md`).
Only upstream change: `SKILL.md`'s frontmatter `name:` field, renamed `codebase-design` -> `deep-modules`.
Local additions: a "Fleetflare addendum" section appended to the end of `SKILL.md`, clearly marked -- detection checklist (pass-through wrappers, many tiny exported functions, leaky config/flag params, repeated caller dances, structure-pinned tests, step-split files), refactor recipes, when NOT to deepen, and the hook into the `superpowers` plugin's design/review skills. Noted inline where a local item maps onto vendored vocabulary (e.g. checklist item 1 is the vendored deletion test applied directly) rather than duplicating the vendored text.

## skills/pr-body/

Vendored from https://github.com/mattpocock/skills (commit b0618bc436ad), MIT License.
Source: `skills/engineering/pr/SKILL.md`.
Only upstream change: the frontmatter `name:` field, renamed `pr` -> `pr-body`. The file's own `metadata.credits` block (crediting the `show-me` skill, Dex Horthy/Humanlayer) is Pocock's own upstream attribution and is preserved unchanged.
Local additions: a "Fleetflare addendum" section appended to the end of `SKILL.md`, clearly marked -- confirms `.github/pull_request_template.md` already uses this exact Summary/Evidence/Merge-Danger shape (this skill documents that one template, not a second one), and repo-specific guidance for filling Merge Danger's Door/Blast-Radius fields (the `ONE_WAY_GLOBS` floor-not-ceiling rule).
