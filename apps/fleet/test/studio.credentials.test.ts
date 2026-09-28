// Board issue #253 — pure, Worker-safe assertions on the generated shell
// TEXT (no real git, no child_process — this suite runs under
// vitest-pool-workers, same reason credentials.ts's own header names for
// why blueprintCredentialWriteCmd's tests live in test/bun instead of here
// for the "asked of git" property). The FUNCTIONAL proof that this shell,
// actually run, refuses/allows the right pushes lives in
// test/bun/git-wrapper.test.ts — real git, Linux lane only, never a studio
// (see that file's own header).
import { describe, it, expect } from "vitest";
import {
  studioGitSafetyCmd, studioGitWrapperScript,
  STUDIO_GIT_WRAPPER_PATH, STUDIO_GIT_WRAPPER_TMP_PATH, STUDIO_REAL_GIT_PATH,
  STUDIO_PUSH_REFUSAL, STUDIO_PUSH_UNRESOLVED_DEFAULT,
  STUDIO_PUSH_PROBE_FAILED, STUDIO_PUSH_SHELL_ALIAS_REFUSAL,
  STUDIO_PUSH_PLUMBING_REFUSAL, STUDIO_PUSH_ALIAS_DEPTH_REFUSAL,
} from "../src/studio/credentials";

describe("studioGitSafetyCmd — the two git config values (issue #253)", () => {
  it("sets push.default=current, git's own safer default for a bare push", () => {
    expect(studioGitSafetyCmd())
      .toContain(`'${STUDIO_REAL_GIT_PATH}' config --global push.default current`);
  });

  it("sets branch.autoSetupMerge=false — the actual root cause: no upstream, nothing to push into", () => {
    expect(studioGitSafetyCmd())
      .toContain(`'${STUDIO_REAL_GIT_PATH}' config --global branch.autoSetupMerge false`);
  });

  it("writes both through the ABSOLUTE real git, never a bare `git` — a broken wrapper must still self-repair", () => {
    const cmd = studioGitSafetyCmd();
    // A bare `git` resolves through PATH, which finds the WRAPPER. If the live
    // wrapper is broken (a bad install, a truncated write) these two steps fail
    // and the && chain aborts before the step that would have replaced it: a
    // broken wrapper could never repair itself (maestro round 2, item 4).
    for (const step of cmd.split(" && ")) {
      expect(step.trimStart()).not.toMatch(/^git\s/);
    }
  });

  it("is repeat-safe: both are single-valued keys, no --unset-all needed, plain overwrite on every call", () => {
    const cmd = studioGitSafetyCmd();
    // Neither line depends on a prior --unset-all — unlike
    // blueprintCredentialWriteCmd's multivalued credential.helper key.
    expect(cmd).not.toContain("--unset-all");
  });

  it("never sets core.hooksPath — it would disable every client repo's own hooks (maestro review of #259)", () => {
    expect(studioGitSafetyCmd()).not.toContain("core.hooksPath");
    expect(studioGitSafetyCmd()).not.toContain("/opt/fleet/git-hooks");
  });
});

