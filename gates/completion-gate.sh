#!/usr/bin/env bash
# Defense in depth (board issue #20, the operator 2026-09-21: "I don't want any of
# these locks... CTO can do research and save md files for example" -- the
# Mac `fleet gates install` verb this file's install path served is gone).
# STUDIO_ID is set in every cloud studio's own process environment (used
# throughout src/studio/do.ts / provision.ts) and is inherited by any hook
# subprocess Claude Code spawns as a child of that environment. It is NEVER
# set on the operator's Mac. So even if someone hand-copies this file into
# ~/.claude/hooks/ on a Mac by mistake, it does nothing at all outside a
# real cloud studio, regardless of how it got onto disk.
[ -n "${STUDIO_ID:-}" ] || exit 0

# Tier-0 completion gate. Stop hook: exit 2 refuses the stop and hands stderr
# back to the model; exit 0 lets it finish.
#
# python3 for the same reason the lead gate uses it: the payload is JSON, and
# a gate that misreads its input is worse than no gate. Its absence is handled
# fail-CLOSED right here.
command -v python3 >/dev/null 2>&1 || {
  echo "completion-gate: python3 missing -- refusing to accept completion (Tier 0)" >&2
  exit 2
}
exec python3 -c '
import json, os, re, subprocess, sys

# Issue #361: the completion record lives OUTSIDE the product checkout, at
# $FLEET_WORKSPACE/.fleet/done/<task>.json (/workspace in a studio -- the
# same dir working-set.md lives in). It used to live IN the repo
# (.fleet/done/<task>.json, #316), so every task PR committed one: operator
# exhaust in a public tree. Now it is never committed. The Worker copies it
# to the private ops repo at teardown (FLEET_OPS_REPO), or onto the board
# task when that is unset; this gate never reads or writes any repo for it,
# so an unset ops repo can never fail a stop. One file per task, named by the
# task (#316), so two tasks never share one.
WS = os.environ.get("FLEET_WORKSPACE") or "/workspace"
RECORD_DIR = os.path.join(WS, ".fleet", "done")
# The pre-#361 in-tree shapes. A branch that ADDS or CHANGES one is refused:
# that is how a record would re-appear on main. Deleting one (the #351 scrub)
# is fine, and copies already on main that this branch never touched are
# none of its business.
TREE_RECORD_DIR = ".fleet/done"
TREE_LEGACY = ".fleet/done.json"
# Scripts a verification record must cover, WHEN the repo declares them. Never
# a fixed list: demanding a build from a repo with no build script is an
# unsatisfiable gate, and an unsatisfiable gate is a dead studio.
WANTED = ["build", "lint", "check", "test"]
# How many times one session may be refused before the gate stands down. An
# UNBOUNDED Stop hook can wedge a studio into an endless stop/refuse loop with
# no human near it, which is worse than the drift it prevents. Every refusal is
# loud, and the stand-down says so in as many words.
MAX_REFUSALS = 5

try:
    payload = json.load(sys.stdin)
except Exception:
    payload = {}

def repo_dir():
    sid = os.environ.get("STUDIO_ID", "")
    if sid:
        d = "/workspace/" + sid.split("--")[0]
        if os.path.isdir(os.path.join(d, ".git")):
            return d
    return payload.get("cwd") or os.getcwd()

root = repo_dir()

def refusals_path():
    sid = re.sub(r"[^A-Za-z0-9_-]", "", str(payload.get("session_id", "")))[:64] or "unknown"
    d = os.path.expanduser("~/.claude/.fleet-stop-gate")
    os.makedirs(d, exist_ok=True)
    return os.path.join(d, sid)

def refuse(lines):
    p = refusals_path()
    try:
        n = int(open(p).read().strip() or "0")
    except Exception:
        n = 0
    n += 1
    try:
        open(p, "w").write(str(n))
    except Exception:
        pass
    body = "\n".join(lines)
    if n > MAX_REFUSALS:
        sys.stderr.write(
            "completion-gate: STOOD DOWN after " + str(MAX_REFUSALS) + " refusals this session. "
            + "The gate is open and this work is UNVERIFIED. It still wanted:\n" + body + "\n")
        sys.exit(0)
    sys.stderr.write(
        "completion-gate: not done yet (refusal " + str(n) + " of " + str(MAX_REFUSALS) + ").\n"
        + body + "\n")
    sys.exit(2)

