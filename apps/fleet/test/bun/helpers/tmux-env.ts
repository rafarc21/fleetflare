/**
 * An env whose tmux can ONLY reach the throwaway server under `dir`.
 *
 * `TMUX_TMPDIR` alone is not isolation. When `TMUX` is set -- i.e. this test
 * runs INSIDE a tmux session, which is exactly where a studio lead runs it --
 * tmux targets the CURRENT server named in `$TMUX` and ignores TMUX_TMPDIR.
 * The session/window names here are the real ones (`studio:claude`), so this
 * suite then typed its fixtures into the live claude window and its
 * `kill-server` killed the studio outright. MEASURED 2026-09-18: a sentinel
 * server with those names died when this file ran inside it; three studio
 * leads died this way over two days. Stripping TMUX/TMUX_PANE makes tmux fall
 * back to TMUX_TMPDIR, i.e. the throwaway server, wherever the test runs.
 */
export function isolatedTmuxEnv(dir: string): Record<string, string | undefined> {
  const { TMUX: _tmux, TMUX_PANE: _pane, ...rest } = process.env;
  return { ...rest, TMUX_TMPDIR: dir };
}
