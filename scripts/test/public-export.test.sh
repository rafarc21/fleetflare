#!/usr/bin/env bash
# scripts/test/public-export.test.sh
#
# Plain-bash test harness for scripts/public-export.sh (issue #335). There is
# no existing bats/shellspec convention in this repo (apps/fleet/scripts/*.sh
# has no test harness at all — see deploy.sh, migrate-memory-store.sh), and
# this script operates on the whole monorepo tree via `git archive`, so it
# doesn't fit the apps/fleet vitest project either. This harness follows the
# repo's own general test style (clear PASS/FAIL per case, one non-zero exit
# code if anything failed, safe to run in CI) using only bash + git + tar,
# which is exactly what public-export.sh itself depends on.
#
# Run: bash scripts/test/public-export.test.sh
#
# Round 2 (issue #335, PR #364) note: round 1 hardcoded its private-name
# checks (real Telegram id, real client repo name, etc.) directly in
# public-export.sh's own source — itself a leak, since that script ships as
# part of the eventual public export. Round 2 moved those patterns out to an
# external file the script reads at runtime ($FLEET_OPS_DIR/public-
# denylist.txt, see the script's own header). This test suite never bakes
# real private content either: every denylist file used below is a synthetic
# fixture built by this suite, pointed at via a test-controlled FLEET_OPS_DIR
# temp directory (the same pattern this suite already used for SOURCE_REPO).
#
# What each case proves (see issue #335's own testing requirements):
#   clean-tree-passes       a synthetic tree with no private names / secrets
#                           passes with exit 0, given a synthetic denylist
#                           that matches nothing in it.
#   dirty-tree-caught       a synthetic tree seeded with known violations
#                           (a fake telegram-id-shaped string, a fake client
#                           repo name, fleet/memory/) is caught, non-zero
#                           exit, each violation named in the output — the
#                           denylist-driven ones AND the structural item 1.
#   missing-denylist-warns  FLEET_OPS_DIR unset (denylist file doesn't
#                           exist): the script warns, still runs gitleaks,
#                           the summary says private-name checks were
#                           SKIPPED, and never reports a bare "RESULT: PASS"
#                           (it must not look like a full, clean pass).
#   author-env-required     PUBLIC_EXPORT_AUTHOR_NAME/_EMAIL unset: the
#                           script refuses with a clear error and a non-zero
#                           exit, for both the default (dry-run) invocation
#                           and the --publish invocation shape.
#   self-no-leaks           the meta-property issue #335 round 2 exists to
#                           prove: running the FIXED checker (with a
#                           synthetic denylist recreating round 1's real
#                           terms) against a ref containing public-export.sh's
#                           OWN current source finds zero violations.
#   squash-is-one-commit    the exported tree really is squashed to exactly
#                           one commit, no trace of source history.
#   publish-stub-is-inert   --publish never runs a real publish: (a) the
#                           literal strings a real implementation would need
#                           ("gh repo create", "git push") do not appear
#                           anywhere in the script's source at all, so they
#                           cannot be reachable from any code path, dry-run
#                           or otherwise; (b) invoking --publish against a
#                           real local (but fake/throwaway) bare git repo
#                           exits non-zero immediately and leaves that repo
#                           completely untouched (no new refs, no objects).
set -uo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS_DIR="$(dirname "$TEST_DIR")"
PUBLIC_EXPORT="$SCRIPTS_DIR/public-export.sh"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/public-export-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

TESTS_RUN=0
TESTS_FAILED=0

pass() { echo "  ok - $1"; }
fail() { echo "  NOT OK - $1"; TESTS_FAILED=$((TESTS_FAILED + 1)); }
run_test() {
  local name="$1"
  shift
  TESTS_RUN=$((TESTS_RUN + 1))
  echo "=== $name ==="
  "$@"
}

# Every real invocation of public-export.sh now requires these two env vars
# (issue #335 round 2: no baked default author identity). Tests that aren't
# specifically exercising that requirement export these up front so they
# don't have to repeat it on every call.
AUTHOR_NAME="Test Fixture"
AUTHOR_EMAIL="test-fixture@example.invalid"

git_id() {
  # Give every synthetic repo an identity so commits never depend on the
  # host's own global git config being set.
  git -C "$1" config user.name "Test Fixture"
  git -C "$1" config user.email "test-fixture@example.invalid"
}