HOWTO = [
    "",
    "Write " + RECORD_DIR + "/<task>.json -- OUTSIDE the repo checkout, and never commit a completion"
        + " record to the repo. Name it after the task/issue this work closes (e.g. " + RECORD_DIR
        + "/258.json). The gate checks the task THIS branch closes: FLEET_TASK when set, else the issue"
        + " number in your branch name -- keep it there. A MEMBER must write it"
        + " -- the lead gate refuses your own Write:",
    "  {\"plan\": \"<repo-relative path of the COMMITTED plan doc this work executed>\",",
    "   \"verification\": [{\"cmd\": \"bun run test\", \"exit\": 0, \"output\": \"<real tail of the run>\"}],",
    "   \"verification_intent\": {\"url\": \"<where a human checks this>\",",
    "                        \"steps\": [\"<step 1>\", \"<step 2>\"],",
    "                        \"expected\": \"<what they should see>\"},",
    "   \"learnings\": [\"<optional: a reusable lesson this task surfaced, if any>\"]}",
    "learnings is OPTIONAL -- omit it, or leave it empty, when nothing reusable came up. Never a refusal condition: this gate never checks it.",
    "Then stop again.",
]

if not os.path.isdir(os.path.join(root, ".git")):
    refuse(["No git checkout at " + root + " -- nothing about this work can be verified."] + HOWTO)

def git_lines(args):
    try:
        r = subprocess.run(["git"] + args, cwd=root, capture_output=True, text=True, timeout=20)
    except Exception:
        return []
    return r.stdout.splitlines() if r.returncode == 0 else []

# Issue #361: in-tree records this branch adds or changes -- uncommitted or
# untracked, or committed since the branch left origin/main. Deletions are
# skipped on both sides (the scrub).
def tree_written():
    paths = set()
    for line in git_lines(["status", "--porcelain", "--untracked-files=all", "--", TREE_RECORD_DIR, TREE_LEGACY]):
        if "D" in line[:2]:
            continue
        paths.add(line[3:].strip().strip(chr(34)))
    base = git_lines(["merge-base", "HEAD", "origin/main"])
    if base:
        for line in git_lines(["diff", "--name-only", "--diff-filter=d", base[0], "HEAD", "--", TREE_RECORD_DIR, TREE_LEGACY]):
            paths.add(line.strip())
    return sorted(p for p in paths if p)

in_tree = tree_written()
if in_tree:
    moves = []
    for p in in_tree:
        name = os.path.basename(p)
        dest = os.path.join(RECORD_DIR, name) if re.fullmatch(r"[0-9]+[.]json", name) else RECORD_DIR + "/<task>.json"
        moves.append("  - " + p + " -> " + dest)
    refuse(["Completion record found in the product repo -- never commit a completion record to it (#361)."
            + " Move each one out of the checkout and drop it from this branch:"] + moves + HOWTO)

# Board issue #316 (review of PR #325): the gate speaks for the ONE task
# closing now, so it first decides WHICH task that is, then demands exactly
# that record -- never whatever record sits in the dir (a sibling would pass
# for a task that wrote nothing). The closing task, in order:
#   1. FLEET_TASK in the environment, when set;
#   2. the single issue number the branch name carries;
#   3. of several numbers, the one that has a record;
# A branch naming no task is refused even when RECORD_DIR holds exactly one
# record: that dir outlives a task, so its one record may belong to an EARLIER task
# (#363 review, round 2).
try:
    local = sorted(f[:-5] for f in os.listdir(RECORD_DIR) if re.fullmatch(r"[0-9]+[.]json", f))
except Exception:
    local = []
branch = (git_lines(["rev-parse", "--abbrev-ref", "HEAD"]) or [""])[0]
branch_nums = sorted(set(re.findall(r"(?<![0-9A-Za-z])[0-9]{1,6}(?![0-9A-Za-z])", branch)))

task = None
why = ""
env_task = os.environ.get("FLEET_TASK", "").strip()
if re.fullmatch(r"[0-9]+", env_task):
    task = env_task
elif len(branch_nums) == 1:
    task = branch_nums[0]
elif branch_nums:
    named = [t for t in local if t in branch_nums]
    if len(named) == 1:
        task = named[0]
    else:
        why = "its name (" + branch + ") carries several numbers: " + ", ".join(branch_nums)
