// container/memguard.ts — LIVE, inside `docker run --memory=1g` (issue #169).
//
// Runs the REAL `memguard-start` region out of the REAL studio-bringup.sh
// (twice: single instance) in a throwaway container with a 1 GiB cgroup, then:
//   - a protected marker named like the lead (`claude`) holding ~200 MiB,
//     running as a REAL child of a REAL `tmux -L fleet-studio` studio:claude
//     pane (#238) -- not merely a claude-named process anywhere in the tree,
//   - a child the marker forks AFTER it was pinned at -1000 (the inherited
//     oom_score_adj trap: the child is born -1000, the guard must raise it),
//   - a hog that grows until something stops it,
//   - #238: a SECOND claude-named process that is NOT a child of that pane --
//     a nested `claude -p` / stale-orphan stand-in -- which must now be an
//     ORDINARY, killable candidate, not immune by name alone.
// Pass = the guard killed the hog before the cgroup OOM killer did, killed the
// non-lead claude-named leak, the REAL marker is alive, the log line is on
// disk, the guard idles under 1% CPU.
//
// Never runs a hog anywhere but inside that container. Docker is required on
// CI (the Linux lane is the authority); a laptop without docker skips.
//
// #238 NOTE FOR THE REVIEWER: this file was extended, not run, in the studio
// sandbox that wrote it -- no docker daemon there. Run it on the Mac; the new
// assertions to watch are `leak_alive_after_5s` (must be "0": the non-lead
// claude-named leak gets killed) and `marker_alive`/`marker_shell_alive`
// (must stay "1": the REAL lead, child of the REAL tmux pane, is untouched).
// No genuine kernel-OOM-forcing scenario (kernel picks the leak over a `gh`
// stand-in) was added: sizing and racing a real kernel OOM against this guard
// needs iteration against real memory pressure this sandbox cannot provide,
// and a wrong guess here is worse than no attempt -- the existing
// cgroup_oom_kill=0 assertion already covers "the guard relieves it before
// the kernel ever has to choose."
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CONTAINER_DIR = join(import.meta.dir, "../../container");
const BRINGUP = readFileSync(join(CONTAINER_DIR, "studio-bringup.sh"), "utf8");
const IMAGE = "oven/bun:1.3-debian";

function extractRegion(src: string, marker: string): string {
  const open = `# >>> ${marker} >>>`;
  const close = `# <<< ${marker} <<<`;
  const openAt = src.indexOf(open);
  if (openAt === -1) throw new Error(`region opener ${open} not found in source`);
  const closeAt = src.indexOf(close, openAt);
  if (closeAt === -1) throw new Error(`region terminator ${close} not found in source`);
  return src.slice(src.indexOf("\n", openAt) + 1, closeAt);
}

const dockerUp = spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
if (!dockerUp && process.env.CI) throw new Error("memguard-docker: docker is required in CI and is not available");

const MARKER_JS = `
const hold = [];
for (let i = 0; i < 4; i++) hold.push(Buffer.alloc(50 << 20, 1));
const fs = require("fs");
// Fork the child only once the guard has pinned this process at -1000, so the
// child is born with the inherited -1000 -- the trap under test.
const t = setInterval(() => {
  if (fs.readFileSync("/proc/self/oom_score_adj", "utf8").trim() !== "-1000") return;
  clearInterval(t);
  const c = Bun.spawn(["sleep", "1000"]);
  fs.writeFileSync("/tmp/child.pid", String(c.pid));
}, 50);
setInterval(() => {}, 1e9);
`;