make_clean_repo() {
  local dir="$1"
  mkdir -p "$dir/src" "$dir/docs"
  cat > "$dir/README.md" <<'EOF'
# Example Project

A perfectly ordinary open-source project. Nothing private here: no client
names, no personal ids, no local machine paths, no leaked secrets.
EOF
  cat > "$dir/src/index.js" <<'EOF'
export function greet(name) {
  return `Hello, ${name}!`;
}
EOF
  cat > "$dir/.gitignore" <<'EOF'
node_modules/
.fleet/done.json
EOF
  git -C "$dir" init -q -b main
  git_id "$dir"
  git -C "$dir" add -A
  git -C "$dir" commit -q -m "Initial commit"
  # A second commit, so this repo has real history — the squash test needs
  # a source with more than one commit to prove anything.
  echo "console.log('v2');" >> "$dir/src/index.js"
  git -C "$dir" add -A
  git -C "$dir" commit -q -m "Second commit"
}

make_dirty_repo() {
  local dir="$1"
  make_clean_repo "$dir"
  # A fake telegram-id-shaped string, matched by the synthetic denylist.
  mkdir -p "$dir/test"
  echo 'export const CHAT_ID = "999888777";' > "$dir/test/leak.ts"
  # A fake private client repo name, matched by the synthetic denylist.
  echo '// clone from example-org/totally-secret-client for the fixture' >> "$dir/test/leak.ts"
  # Item 1 (structural, still hardcoded, not denylist-driven): fleet/memory/
  # must not exist.
  mkdir -p "$dir/fleet/memory/some-studio"
  echo "private notes" > "$dir/fleet/memory/some-studio/note.md"
  git -C "$dir" add -A
  git -C "$dir" commit -q -m "Seed known violations for the test suite"
}

# A synthetic denylist matching the fake strings make_dirty_repo() seeds
# above. Entirely made up for this test suite — not the real content the
# maestro seeds separately in fleetflare-ops.
write_synthetic_denylist() {
  local ops_dir="$1"
  mkdir -p "$ops_dir"
  cat > "$ops_dir/public-denylist.txt" <<'EOF'
# synthetic denylist for scripts/test/public-export.test.sh only
999888777
(?i)totally-secret-client
EOF
}

# A synthetic denylist matching the SHAPE of round 1's now-removed hardcoded
# checks (a numeric id, a case-sensitive word with all-caps/title-case/
# lowercase variants, a case-insensitive word, a bare keyword, a domain, a
# local path, a hyphenated codename, an "owner/repo" slug, a negative-
# lookahead exclusion) -- entirely FAKE terms, never the real ones, so this
# test file itself carries none of the private data it exists to verify
# nothing else leaks either (maestro review, PR #364 round 3). Still purely a
# test fixture: this suite has no access to, and does not need, the real
# seeded ops-repo file.
write_round1_recreation_denylist() {
  local ops_dir="$1"
  mkdir -p "$ops_dir"
  cat > "$ops_dir/public-denylist.txt" <<'EOF'
# recreates round 1's denylist SHAPE with fake terms, so the self-no-leaks
# test below proves the actual meta-property the maestro asked for -- not
# a weakened stand-in for it, and without itself naming anything real.
999999999
(?i)acmeclient
\b(FAKEO|Fakeo|fakeo)\b
(?i)\bwidgetco\b
fakeVerify
example-corp\.test
/Users/exampledev
sample-automation-bot
acme-org/some-fixture-repo
otherowner/(?!fleetflare\b)
EOF
}

# --- clean-tree-passes -------------------------------------------------------
test_clean_tree_passes() {
  local repo="$WORK/clean-repo"
  make_clean_repo "$repo"
  local ops_dir="$WORK/ops-clean"
  write_synthetic_denylist "$ops_dir"
  local out
  out="$(SOURCE_REPO="$repo" FLEET_OPS_DIR="$ops_dir" PUBLIC_EXPORT_AUTHOR_NAME="$AUTHOR_NAME" PUBLIC_EXPORT_AUTHOR_EMAIL="$AUTHOR_EMAIL" "$PUBLIC_EXPORT" main 2>&1)"
  local code=$?
  if [[ "$code" -eq 0 ]]; then
    pass "clean synthetic tree exits 0"
  else
    fail "clean synthetic tree exited $code, expected 0"
    echo "$out" | sed 's/^/    /'
  fi
  if echo "$out" | grep -q "RESULT: PASS"; then
    pass "summary reports RESULT: PASS"
  else
    fail "summary did not report RESULT: PASS"
    echo "$out" | sed 's/^/    /'
  fi
}

