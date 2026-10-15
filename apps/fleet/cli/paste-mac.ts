// Mac clipboard image probe for `fleet attach`'s ctrl-v intercept and
// `fleet paste`. Shells out to `pngpaste` (brew install pngpaste) rather
// than talking to NSPasteboard directly — same approach as the hatcher
// paste intercept this CLI is modeled on — so this file has zero platform
// bindings of its own beyond Bun.spawn.
//
// The default tmp path is /tmp/fleet-paste.png (the brief's literal
// command), overridable via FLEET_PASTE_TMP so test lanes each own a
// private file. A single interactive `fleet attach` never pastes
// concurrently with itself.
// Injectable tmp path: FLEET_PASTE_TMP overrides the fixed /tmp default so
// test lanes (and any future concurrent caller) each own a private file
// instead of racing on one machine-wide path. Read at CALL time, not module
// load, so in-process mock lanes can point it wherever their test needs.
function pasteTmpPath(): string {
  return process.env.FLEET_PASTE_TMP ?? "/tmp/fleet-paste.png";
}

/**
 * Returns the clipboard image as PNG bytes, or null when there is nothing to
 * paste. `pngpaste` missing (ENOENT) and "clipboard has no image" both
 * collapse to the same null result — the Task 9 brief's ctrl-v policy
 * ("pngpaste missing or no image -> forward 0x16") treats them identically,
 * so the caller never needs to tell them apart.
 */
export async function grabClipboardPng(): Promise<Uint8Array | null> {
  try {
    const tmp = pasteTmpPath();
    const proc = Bun.spawn(["pngpaste", tmp], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    const code = await proc.exited;
    if (code !== 0) return null;

    const file = Bun.file(tmp);
    const bytes = new Uint8Array(await file.arrayBuffer());
    // Best-effort cleanup — a leftover screenshot in /tmp is cosmetic, not a
    // reason to fail a paste that already succeeded. ENOENT (never there /
    // already cleaned) is silent by design; anything else gets one line. The
    // errno code is interpolated because Error.toString() drops it.
    await file.delete().catch((e) => {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") console.error(`paste: tmp cleanup failed${code ? ` (${code})` : ""}`, e);
    });
    return bytes;
  } catch {
    // Bun.spawn throws synchronously (ENOENT) when `pngpaste` isn't on
    // PATH — the common case on a machine that hasn't `brew install
    // pngpaste`d yet.
    return null;
  }
}
