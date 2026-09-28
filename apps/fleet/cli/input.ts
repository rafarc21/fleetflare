// Local-input classification for `fleet attach`'s byte loop. Pure — no I/O
// — so it is exercised directly by test/cli.input.test.ts rather than
// through a live stdin chunk.
//
// Review round 1, Important 2: hatcher's isLocalDetachInput pattern —
// ctrl-] / ctrl-v are intercepted ONLY when the entire stdin chunk is
// exactly one byte. Raw-mode keypresses arrive as standalone single-byte
// reads; anything longer is a paste (a real terminal/OS-level paste, not
// this CLI's own ctrl-v image-paste feature) or a burst of fast/buffered
// typing, and must reach the remote session untouched. Scanning a
// multi-byte chunk for an embedded 0x1d used to kill the session on any
// local paste that happened to contain that byte; an embedded 0x16 used to
// splice a paste-upload attempt into the middle of forwarded text.
export const CTRL_RBRACKET = 0x1d;
export const CTRL_V = 0x16;

export type Intercept = "escape" | "paste" | null;

/** `null` means "not a standalone control keypress — forward the chunk
 *  exactly as received", which covers both an ordinary single byte and any
 *  multi-byte chunk (regardless of what bytes it contains). */
export function classifyInput(chunk: Uint8Array): Intercept {
  if (chunk.length !== 1) return null;
  if (chunk[0] === CTRL_RBRACKET) return "escape";
  if (chunk[0] === CTRL_V) return "paste";
  return null;
}