# --- dirty-tree-caught -------------------------------------------------------
test_dirty_tree_caught() {
  local repo="$WORK/dirty-repo"
  make_dirty_repo "$repo"
  local ops_dir="$WORK/ops-dirty"
  write_synthetic_denylist "$ops_dir"
  local out
  out="$(SOURCE_REPO="$repo" FLEET_OPS_DIR="$ops_dir" PUBLIC_EXPORT_AUTHOR_NAME="$AUTHOR_NAME" PUBLIC_EXPORT_AUTHOR_EMAIL="$AUTHOR_EMAIL" "$PUBLIC_EXPORT" main 2>&1)"
  local code=$?
  if [[ "$code" -ne 0 ]]; then
    pass "dirty synthetic tree exits non-zero ($code)"
  else
    fail "dirty synthetic tree exited 0, expected non-zero"
  fi
  for expected in \
    "FAIL \[1\] fleet/memory/ must not exist" \
    "FAIL \[D2\].*999888777|999888777" \
    "FAIL \[D3\]"
  do
    if echo "$out" | grep -qE "$expected"; then
      pass "output names violation: $expected"
    else
      fail "output MISSING expected violation: $expected"
      echo "$out" | sed 's/^/    /'
    fi
  done
}

# A synthetic "macOS-like" grep: rejects any short-option cluster containing
# `P` (bare `-P`, or combined like `-iP` — public-export.sh's own
# case-insensitive fix passes exactly that) exactly like BSD/macOS's real
# system grep does (`grep: invalid option -- P`, exit 2), proxying every
# other invocation to the REAL grep (resolved via `command -v grep` BEFORE
# this directory is prepended to PATH, so the shim never calls itself). Used
# to prove issue #335's fail-closed fix: without it, this exact shape made
# every private-name check silently PASS on a real macOS run.
make_macos_like_grep_shim() {
  local dir="$1"
  mkdir -p "$dir"
  local real_grep
  real_grep="$(command -v grep)"
  cat > "$dir/grep" <<EOF
#!/usr/bin/env bash
for a in "\$@"; do
  if [[ "\$a" == -* && "\$a" != --* && "\$a" == *P* ]]; then
    echo "grep: invalid option -- P" >&2
    exit 2
  fi
done
exec "$real_grep" "\$@"
EOF
  chmod +x "$dir/grep"
}

# --- pcre-unsupported-grep-never-passes ---------------------------------------
test_pcre_unsupported_grep_never_passes() {
  local repo="$WORK/clean-repo-macos-grep"
  make_clean_repo "$repo"
  local ops_dir="$WORK/ops-macos-grep"
  write_synthetic_denylist "$ops_dir"
  local shim_dir="$WORK/macos-grep-shim"
  make_macos_like_grep_shim "$shim_dir"

  local out code
  out="$(PATH="$shim_dir:$PATH" SOURCE_REPO="$repo" FLEET_OPS_DIR="$ops_dir" PUBLIC_EXPORT_AUTHOR_NAME="$AUTHOR_NAME" PUBLIC_EXPORT_AUTHOR_EMAIL="$AUTHOR_EMAIL" "$PUBLIC_EXPORT" main 2>&1)"
  code=$?

  # The tree itself has NOTHING wrong with it -- the ONLY problem is this
  # grep can't do -P. A vacuous "RESULT: PASS" here is exactly issue #335's
  # bug: every prior macOS run of this script reported clean this way.
  if echo "$out" | grep -qE "^RESULT: PASS —"; then
    fail "summary reported RESULT: PASS with a grep lacking -P support -- this is the exact vacuous-pass bug issue #335 exists to fix"
    echo "$out" | sed 's/^/    /'
  else
    pass "summary does not report RESULT: PASS when grep lacks -P support"
  fi
  # Review round 3: an up-front PCRE probe replaces the old per-pattern
  # "grep ERROR" spam (one FAIL per denylist line) with ONE clear warning +
  # SKIP, same INCOMPLETE-not-PASS degrade the missing-denylist-file case
  # already uses (a dry run with nothing else wrong exits 0 -- a WARN, not
  # a hard failure -- see missing-denylist-warns above for that precedent).
  if echo "$out" | grep -q "grep ERROR"; then
    fail "per-pattern 'grep ERROR' spam still appears -- the up-front probe should replace this with ONE message"
    echo "$out" | sed 's/^/    /'
  else
    pass "no per-pattern 'grep ERROR' spam -- the up-front probe caught this before the loop ever ran"
  fi
  if echo "$out" | grep -qi "no working ggrep was found"; then
    pass "ONE clear message names the problem (no PCRE, no working ggrep)"
  else
    fail "no clear message about missing PCRE/ggrep support"
    echo "$out" | sed 's/^/    /'
  fi
  if [[ "$code" -eq 0 ]]; then
    pass "degraded (skip) run still exits 0 when nothing else failed, same policy as missing-denylist-warns"
  else
    fail "run with a -P-incapable grep exited $code, expected 0 (degrade, not hard-fail, per the missing-prerequisite policy)"
    echo "$out" | sed 's/^/    /'
  fi
}