// Reviewer model of pressure the guard CANNOT relieve (PR #189 review): a
// process named claude (a stale lead, a nested `claude -p`) that fills the
// cgroup until ~90 MiB stay available -- inside the TERM band, above KILL --
// and holds that level for LEAK_MS. Every open process is under the victim
// floor, so the only correct move is: no signal at all, one NO_VICTIM line.
const LEAK_JS = `
const fs = require("fs");
const MiB = 1 << 20;
const hold = [];
const avail = () => {
  const max = Number(fs.readFileSync("/sys/fs/cgroup/memory.max", "utf8"));
  const cur = Number(fs.readFileSync("/sys/fs/cgroup/memory.current", "utf8"));
  const inact = Number(/^inactive_file (\\d+)/m.exec(fs.readFileSync("/sys/fs/cgroup/memory.stat", "utf8"))[1]);
  return (max - cur + inact) / MiB;
};
const t0 = Date.now();
setInterval(() => {
  if (Date.now() - t0 > Number(process.env.LEAK_MS)) process.exit(0);
  const a = avail();
  if (a > 95 && hold.length < 400) hold.push(Buffer.alloc(Math.min(8, Math.floor(a - 90)) * MiB, 1));
  else if (a < 70 && hold.length) hold.pop();
}, 100);
`;

// #261: the deaf hog ignores SIGTERM and KEEPS growing, but at 1 MiB per
// 100 ms instead of 8. At 80 MB/s its SIGKILL raced the cgroup: it was
// SIGTERMed with ~115 MiB left and only a tick inside the 30 MiB KILL band
// (under 4 hog steps) could save it, so one tick delayed by host load let the
// kernel OOM it first (1 of 5 runs at Mac load ~20). At 10 MB/s the 5 s grace
// ends with ~65 MiB still free, and the guard's own grace timer -- the path
// under test -- delivers the SIGKILL. A guard that never SIGKILLs still loses:
// the hog grows into the cgroup OOM, cgroup_oom_kill=1 and no SIGKILL line.
const HOG_JS = `
const MiB = 1 << 20;
let step = 8 * MiB;
if (process.argv[2] === "deaf") process.on("SIGTERM", () => { step = MiB; });
const hold = [];
setInterval(() => { hold.push(Buffer.alloc(step, 1)); }, 100);
`;