describe("studioGitSafetyCmd — the atomic wrapper install (issue #253)", () => {
  it("installs the guard at /usr/local/bin/git, ahead of /usr/bin/git on PATH", () => {
    expect(STUDIO_GIT_WRAPPER_PATH).toBe("/usr/local/bin/git");
    expect(STUDIO_REAL_GIT_PATH).toBe("/usr/bin/git");
    expect(studioGitSafetyCmd()).toContain(STUDIO_GIT_WRAPPER_PATH);
  });

  it("stages the wrapper in a tmp file NEXT TO its destination, so the mv is same-filesystem and atomic", () => {
    expect(STUDIO_GIT_WRAPPER_TMP_PATH).toBe(`${STUDIO_GIT_WRAPPER_PATH}.fleet-install`);
    const cmd = studioGitSafetyCmd();
    expect(cmd).toContain(`> '${STUDIO_GIT_WRAPPER_TMP_PATH}'`);
    expect(cmd).toContain(`mv -f '${STUDIO_GIT_WRAPPER_TMP_PATH}' '${STUDIO_GIT_WRAPPER_PATH}'`);
  });

  it("chmod 0755's the TMP file, before the mv — the file is never live and unexecutable", () => {
    const cmd = studioGitSafetyCmd();
    const chmod = cmd.indexOf(`chmod 0755 '${STUDIO_GIT_WRAPPER_TMP_PATH}'`);
    const mv = cmd.indexOf(`mv -f '${STUDIO_GIT_WRAPPER_TMP_PATH}'`);
    expect(chmod).toBeGreaterThan(-1);
    expect(mv).toBeGreaterThan(chmod);
  });

  it("is ONE && chain: every step's failure aborts the install, so the exec's exit code covers all of them", () => {
    const cmd = studioGitSafetyCmd();
    // No newline-separated statement, no heredoc: a mid-chain heredoc would
    // put a step's failure past the && chain's own exit code (maestro review).
    expect(cmd).not.toContain("\n");
    expect(cmd).not.toContain("<<");
    // Every step is joined by && — count them and check nothing is joined by
    // a `;` or a bare newline instead.
    expect(cmd.split(" && ").length).toBeGreaterThanOrEqual(6);
    // ANY semicolon, not only a ` ; ` with a space on each side: a step joined
    // by `'; ` slipped past that narrower pin while still meaning "this step's
    // failure does not abort the chain" (maestro round 2, item 5). A properly
    // &&-chained command has no semicolon anywhere at all, and no other
    // separator either — `||` would swallow a failure just as thoroughly.
    expect(cmd).not.toMatch(/;/);
    expect(cmd).not.toContain("||");
    // Every separator really is ` && `, so no step is empty or glued to an `&`.
    for (const step of cmd.split(" && ")) {
      expect(step.length).toBeGreaterThan(0);
      expect(step).not.toMatch(/(^&|&$)/);
    }
  });

  it("carries the wrapper as base64, so no quoting in the outer shell can corrupt a byte of it", () => {
    const cmd = studioGitSafetyCmd();
    const b64 = Buffer.from(studioGitWrapperScript(), "utf8").toString("base64");
    expect(cmd).toContain(b64);
    expect(cmd).toContain("base64 -d");
    // base64 is A-Za-z0-9+/= only: nothing in it can close the outer shell's
    // own quoting, which is exactly why a heredoc is not needed here.
    expect(b64).toMatch(/^[A-Za-z0-9+/=]+$/);
  });

  it("ends by CONFIRMING a plain `git` now resolves to the wrapper — read-only, and the chain's exit code", () => {
    const cmd = studioGitSafetyCmd();
    // `hash -r` first: the same bash already ran `git config` above, so its
    // own hash table holds the pre-install resolution.
    expect(cmd).toContain("hash -r");
    expect(cmd.trimEnd().endsWith(`[ "$(command -v git)" = '${STUDIO_GIT_WRAPPER_PATH}' ]`)).toBe(true);
  });

  it("takes test seams for both paths, and defaults to the production pair", () => {
    const seamed = studioGitSafetyCmd({ wrapperPath: "/tmp/seam/git", realGit: "/tmp/seam/real-git" });
    expect(seamed).toContain("/tmp/seam/git");
    expect(seamed).toContain("/tmp/seam/git.fleet-install");
    expect(seamed).not.toContain("/usr/local/bin/git");
    expect(studioGitSafetyCmd()).toBe(
      studioGitSafetyCmd({ wrapperPath: STUDIO_GIT_WRAPPER_PATH, realGit: STUDIO_REAL_GIT_PATH }),
    );
  });
});