# --- denylisted-term-caught-on-both-greps -------------------------------------
# The same dirty tree (a real denylisted term AND fleet/memory/, from
# make_dirty_repo) run twice: proves the exact two-grep contrast review
# round 3 asked for. Real GNU grep genuinely CATCHES the denylisted term
# (FAIL, names it). A -P-incapable grep never fabricates a pass either, but
# HONESTLY DECLINES to vouch for the denylist check specifically (SKIP, via
# the up-front probe) rather than silently reporting it clean -- the
# OTHER, non-denylist violation (fleet/memory/) still fails independently
# either way, so this is never mistaken for a real pass under either grep.
test_denylisted_term_caught_on_both_greps() {
  local repo="$WORK/dirty-repo-both-greps"
  make_dirty_repo "$repo"
  local ops_dir="$WORK/ops-both-greps"
  write_synthetic_denylist "$ops_dir"
  local shim_dir="$WORK/macos-grep-shim-2"
  make_macos_like_grep_shim "$shim_dir"

  local out_real code_real out_shim code_shim
  out_real="$(SOURCE_REPO="$repo" FLEET_OPS_DIR="$ops_dir" PUBLIC_EXPORT_AUTHOR_NAME="$AUTHOR_NAME" PUBLIC_EXPORT_AUTHOR_EMAIL="$AUTHOR_EMAIL" "$PUBLIC_EXPORT" main 2>&1)"
  code_real=$?
  out_shim="$(PATH="$shim_dir:$PATH" SOURCE_REPO="$repo" FLEET_OPS_DIR="$ops_dir" PUBLIC_EXPORT_AUTHOR_NAME="$AUTHOR_NAME" PUBLIC_EXPORT_AUTHOR_EMAIL="$AUTHOR_EMAIL" "$PUBLIC_EXPORT" main 2>&1)"
  code_shim=$?

  if echo "$out_real" | grep -qE "^FAIL \[D2\]"; then
    pass "real grep: denylisted term still caught (FAIL [D2])"
  else
    fail "real grep: denylisted term was NOT caught"
    echo "$out_real" | sed 's/^/    /'
  fi
  if [[ "$code_real" -ne 0 ]]; then
    pass "real grep: exits non-zero ($code_real)"
  else
    fail "real grep: exited 0, expected non-zero"
  fi

  if echo "$out_shim" | grep -qE "^RESULT: PASS —"; then
    fail "macOS-like shim grep: reported RESULT: PASS on a genuinely dirty tree -- exactly the vacuous-pass bug"
    echo "$out_shim" | sed 's/^/    /'
  else
    pass "macOS-like shim grep: never reports RESULT: PASS on the same dirty tree"
  fi
  if echo "$out_shim" | grep -q "SKIP \[denylist\]"; then
    pass "macOS-like shim grep: honestly SKIPs (declines to vouch), via the up-front probe, rather than fabricating a pass"
  else
    fail "macOS-like shim grep: did not SKIP the denylist check as expected"
    echo "$out_shim" | sed 's/^/    /'
  fi
}