elif local:
    why = ("its name (" + branch + ") carries no issue number, and a record already in " + RECORD_DIR + " ("
           + ", ".join(t + ".json" for t in local) + ") may belong to an earlier task")
else:
    why = "its name (" + branch + ") carries no issue number and " + RECORD_DIR + " holds no record"

if not task:
    refuse(["Completion refused: cannot tell which task this is -- " + why + "."
            + " Put the issue number in the branch name (e.g. 361-slug) or set FLEET_TASK."] + HOWTO)

path = record_label = os.path.join(RECORD_DIR, task + ".json")
if not os.path.isfile(path):
    refuse(["Missing " + path + " -- the completion record for task " + task
            + ", the task this branch closes."] + HOWTO)

try:
    rec = json.load(open(path))
except ValueError as e:
    refuse([record_label + " is not valid JSON (" + str(e) + ")."] + HOWTO)

problems = []

plan = rec.get("plan")
if not isinstance(plan, str) or plan.strip() == "":
    problems.append(record_label + " has no \"plan\" -- name the plan doc this work executed.")
else:
    # COMMITTED, not merely written: a plan doc living only in the working tree
    # is not the auditable artifact spec section 4 asks for.
    out = ""
    try:
        out = subprocess.run(["git", "log", "-1", "--format=%H", "--", plan],
                             cwd=root, capture_output=True, text=True, timeout=20).stdout.strip()
    except Exception as e:
        problems.append("could not ask git about " + plan + " (" + str(e) + ")")
    if out == "":
        problems.append("plan doc \"" + plan + "\" has no commit touching it -- commit the plan, then stop again.")

ver = rec.get("verification")
if not isinstance(ver, list) or not ver:
    problems.append(record_label + " has no \"verification\" list.")
    ver = []

green = []
for i, entry in enumerate(ver):
    label = "verification[" + str(i) + "]"
    if not isinstance(entry, dict):
        problems.append(label + " is not an object.")
        continue
    cmd = entry.get("cmd")
    if not isinstance(cmd, str) or cmd.strip() == "":
        problems.append(label + " has no \"cmd\".")
        continue
    if entry.get("exit") != 0:
        problems.append("\"" + cmd + "\" recorded exit " + json.dumps(entry.get("exit")) + " -- green means 0.")
        continue
    if not isinstance(entry.get("output"), str) or entry.get("output").strip() == "":
        problems.append("\"" + cmd + "\" carries no output -- paste the real tail, the evidence IS the point.")
        continue
    green.append(cmd)

# What this repo can honestly be asked for. package.json is the only source: no
# script, no demand.
try:
    scripts = json.load(open(os.path.join(root, "package.json"))).get("scripts", {}) or {}
except Exception:
    scripts = {}

for want in WANTED:
    if want not in scripts:
        continue
    if not any(re.search(r"(?<![\w-])" + want + r"(?![\w-])", c) for c in green):
        problems.append("no green \"" + want + "\" run recorded (package.json declares a \"" + want + "\" script).")

# Verification INTENT (P5 spec section 4) -- separate from the verification
# list above (build/lint/check/test evidence). This is where a HUMAN checks
# the result: URL, steps, expected outcome. Studios are ephemeral -- Release
# Studio was never inside this container, so this is the only place to write
# it down before the lead is gone. Same shape the board envelope wants
# (payload.verification in src/board/envelope.ts), asked again here because
# a Stop hook cannot read what a later HTTP call receives.
vi = rec.get("verification_intent")
if not isinstance(vi, dict):
    problems.append(record_label + " has no \"verification_intent\" -- url/steps/expected for a human to check this landed.")
else:
    url = vi.get("url")
    if not isinstance(url, str) or url.strip() == "":
        problems.append("verification_intent.url must be a non-empty string.")
    steps = vi.get("steps")
    if not isinstance(steps, list) or len(steps) == 0 or not all(isinstance(s, str) and s.strip() != "" for s in steps):
        problems.append("verification_intent.steps must be a non-empty list of non-empty strings.")
    expected = vi.get("expected")
    if not isinstance(expected, str) or expected.strip() == "":
        problems.append("verification_intent.expected must be a non-empty string.")

if problems:
    refuse(["Completion refused. Fix every one of these:"] + ["  - " + p for p in problems] + HOWTO)

sys.exit(0)
'