describe("studioGitWrapperScript — the generated /usr/local/bin/git wrapper (issue #253)", () => {
  it("is a bash script — the arg scan needs arrays, and the image's /bin/sh is dash", () => {
    expect(studioGitWrapperScript().startsWith("#!/bin/bash\n")).toBe(true);
  });

  it("delegates to the ABSOLUTE real git, never a PATH lookup — a PATH lookup would find itself", () => {
    const s = studioGitWrapperScript();
    expect(s).toContain(`real='${STUDIO_REAL_GIT_PATH}'`);
    // Every delegation goes through "$real": no bare `git` word ever runs.
    expect(s).toContain('exec "$real" "$@"');
    expect(s).not.toMatch(/^\s*(exec\s+)?git\s/m);
  });

  it("execs straight through for a non-push subcommand, with no extra git process", () => {
    const s = studioGitWrapperScript();
    // The hot builtins short-circuit BEFORE any `git config --get alias.` read.
    const builtins = s.indexOf("builtins=");
    const aliasRead = s.indexOf("config --get \"alias.$sub\"");
    expect(builtins).toBeGreaterThan(-1);
    expect(aliasRead).toBeGreaterThan(builtins);
    for (const hot of ["status", "diff", "log", "commit", "add", "checkout", "fetch", "rebase"]) {
      expect(s).toContain(` ${hot} `);
    }
    // `push` itself is never in the builtin passthrough list.
    expect(s).not.toMatch(/builtins='[^']* push [^']*'/);
  });

  it("skips git's own global options to find the subcommand, and the value-taking ones skip their value too", () => {
    const s = studioGitWrapperScript();
    expect(s).toContain("-C|-c|--git-dir|--work-tree|--namespace|--config-env|--attr-source");
  });

  it("treats an alias that expands to push as a push, so an alias cannot bypass the guard", () => {
    const s = studioGitWrapperScript();
    expect(s).toContain('config --get "alias.$sub"');
    // The expansion is re-scanned in place (it may carry its own globals and
    // its own push args), with a depth cap so a self-referential alias
    // cannot spin forever.
    expect(s).toContain("depth");
  });

  // Issue #310 round 2: WHERE a push goes is git's decision (branch remote,
  // pushRemote, pushDefault, --repo, pushurl, pushInsteadOf), so the
  // destination is the dry-run probe's own "To <url>" line and the default
  // branch is asked of exactly that url. Nothing is parsed out of the argv,
  // and nothing this container can rewrite (refs/remotes/<name>/HEAD) or that
  // names a remote rather than a url (remote show) is read.
  it("takes the destination from the probe's `To <url>` line and asks THAT url for its HEAD", () => {
    const s = studioGitWrapperScript();
    expect(s).toContain("'To '*)");
    // Issue #344: "--" before the url, and ls-remote is trusted only when
    // --get-url names that same url (a fetch-side insteadOf decoy fails it).
    expect(s).toContain('ls-remote --symref -- "$url" HEAD');
    expect(s).toContain('ls-remote --get-url -- "$url"');
    expect(s).not.toContain('refs/heads/main');
  });

  it("never resolves the target from the argv, the local symref, or `remote show`", () => {
    const s = studioGitWrapperScript();
    expect(s).not.toContain("target='origin'");
    expect(s).not.toContain("--repo|--receive-pack|--exec|--push-option|-o|--recurse-submodules");
    expect(s).not.toContain('symbolic-ref --quiet "refs/remotes/');
    expect(s).not.toContain("remote show");
  });

  it("an unknown default refuses every EXISTING ref moving — only a new ref (`*`) passes; no `To` line refuses", () => {
    const s = studioGitWrapperScript();
    expect(STUDIO_PUSH_UNRESOLVED_DEFAULT)
      .toBe("fleet: cannot resolve the remote's default branch -- refusing this push (fail closed)");
    expect(s).toContain(`elif [ "$flag" != '*' ]; then`);
    expect(s).toContain('if [ -z "$url" ]; then');
    const at = s.indexOf(STUDIO_PUSH_UNRESOLVED_DEFAULT);
    expect(s.slice(at, at + 200)).toContain("exit 1");
  });

  it("asks the real git what the push WOULD do: --dry-run --porcelain --no-verify --no-quiet", () => {
    const s = studioGitWrapperScript();
    expect(s).toContain("--dry-run --porcelain --no-verify --no-quiet");
  });

  it("puts its OWN flags LAST, after the user's args — git's parse is last-wins (maestro round 2, item 1)", () => {
    const s = studioGitWrapperScript();
    // Measured, git 2.34.1: with the guard's flags FIRST, a later `--no-dry-run`
    // in the user's own argv made the probe do the real push, and
    // `--no-porcelain`, `--quie`, `-qf` and `--verify` each neutered it. With
    // them last, all six hostile spellings lose.
    expect(s).toContain(
      'push "${pre[@]}" --no-verify --dry-run --porcelain --no-verify --no-quiet "${post[@]}"',
    );
    const flags = s.indexOf("--dry-run --porcelain --no-verify --no-quiet");
    expect(s.slice(0, flags)).toContain('pre+=("$a")');
  });

  // Maestro round 3, item 1 (HIGH): the regression the round-2 fix above
  // introduced. Flags last means they sit directly behind the caller's LAST
  // token, and a DANGLING option there (one expecting a separate value the
  // caller never gave) makes git eat the next token as its value — `--dry-run`.
  // Measured, git 2.34.1: a trailing `--repo`, `--rep` or `-o` each turned the
  // probe into the real push and moved the default branch.
  it("puts a SACRIFICIAL flag in front of the four, so a dangling option cannot eat --dry-run", () => {
    const s = studioGitWrapperScript();
    const probe = s.slice(s.indexOf('out=$("$real"'));
    // The sacrificial one is a repeat of --no-verify: being consumed as some
    // other option's value has to cost nothing, which is only true of a pure
    // flag whose real copy follows it.
    expect(probe).toContain('"${pre[@]}" --no-verify --dry-run');
    // And the four real flags are still whole, in order, after it.
    expect(probe).toContain("--dry-run --porcelain --no-verify --no-quiet");
    expect(s).toContain("SACRIFICIAL");
  });

  it("inserts those flags BEFORE a bare `--`, never after it — past a `--` they would be refspecs", () => {
    const s = studioGitWrapperScript();
    // Measured: `push origin -- HEAD:trunk --dry-run` makes git read --dry-run
    // as a src refspec and fail. Everything from the user's own `--` onward is
    // split off into "post" and re-appended after the guard's flags.
    expect(s).toContain("post+=(");
    expect(s).toContain("'--')");
  });

  it("CAPTURES the probe's exit code and refuses on failure — a failed probe is not 'nothing to push'", () => {
    const s = studioGitWrapperScript();
    expect(STUDIO_PUSH_PROBE_FAILED)
      .toBe("fleet: could not check what this push would move -- refusing it (fail closed)");
    expect(s).toContain("rc=$?");
    expect(s).toContain(STUDIO_PUSH_PROBE_FAILED);
    // The probe's own output is shown before the fleet line, so the operator
    // sees git's real error and not only that something was refused.
    const at = s.indexOf(STUDIO_PUSH_PROBE_FAILED);
    expect(s.slice(0, at)).toContain('printf \'%s\\n\' "$out" >&2');
    expect(s.slice(at, at + 200)).toContain("exit 1");
  });

  it("keeps the probe's stderr, rather than discarding it into /dev/null", () => {
    const s = studioGitWrapperScript();
    // Round 1 sent the probe's stderr to /dev/null, so a probe that failed left
    // nothing at all to report — and nothing to notice.
    expect(s).not.toContain(
      "push \"${pre[@]}\" --no-verify --dry-run --porcelain --no-verify --no-quiet \"${post[@]}\" 2>/dev/null",
    );
    expect(s).toContain("2>&1");
  });

  it("reads only lines whose first field is a real porcelain flag, so merged stderr cannot be misread", () => {
    const s = studioGitWrapperScript();
    expect(s).toContain("' '|'+'|'-'|'*'|'!'|'=')");
  });

  it("REFUSES EVERY '!' shell alias outright, unconditionally — no text inspection at all", () => {
    const s = studioGitWrapperScript();
    expect(STUDIO_PUSH_SHELL_ALIAS_REFUSAL)
      .toBe("fleet: a '!' shell alias that runs git cannot be guarded -- run the git command directly");
    expect(s).toContain(STUDIO_PUSH_SHELL_ALIAS_REFUSAL);
    // The refusal fires the instant the expansion starts with '!', with no
    // scan of its text or its arguments in between.
    const alias = s.indexOf("case \"$expansion\" in");
    const refuse = s.indexOf(STUDIO_PUSH_SHELL_ALIAS_REFUSAL, alias);
    expect(alias).toBeGreaterThan(-1);
    const between = s.slice(s.indexOf("'!'*)", alias), refuse);
    expect(between).not.toContain("case ");
    // And the round-1 claim this replaces must be gone: a '!' alias is NOT
    // "already guarded" by PATH.
    expect(s).not.toContain("already guarded");
  });

  // Issue #310 (X1): rounds 2 and 3's text scan (strip quote/expansion
  // characters, then refuse on a literal "push"/"send-pack"/"git" match) is a
  // losing arms race against arbitrary shell obfuscation, not a closed set of
  // tricks — measured, a shell GLOB ("g?t") hid the word "git" and an octal
  // `printf` escape inside a command substitution hid the word "push", and the
  // combination moved the default branch for real, past both round-3 triggers
  // at once. So the stripping/matching logic is gone entirely, not extended
  // with a third trigger.
  it("no longer scans the alias text at all — the stripping/matching logic is gone, not extended", () => {
    const s = studioGitWrapperScript();
    expect(s).not.toContain('for ch in \'"\'');
    expect(s).not.toContain("*push*|*send-pack*");
    expect(s).not.toContain("text=");
  });

  // Maestro round 3, item 2: `git send-pack <url> HEAD:refs/heads/<default>`
  // pushes without ever entering the push porcelain the probe understands, and
  // round 2's scanner recognized only `push`.
  it("REFUSES the push PLUMBING outright — send-pack and http-push never reach the real git", () => {
    const s = studioGitWrapperScript();
    expect(STUDIO_PUSH_PLUMBING_REFUSAL).toBe(
      "fleet: git send-pack and git http-push push without a check fleet can run -- use git push",
    );
    expect(s).toContain("send-pack|http-push)");
    expect(s).toContain(STUDIO_PUSH_PLUMBING_REFUSAL);
    const at = s.indexOf(STUDIO_PUSH_PLUMBING_REFUSAL);
    expect(s.slice(at, at + 200)).toContain("exit 1");
  });

  // Maestro round 3, item 3: the depth cap was `exec "$real" "$@"` — it handed
  // an argv it had given up reading to the real git, which resolves chains of
  // any length itself (measured: a ten-link chain pushed for real).
  it("REFUSES on alias depth overflow instead of handing over — fail closed, like every other unknown", () => {
    const s = studioGitWrapperScript();
    expect(STUDIO_PUSH_ALIAS_DEPTH_REFUSAL)
      .toBe("fleet: this alias chain is too deep to resolve -- refusing it (fail closed)");
    expect(s).toContain(STUDIO_PUSH_ALIAS_DEPTH_REFUSAL);
    expect(s).toContain('[ "$depth" -gt 8 ]');
    // The round-2 spelling — give up and hand over — must be gone.
    expect(s).not.toContain('[ "$depth" -gt 8 ] && exec "$real" "$@"');
  });

  // Maestro round 3, item 4: `git remote set-head origin <other>` rewrites the
  // LOCAL symref round 2 trusted, so one command left the real default branch
  // unprotected. `ls-remote --symref` asks the remote, which set-head cannot
  // touch (measured).
  it("asks the push URL for the default branch, per `To` block — a remote with several push urls is judged url by url", () => {
    const s = studioGitWrapperScript();
    const loop = s.indexOf('while IFS= read -r line; do');
    const ask = s.indexOf('ls-remote --symref -- "$url" HEAD');
    expect(loop).toBeGreaterThan(-1);
    expect(ask).toBeGreaterThan(loop);
  });

  it("refuses any porcelain line whose DESTINATION is refs/heads/<default> and whose flag is not '='", () => {
    const s = studioGitWrapperScript();
    expect(STUDIO_PUSH_REFUSAL).toBe("fleet: studios never push the default branch — open a PR");
    expect(s).toContain(STUDIO_PUSH_REFUSAL);
    expect(s).toContain('"refs/heads/$def"');
    // `=` is git's "up to date" flag: nothing would move, so it is not a push.
    expect(s).toContain('"$flag" = "="');
  });

  it("allows a push that targets no default-branch ref — the real git runs, repo hooks and all", () => {
    const s = studioGitWrapperScript();
    // The last thing the script does is hand over to the real git with the
    // user's ORIGINAL argv: no --no-verify, no rewritten refspec, so the
    // repo's own pre-push hook runs exactly as it would without the wrapper.
    expect(s.trimEnd().endsWith('exec "$real" "$@"')).toBe(true);
    expect(s).not.toContain('exec "$real" push --no-verify');
  });

  it("takes a realGit seam and defaults to /usr/bin/git", () => {
    expect(studioGitWrapperScript("/tmp/seam/real-git")).toContain("real='/tmp/seam/real-git'");
    expect(studioGitWrapperScript()).toBe(studioGitWrapperScript(STUDIO_REAL_GIT_PATH));
  });
});