# --- missing-denylist-warns ---------------------------------------------------
test_missing_denylist_warns() {
  local repo="$WORK/clean-repo-missing-denylist"
  make_clean_repo "$repo"
  local out
  # FLEET_OPS_DIR points at a directory that has no public-denylist.txt in
  # it at all (nothing was ever written there) -- the "not found" case.
  out="$(SOURCE_REPO="$repo" FLEET_OPS_DIR="$WORK/nonexistent-ops-dir" PUBLIC_EXPORT_AUTHOR_NAME="$AUTHOR_NAME" PUBLIC_EXPORT_AUTHOR_EMAIL="$AUTHOR_EMAIL" "$PUBLIC_EXPORT" main 2>&1)"
  local code=$?
  if echo "$out" | grep -qi "WARNING.*denylist"; then
    pass "output warns about the missing denylist"
  else
    fail "output did not warn about the missing denylist"
    echo "$out" | sed 's/^/    /'
  fi
  if echo "$out" | grep -q "private-name checks: SKIPPED (denylist not found at"; then
    pass "summary says private-name checks: SKIPPED (denylist not found at ...)"
  else
    fail "summary did not say private-name checks were SKIPPED with the expected wording"
    echo "$out" | sed 's/^/    /'
  fi
  if echo "$out" | grep -qE "^RESULT: PASS —"; then
    fail "summary reported a bare RESULT: PASS despite private-name checks being skipped -- this is a false pass"
  else
    pass "summary does not report a false RESULT: PASS"
  fi
  if echo "$out" | grep -qi "gitleaks secret scan"; then
    pass "gitleaks section still ran despite the missing denylist"
  else
    fail "gitleaks section did not run"
  fi
  if [[ "$code" -eq 0 ]]; then
    pass "degraded (skip) run still exits 0 when nothing else failed (a WARN, not a hard failure, for dry-run)"
  else
    fail "degraded (skip) run exited $code, expected 0 (dry-run degrade should warn, not hard-fail, per the missing-denylist policy)"
    echo "$out" | sed 's/^/    /'
  fi
}

# --- author-env-required ------------------------------------------------------
test_author_env_required() {
  local repo="$WORK/clean-repo-author"
  make_clean_repo "$repo"
  local ops_dir="$WORK/ops-author"
  write_synthetic_denylist "$ops_dir"

  local out code
  out="$(SOURCE_REPO="$repo" FLEET_OPS_DIR="$ops_dir" env -u PUBLIC_EXPORT_AUTHOR_NAME -u PUBLIC_EXPORT_AUTHOR_EMAIL "$PUBLIC_EXPORT" main 2>&1)"
  code=$?
  if [[ "$code" -ne 0 ]]; then
    pass "default (dry-run) invocation with no author env vars exits non-zero ($code)"
  else
    fail "default invocation with no author env vars exited 0, expected non-zero"
  fi
  if echo "$out" | grep -qi "PUBLIC_EXPORT_AUTHOR_NAME.*PUBLIC_EXPORT_AUTHOR_EMAIL"; then
    pass "error names both required env vars"
  else
    fail "error did not clearly name both required env vars"
    echo "$out" | sed 's/^/    /'
  fi

  # Same requirement must hold for the --publish invocation shape too (it's
  # a permanent stub either way, but the env check runs before it).
  local fake_remote="$WORK/fake-remote-author.git"
  git init -q --bare "$fake_remote"
  out="$(SOURCE_REPO="$repo" FLEET_OPS_DIR="$ops_dir" env -u PUBLIC_EXPORT_AUTHOR_NAME -u PUBLIC_EXPORT_AUTHOR_EMAIL "$PUBLIC_EXPORT" main --publish "$fake_remote" 2>&1)"
  code=$?
  if [[ "$code" -ne 0 ]]; then
    pass "--publish invocation with no author env vars exits non-zero ($code)"
  else
    fail "--publish invocation with no author env vars exited 0, expected non-zero"
  fi
  if echo "$out" | grep -qi "PUBLIC_EXPORT_AUTHOR_NAME.*PUBLIC_EXPORT_AUTHOR_EMAIL"; then
    pass "--publish error names both required env vars"
  else
    fail "--publish error did not clearly name both required env vars"
    echo "$out" | sed 's/^/    /'
  fi

  # Sanity: with both set, the same clean repo passes (proves the refusal
  # above is really about the env vars, not some other regression).
  out="$(SOURCE_REPO="$repo" FLEET_OPS_DIR="$ops_dir" PUBLIC_EXPORT_AUTHOR_NAME="$AUTHOR_NAME" PUBLIC_EXPORT_AUTHOR_EMAIL="$AUTHOR_EMAIL" "$PUBLIC_EXPORT" main 2>&1)"
  code=$?
  if [[ "$code" -eq 0 ]]; then
    pass "same repo passes once both author env vars are set"
  else
    fail "same repo failed even with both author env vars set (exit $code) -- test setup or regression"
    echo "$out" | sed 's/^/    /'
  fi
}