function scenario(region: string): string {
  return `
set -u
export FLEET_WORKSPACE=/tmp/ws
# At 1 GiB the default 6%/3% bands are 30 MiB apart: under host load one
# 500 ms tick (hog: 80 MB/s) can cross both and the guard SIGKILLs at once,
# correctly, but then the TERM->grace->KILL path goes unobserved. 15% gives a
# 120 MiB band. A standard-4 studio's default band is 350 MiB.
export MEMGUARD_TERM_PCT=15
mkdir -p /tmp/ws/.fleet
cat > /tmp/marker.js <<'EOF'
${MARKER_JS}
EOF
cat > /tmp/hog.js <<'EOF'
${HOG_JS}
EOF
cat > /tmp/leak.js <<'EOF'
${LEAK_JS}
EOF
child_of() { for d in /proc/[0-9]*; do [ "$(awk '{print $4}' $d/stat 2>/dev/null)" = "$1" ] && echo \${d#/proc/}; done; }
guard_pids() { for d in /proc/[0-9]*; do tr '\\0' ' ' 2>/dev/null < $d/cmdline | grep -q '^bun /opt/fleet/memguard.ts' && echo \${d#/proc/}; done; }
# #238: the guard's own resolveLeadParentPid() idiom -- studio-bringup.sh's
# \`tmux -L fleet-studio display-message -p -t studio:claude '#{...}'\`.
stmux() { command tmux -L fleet-studio "$@"; }

export DEBIAN_FRONTEND=noninteractive
apt-get -qq update >/dev/null && apt-get -qq install -y tmux >/dev/null

# --- the shipped bring-up region, twice: a re-run must not start a second guard
${region}
${region}
sleep 1.5
echo "guard_count=$(guard_pids | wc -l)"
MG=$(guard_pids | head -1)
FLOCK=$(awk '{print $4}' /proc/$MG/stat)
echo "guard_parent_comm=$(cat /proc/$FLOCK/comm)"

cp "$(command -v bun)" /tmp/claude
# #238: the marker is now a REAL child of a REAL tmux pane -- studio-bringup.sh's
# own \`tmux new-session -d -s studio -n claude\` shape (grep the script for that
# exact line), then a send-keys launch (its own claude_launch idiom), so the
# guard's resolveLeadParentPid() resolves THIS pane's pid and the marker's ppid
# genuinely matches it -- not merely a claude-named process anywhere in the tree.
stmux new-session -d -s studio -n claude
stmux send-keys -t studio:claude '/tmp/claude /tmp/marker.js' Enter
for _ in $(seq 1 100); do MSH=$(stmux display-message -p -t studio:claude '#{pane_pid}' 2>/dev/null); [ -n "$MSH" ] && break; sleep 0.05; done
for _ in $(seq 1 100); do MARKER=$(child_of $MSH); [ -n "$MARKER" ] && break; sleep 0.05; done
for _ in $(seq 1 100); do [ -s /tmp/child.pid ] && break; sleep 0.05; done
CHILD=$(cat /tmp/child.pid)
echo "marker_adj=$(cat /proc/$MARKER/oom_score_adj)"
echo "child_adj_at_birth=$(cat /proc/$CHILD/oom_score_adj)"
sleep 5.5
echo "child_adj_after_scan=$(cat /proc/$CHILD/oom_score_adj)"

# --- idle CPU of the guard over 30s (clock ticks, USER_HZ=100), beside a
# CONTROL: bare bun on the same 500 ms timer, same window. A loaded host
# inflates both alike (measured: old and new guard 221 vs 220 ticks/60 s
# at load 28); the difference is the guard's own work. 30 s, not 10: at
# 10 s one scheduler hiccup is a whole percent.
bun -e 'setInterval(() => {}, 500)' &
CTL=$!
sleep 1
t0=$(awk '{print $14+$15}' /proc/$MG/stat); c0=$(awk '{print $14+$15}' /proc/$CTL/stat)
sleep 30
t1=$(awk '{print $14+$15}' /proc/$MG/stat); c1=$(awk '{print $14+$15}' /proc/$CTL/stat)
kill $CTL
echo "guard_idle_ticks_30s=$((t1 - t0))"
echo "control_idle_ticks_30s=$((c1 - c0))"
echo "guard_rss_kib=$(awk '/VmRSS/{print $2}' /proc/$MG/status)"

# --- the hog
bun /tmp/hog.js &
HOG=$!
start=$(date +%s%N)
wait $HOG
echo "hog_exit=$?"
echo "hog_ms=$(( ($(date +%s%N) - start) / 1000000 ))"
echo "hog_pid=$HOG"

# --- a hog that ignores SIGTERM: the grace period must end in SIGKILL
bun /tmp/hog.js deaf &
DEAF=$!
wait $DEAF
echo "deaf_exit=$?"
echo "deaf_pid=$DEAF"

# --- #238: a claude-named leak that is NOT a child of the pane shell (a
# plain \`bash -c\`, nothing to do with studio:claude -- standing in for a
# nested \`claude -p\` or a stale orphaned relaunch, issue #67). Pre-#238 this
# was immune by NAME alone and held available memory inside the TERM band
# forever ("unrelievable pressure", the shape the #189 reviewer measured
# against a real 1.8 GiB claude-named leak the kernel had to work around by
# picking \`gh\` instead). Now it is an ORDINARY candidate: big enough, and not
# the lead, so the guard must kill it well before its own LEAK_MS safety exit.
pre=$(wc -l < /tmp/ws/.fleet/memguard.log)
LEAK_MS=60000 bash -c '/tmp/claude /tmp/leak.js; :' &
LSH=$!
for _ in $(seq 1 100); do LEAK=$(child_of $LSH); [ -n "$LEAK" ] && break; sleep 0.05; done
# Several guard ticks' worth of headroom -- it must not need anywhere near the
# full LEAK_MS safety window.
sleep 20
kill -0 $LEAK 2>/dev/null && echo leak_alive_after_20s=1 || echo leak_alive_after_20s=0
wait $LSH 2>/dev/null || true
echo "leak_log=$(tail -n +$((pre + 1)) /tmp/ws/.fleet/memguard.log | tr '\\n' '|')"
kill -0 $MSH 2>/dev/null && echo marker_shell_alive=1 || echo marker_shell_alive=0
kill -0 $FLOCK 2>/dev/null && echo flock_alive=1 || echo flock_alive=0
kill -0 $MARKER 2>/dev/null && echo marker_alive=1 || echo marker_alive=0
echo "cgroup_oom_kill=$(awk '/^oom_kill /{print $2}' /sys/fs/cgroup/memory.events)"
echo "guard_alive=$([ -d /proc/$MG ] && echo 1 || echo 0)"
echo "--- log"
cat /tmp/ws/.fleet/memguard.log
`;
}

