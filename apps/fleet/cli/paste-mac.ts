// Mac clipboard image probe for `fleet attach`'s ctrl-v intercept and
// `fleet paste`. Shells out to `pngpaste` (brew install pngpaste) rather
// than talking to NSPasteboard directly — same approach as the hatcher
// paste intercept this CLI is modeled on — so this file has zero platform
// bindings of its own beyond Bun.spawn.
//
// Fixed tmp path, matching the brief's literal command
// (`pngpaste /tmp/fleet-paste.png`): a single interactive `fleet attach`
// session never pastes concurrently with itself, so there is no collision
// to guard against the way paste.ts's server-side pasteSeq has to.
const PASTE_TMP_PATH = "/tmp/fleet-paste.png";

/**
 * Returns the clipboard image as PNG bytes, or null when there is nothing to
 * paste. `pngpaste` missing (ENOENT) and "clipboard has no image" both
 * collapse to the same null result — the Task 9 brief's ctrl-v policy
 * ("pngpaste missing or no image -> forward 0x16") treats them identically,
 * so the caller never needs to tell them apart.
 */
export async function grabClipboardPng(): Promise<Uint8Array | null> {
  try {
    const proc = Bun.spawn(["pngpaste", PASTE_TMP_PATH], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    const code = await proc.exited;
    if (code !== 0) return null;

    const file = Bun.file(PASTE_TMP_PATH);
    const bytes = new Uint8Array(await file.arrayBuffer());
    // Best-effort cleanup — a leftover screenshot in /tmp is cosmetic, not a
    // reason to fail a paste that already succeeded.
    await file.delete().catch(() => {});
    return bytes;
  } catch {
    // Bun.spawn throws synchronously (ENOENT) when `pngpaste` isn't on
    // PATH — the common case on a machine that hasn't `brew install
    // pngpaste`d yet.
    return null;
  }
}