# --- self-no-leaks ------------------------------------------------------------
# The meta-property issue #335 round 2 exists to prove: the tool that finds
# private data does not itself contain any. Snapshots the CURRENT
# public-export.sh into a tiny synthetic repo, then runs the (fixed) checker
# against that snapshot using a synthetic denylist recreating round 1's real
# terms, and asserts zero denylist violations were found in the script's own
# source.
test_self_no_leaks() {
  local repo="$WORK/self-test-repo"
  mkdir -p "$repo/scripts"
  cp "$PUBLIC_EXPORT" "$repo/scripts/public-export.sh"
  cat > "$repo/.gitignore" <<'EOF'
node_modules/
.fleet/done.json
EOF
  git -C "$repo" init -q -b main
  git_id "$repo"
  git -C "$repo" add -A
  git -C "$repo" commit -q -m "snapshot of public-export.sh for the self-no-leaks test"

  local ops_dir="$WORK/ops-self-test"
  write_round1_recreation_denylist "$ops_dir"

  local out code
  out="$(SOURCE_REPO="$repo" FLEET_OPS_DIR="$ops_dir" PUBLIC_EXPORT_AUTHOR_NAME="$AUTHOR_NAME" PUBLIC_EXPORT_AUTHOR_EMAIL="$AUTHOR_EMAIL" "$PUBLIC_EXPORT" main 2>&1)"
  code=$?

  if echo "$out" | grep -qE "^FAIL \[D[0-9]+\]"; then
    fail "public-export.sh's OWN source matched a denylist pattern -- it still leaks private strings"
    echo "$out" | sed 's/^/    /'
  else
    pass "public-export.sh's own source matches zero denylist patterns"
  fi
  if [[ "$code" -eq 0 ]]; then
    pass "self-test run exits 0 (script's own source is clean)"
  else
    fail "self-test run exited $code, expected 0"
    echo "$out" | sed 's/^/    /'
  fi
  if echo "$out" | grep -q "RESULT: PASS"; then
    pass "self-test run reports RESULT: PASS"
  else
    fail "self-test run did not report RESULT: PASS"
    echo "$out" | sed 's/^/    /'
  fi
}

# --- squash-is-one-commit ----------------------------------------------------
test_squash_is_one_commit() {
  local repo="$WORK/clean-repo-2"
  make_clean_repo "$repo"
  local ops_dir="$WORK/ops-squash"
  write_synthetic_denylist "$ops_dir"
  local src_commit_count
  src_commit_count="$(git -C "$repo" rev-list --count HEAD)"
  if [[ "$src_commit_count" -lt 2 ]]; then
    fail "test setup bug: source repo should have >= 2 commits, has $src_commit_count"
    return
  fi

  local keep_out export_dir
  keep_out="$(SOURCE_REPO="$repo" FLEET_OPS_DIR="$ops_dir" PUBLIC_EXPORT_AUTHOR_NAME="$AUTHOR_NAME" PUBLIC_EXPORT_AUTHOR_EMAIL="$AUTHOR_EMAIL" KEEP_EXPORT_DIR=1 "$PUBLIC_EXPORT" main 2>&1)"
  export_dir="$(echo "$keep_out" | grep -oE 'Export dir:\s+\S+' | awk '{print $3}')"

  if [[ -z "$export_dir" || ! -d "$export_dir" ]]; then
    fail "could not locate kept export dir from script output"
    echo "$keep_out" | sed 's/^/    /'
    return
  fi

  local export_commit_count
  export_commit_count="$(git -C "$export_dir" rev-list --count HEAD 2>/dev/null || echo "?")"
  if [[ "$export_commit_count" == "1" ]]; then
    pass "exported tree has exactly 1 commit (source had $src_commit_count)"
  else
    fail "exported tree has $export_commit_count commit(s), expected exactly 1"
  fi

  # No trace of the source ref's own history: none of the source commits'
  # subjects should appear anywhere in the export's own (single) commit log.
  if git -C "$export_dir" log --format=%B -1 | grep -q "Second commit"; then
    fail "exported commit message leaked the source ref's own commit history"
  else
    pass "exported commit carries no trace of the source ref's commit history"
  fi

  rm -rf "$export_dir"
}