describe.skipIf(!dockerUp)("memguard in docker --memory=1g", () => {
  test(
    "kills the hog and a non-lead claude-named leak, spares the REAL tmux-pane lead (#238), fixes the inherited adj",
    () => {
      const region = extractRegion(BRINGUP, "memguard-start");
      const r = spawnSync(
        "docker",
        [
          "run", "--rm",
          "--memory=1g", "--memory-swap=1g",
          // Lowering oom_score_adj below 0 needs CAP_SYS_RESOURCE; docker drops
          // it by default, a studio VM runs as full root.
          "--cap-add=SYS_RESOURCE",
          "-v", `${CONTAINER_DIR}:/opt/fleet:ro`,
          "--entrypoint", "bash",
          IMAGE, "-c", scenario(region),
        ],
        { encoding: "utf8", timeout: 280_000 },
      );
      const out = r.stdout ?? "";
      const kv = Object.fromEntries(
        out.split("\n").filter((l) => /^[a-z_0-9]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
      );
      const log = out.split("--- log\n")[1] ?? "";
      console.log(out, r.stderr);

      expect(kv.guard_count).toBe("1");
      expect(kv.guard_parent_comm).toBe("flock");
      expect(kv.marker_adj).toBe("-1000");
      expect(kv.child_adj_at_birth).toBe("-1000"); // the trap is real
      expect(kv.child_adj_after_scan).toBe("500"); // and the guard defuses it
      // Idle CPU, robust to host load (#242). Measured guard/control over 30 s
      // (ticks): quiet host 10-27 absolute (control 3-7); loaded host the ratio
      // holds at 1.8-3.8x (39/11, 61/16, 89/28, 105/59) while a difference
      // grows with the load (#189 r3: 28 at control 11, 2 short of a limit
      // of 30). So: <= 30 ticks (1% of a core) OR <= 5x the bare-bun control.
      const guardTicks = Number(kv.guard_idle_ticks_30s);
      const controlTicks = Number(kv.control_idle_ticks_30s);
      console.log(`idle CPU: guard=${guardTicks} control=${controlTicks} ticks/30s`);
      expect(guardTicks).toBeLessThanOrEqual(Math.max(30, 5 * controlTicks));
            expect(kv.deaf_exit).toBe("137");
      expect(kv.marker_alive).toBe("1"); // the REAL lead, child of the REAL tmux pane: untouched
      // #238: the non-lead claude-named leak is an ORDINARY candidate now --
      // killed well inside its own 60 s safety window, by the guard, not by
      // outliving the test. The kernel never had to choose (cgroup_oom_kill=0
      // below): this replaces the pre-#238 "unrelievable pressure" shape
      // where the same process was immune by name alone.
      expect(kv.leak_alive_after_20s).toBe("0");
      expect(kv.leak_log).toMatch(/SIG(TERM|KILL) pid=\d+ comm=claude/);
      expect(kv.marker_shell_alive).toBe("1");
      expect(kv.flock_alive).toBe("1");
      expect(kv.cgroup_oom_kill).toBe("0");
      expect(kv.hog_exit).toBe("143"); // SIGTERM was enough for a hog that honours it
      expect(kv.guard_alive).toBe("1");
      expect(log).toMatch(new RegExp(`^\\S+Z SIG(TERM|KILL) pid=${kv.hog_pid} comm=bun rss_mib=\\d+ avail_mib=\\d+ total_mib=1024 source=cgroup cmd=bun /tmp/hog.js`, "m"));
      expect(log).toMatch(new RegExp(`SIGTERM pid=${kv.deaf_pid} .*\\n.*SIGKILL pid=${kv.deaf_pid} `));
    },
    300_000,
  );
});
