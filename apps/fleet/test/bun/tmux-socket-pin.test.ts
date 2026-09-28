// Issue #117 — every tmux command the Worker sends into a container goes
// through ONE builder (src/studio/tmux.ts), which addresses the studio's
// private socket when bring-up created one and the default server otherwise.
//
// This file is the source-scan pin: a new raw `tmux <subcommand>` anywhere in
// src/ fails CI, because a raw call addresses the DEFAULT server only and
// silently stops reaching the lead once the image moves the studio session to
// `tmux -L fleet-studio`. Same idea as test/studio.inspect.test.ts's forbidden
// list, applied to the whole Worker.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const SRC = join(ROOT, "src");

/** Every tmux command name (tmux 3.2a `list-commands`). */
const TMUX_COMMANDS = [
  "attach-session", "bind-key", "break-pane", "capture-pane", "choose-buffer", "choose-client",
  "choose-tree", "clear-history", "clear-prompt-history", "clock-mode", "command-prompt",
  "confirm-before", "copy-mode", "customize-mode", "delete-buffer", "detach-client", "display-menu",
  "display-message", "display-popup", "display-panes", "find-window", "has-session", "if-shell",
  "join-pane", "kill-pane", "kill-server", "kill-session", "kill-window", "last-pane", "last-window",
  "link-window", "list-buffers", "list-clients", "list-commands", "list-keys", "list-panes",
  "list-sessions", "list-windows", "load-buffer", "lock-client", "lock-server", "lock-session",
  "move-pane", "move-window", "new-pane", "new-session", "new-window", "next-layout", "next-window",
  "paste-buffer", "pipe-pane", "previous-layout", "previous-window", "refresh-client",
  "rename-session", "rename-window", "resize-pane", "resize-window", "respawn-pane",
  "respawn-window", "rotate-window", "run-shell", "save-buffer", "select-layout", "select-pane",
  "select-window", "send-keys", "send-prefix", "server-access", "set-buffer", "set-environment",
  "set-hook", "set-option", "set-window-option", "show-buffer", "show-environment", "show-hooks",
  "show-messages", "show-options", "show-prompt-history", "show-window-options", "source-file",
  "split-window", "start-server", "suspend-client", "swap-pane", "swap-window", "switch-client",
  "unbind-key", "unlink-window", "wait-for",
];

/** Every alias (`list-commands -F '#{command_list_alias}'`). */
const TMUX_ALIASES = [
  "attach", "bind", "breakp", "capturep", "clearhist", "clearphist", "confirm", "deleteb", "detach",
  "menu", "display", "popup", "displayp", "findw", "has", "if", "joinp", "killp", "killw", "lastp",
  "last", "linkw", "lsb", "lsc", "lscm", "lsk", "lsp", "ls", "lsw", "loadb", "lockc", "lock", "locks",
  "movep", "movew", "newp", "new", "neww", "nextl", "next", "pasteb", "pipep", "prevl", "prev",
  "refresh", "rename", "renamew", "resizep", "resizew", "respawnp", "respawnw", "rotatew", "run",
  "saveb", "selectl", "selectp", "selectw", "send", "setb", "setenv", "set", "setw", "showb",
  "showenv", "showmsgs", "show", "showphist", "showw", "source", "splitw", "start", "suspendc",
  "swapp", "swapw", "switchc", "unbind", "unlinkw", "wait",
];

/**
 * A raw call: `tmux` then either a leading flag (`-L`, `-u`, `-2`, `-C`, …) or
 * a word tmux would run. tmux accepts any unambiguous PREFIX of a command
 * name (`tmux a` is attach-session), so a word that starts any command name,
 * or equals an alias, counts. Prose like "in tmux studio:claude" does not.
 */
function isRawTmux(line: string): boolean {
  for (const m of line.matchAll(/\btmux\s+(\S+)/g)) {
    const w = m[1];
    if (/^-[A-Za-z0-9]/.test(w)) return true;
    const word = w.replace(/[^a-z-].*$/, "");
    if (word === "" || word !== w.replace(/[`'";)].*$/, "")) continue;
    if (TMUX_ALIASES.includes(word) || TMUX_COMMANDS.some((c) => c.startsWith(word))) return true;
  }
  return false;
}

/**
 * The only lines allowed to name tmux directly, each with the reason. An
 * entry that stops matching anything fails too, so this list cannot rot into
 * a blanket exemption.
 */
const ALLOWED: { file: string; contains: string; why: string }[] = [
  {
    file: "src/studio/failover.ts",
    contains: "tmux show-environment -t studio CLAUDE_CODE_OAUTH_TOKEN",
    why: "typed INTO the claude pane by send-keys, not run by sbExec: inside a pane $TMUX names " +
      "the pane's own server, so plain tmux already addresses whichever socket the studio runs on",
  },
  {
    file: "src/studio/cli-args.ts",
    contains: "via `tmux capture-pane -p`",
    why: "operator help text, not a command",
  },
];

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return tsFiles(p);
    return p.endsWith(".ts") ? [p] : [];
  });
}

/** A comment line: doc-comment body, `//` line, or `/*` opener. Prose about
 *  tmux lives there and is not a command. */
function isComment(line: string): boolean {
  const t = line.trim();
  return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*");
}

describe("every Worker tmux call goes through the socket-aware builder (#117)", () => {
  const hits: { file: string; line: number; text: string }[] = [];
  for (const abs of tsFiles(SRC)) {
    const file = relative(ROOT, abs);
    if (file === "src/studio/tmux.ts") continue; // the builder itself
    readFileSync(abs, "utf8").split("\n").forEach((text, i) => {
      if (!isComment(text) && isRawTmux(text)) hits.push({ file, line: i + 1, text: text.trim() });
    });
  }

  test("no raw `tmux <subcommand>` outside src/studio/tmux.ts and the allowlist", () => {
    const unexplained = hits.filter(
      (h) => !ALLOWED.some((a) => a.file === h.file && h.text.includes(a.contains)),
    );
    expect(unexplained.map((h) => `${h.file}:${h.line}  ${h.text}`)).toEqual([]);
  });

  test("every allowlist entry still matches a real line (no stale exemptions)", () => {
    for (const a of ALLOWED) {
      expect(hits.some((h) => h.file === a.file && h.text.includes(a.contains))).toBe(true);
    }
  });

  test("the scan itself is live: it catches a raw call", () => {
    expect(isRawTmux("`tmux send-keys -t studio:claude Enter`")).toBe(true);
    expect(isRawTmux("`tmux -L other has-session`")).toBe(true);
    // Short aliases and leading flags (tmux 3.2a) are raw calls too.
    for (const raw of [
      "tmux set -g mouse on", "tmux show -gv mouse", "tmux source -", "tmux lsw -t studio",
      "tmux splitw", "tmux run 'x'", "tmux if 'true' ''", "tmux a -t studio",
      "tmux -u send-keys", "tmux -2 attach", "tmux -C", "tmux -N new -d", "tmux -v ls",
    ]) expect(isRawTmux(raw)).toBe(true);
    expect(isRawTmux("claude is not running in tmux studio:claude")).toBe(false);
    expect(isRawTmux("could not read tmux ${WAKE_TARGET}")).toBe(false);
  });
});