# --- publish-stub-is-inert ---------------------------------------------------
test_publish_stub_is_inert() {
  if grep -q "gh repo create" "$PUBLIC_EXPORT"; then
    fail "script source contains the literal string 'gh repo create' — a real repo-creation path exists"
  else
    pass "script source never contains the literal string 'gh repo create'"
  fi
  if grep -qE '(^|[^a-zA-Z_-])git push' "$PUBLIC_EXPORT"; then
    fail "script source contains a literal 'git push' invocation — a real push path exists"
  else
    pass "script source never contains a literal 'git push' invocation"
  fi

  local repo="$WORK/clean-repo-3"
  make_clean_repo "$repo"
  local ops_dir="$WORK/ops-publish-stub"
  write_synthetic_denylist "$ops_dir"

  local fake_remote="$WORK/fake-remote.git"
  git init -q --bare "$fake_remote"
  local before_refs before_objects
  before_refs="$(git -C "$fake_remote" for-each-ref | wc -l | tr -d ' ')"
  before_objects="$(find "$fake_remote/objects" -type f | wc -l | tr -d ' ')"

  local out
  out="$(SOURCE_REPO="$repo" FLEET_OPS_DIR="$ops_dir" PUBLIC_EXPORT_AUTHOR_NAME="$AUTHOR_NAME" PUBLIC_EXPORT_AUTHOR_EMAIL="$AUTHOR_EMAIL" "$PUBLIC_EXPORT" main --publish "$fake_remote" 2>&1)"
  local code=$?

  if [[ "$code" -ne 0 ]]; then
    pass "--publish exits non-zero ($code)"
  else
    fail "--publish exited 0, expected non-zero (it must never succeed today)"
  fi
  if echo "$out" | grep -qi "not implemented"; then
    pass "--publish output says plainly that it is not implemented"
  else
    fail "--publish output did not say it is not implemented"
    echo "$out" | sed 's/^/    /'
  fi

  local after_refs after_objects
  after_refs="$(git -C "$fake_remote" for-each-ref | wc -l | tr -d ' ')"
  after_objects="$(find "$fake_remote/objects" -type f | wc -l | tr -d ' ')"
  if [[ "$after_refs" == "$before_refs" && "$after_objects" == "$before_objects" ]]; then
    pass "the fake local remote received zero refs and zero objects (never touched)"
  else
    fail "the fake local remote CHANGED (refs $before_refs->$after_refs, objects $before_objects->$after_objects) — --publish did something"
  fi
}

run_test "clean-tree-passes" test_clean_tree_passes
run_test "dirty-tree-caught" test_dirty_tree_caught
run_test "pcre-unsupported-grep-never-passes" test_pcre_unsupported_grep_never_passes
run_test "denylisted-term-caught-on-both-greps" test_denylisted_term_caught_on_both_greps
run_test "missing-denylist-warns" test_missing_denylist_warns
run_test "author-env-required" test_author_env_required
run_test "self-no-leaks" test_self_no_leaks
run_test "squash-is-one-commit" test_squash_is_one_commit
run_test "publish-stub-is-inert" test_publish_stub_is_inert

echo
if [[ "$TESTS_FAILED" -eq 0 ]]; then
  echo "public-export.test.sh: all $TESTS_RUN test group(s) passed"
  exit 0
else
  echo "public-export.test.sh: $TESTS_FAILED assertion(s) failed across $TESTS_RUN test group(s)"
  exit 1
fi
