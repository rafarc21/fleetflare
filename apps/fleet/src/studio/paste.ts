// Pure paste logic — same split as provision.ts and terminal.ts, and for the
// same reason (see either file's own header): StudioDO is container-backed
// and cannot be constructed under vitest-pool-workers, so nothing left
// inside do.ts is testable. do.ts's pasteImage is a one-line forward to
// pasteWithStorage below, over `this.ctx.storage` (a real DurableObjectStorage
// satisfies SeqStorage structurally, no cast needed — same relationship
// provision.ts's StudioStorage has to `this.ctx.storage`).
//
// test/studio.paste.test.ts wires a fake StudioDO stub whose pasteImage
// calls this SAME exported pasteWithStorage, over an in-memory SeqStorage —
// not a hand-copied reimplementation of the counter read/write sequence
// (the exact duplication provision.ts's header warns against, review round
// 2, Important 2 on that file).

/**
 * The three mimes this route accepts, mapped to their on-disk extension.
 * routes.ts imports this directly for its own early 415 check (before the
 * body is ever read) — this file is the one place that defines "which mimes
 * paste accepts", so routes.ts's pre-check and this file's own extension
 * lookup can never drift apart.
 *
 * jpeg deliberately maps to "jpg", not "jpeg" — the mime subtype and the
 * file extension are not the same string (Task 6 brief, explicit ruling).
 */
export const PASTE_MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

/** Hard cap on a pasted image, in bytes (Task 6 brief's exact value). */
export const PASTE_MAX_BYTES = 10_485_760;

/** DO storage key for the monotonic filename counter. Exported so a test
 *  could seed/read it directly through the same key this file uses, the
 *  same reason provision.ts exports STATUS_KEY. */
export const PASTE_SEQ_KEY = "pasteSeq";

const PASTE_DIR = "/workspace/.paste";

/**
 * Minimal counter-storage port — mirrors provision.ts's StudioStorage (same
 * two methods, narrower value type). A real `this.ctx.storage` satisfies
 * this structurally; tests pass a plain in-memory Map-backed fake.
 */
export interface SeqStorage {
  get(key: string): Promise<number | undefined>;
  put(key: string, value: number): Promise<void>;
}

/** Dependency seam — mirrors provision.ts's ProvisionDeps. `writeFile` stands
 *  in for the whole sandbox write (do.ts's real pasteImage plugs in
 *  `(path, bytes) => sbWriteFile(this, path, bytes)`, the same
 *  pre-bound-over-`this` shape ProvisionDeps.sbExec uses). */
export interface PasteDeps {
  writeFile: (path: string, bytes: Uint8Array) => Promise<void>;
}

/**
 * Server-generated filename only — never user input. Bumps the DO's
 * `pasteSeq` counter and writes the bytes to `/workspace/.paste/img-<n>.<ext>`.
 *
 * Review finding (post-Task-6): the counter used to be persisted only AFTER
 * a successful write (get -> write -> put), on the theory that a failed
 * write shouldn't burn a number. That put `deps.writeFile` — a non-storage
 * await — BETWEEN the get and the put. Under a real DO, awaiting anything
 * that isn't itself a storage op releases the input gate, so a second
 * concurrent `pasteImage` call can interleave its own `get` before the
 * first call's `put` ever lands: both read the same prior value, both
 * compute the SAME seq, one write silently clobbers the other on disk, and
 * BOTH callers get a 200 with a path that no longer points at their bytes.
 * Reproduced empirically (two un-awaited `pasteWithStorage` calls, see
 * test/studio.paste.test.ts's concurrency test) — a real bug, not a
 * theoretical one.
 *
 * Fix: reserve the number FIRST — `get` immediately followed by `put`,
 * nothing else awaited in between — then do the (possibly slow, possibly
 * failing) write. This deliberately trades away the old property: a write
 * that fails now leaves a GAP in the numbering (the seq was already
 * consumed before the failure), so a retry gets the next number, not the
 * same one. That trade is the right one — a gap is cosmetic, a collision is
 * silent data loss. routes.ts turns a thrown `deps.writeFile` into a 500;
 * this function does not catch it (unlike runProvision's catch-and-degrade
 * — there is no "degraded" state for a single paste to settle into, the
 * request either lands or it didn't).
 *
 * mime validity is NOT re-checked here beyond the lookup itself: routes.ts's
 * own 415 check (against the exact same PASTE_MIME_EXT map, above) is the
 * contract every caller of this function must already satisfy. The lookup
 * below is a defensive assertion for a contract violation, not a second
 * user-facing validation path.
 */
export async function pasteWithStorage(
  deps: PasteDeps, storage: SeqStorage, contentType: string, bytes: Uint8Array,
): Promise<{ path: string }> {
  const ext = PASTE_MIME_EXT[contentType];
  if (!ext) throw new Error(`paste: unsupported content type reached storage layer: ${contentType}`);

  const seq = ((await storage.get(PASTE_SEQ_KEY)) ?? 0) + 1;
  await storage.put(PASTE_SEQ_KEY, seq);
  const path = `${PASTE_DIR}/img-${seq}.${ext}`;
  await deps.writeFile(path, bytes);
  return { path };
}
