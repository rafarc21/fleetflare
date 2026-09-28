export function encodeResize(cols: number, rows: number): string {
  return JSON.stringify({ t: "resize", cols, rows });
}
export function parseFrame(data: string | ArrayBuffer) {
  if (typeof data !== "string") return { type: "data" as const, bytes: new Uint8Array(data) };
  try {
    const j = JSON.parse(data);
    if (j?.t === "resize" && Number.isInteger(j.cols) && Number.isInteger(j.rows) && j.cols > 0 && j.rows > 0)
      return { type: "resize" as const, cols: j.cols, rows: j.rows };
  } catch {}
  return { type: "ignore" as const };
}

/** What a client knows about its own output stream. Shaped after node's
 *  `process.stdout`, which is what every caller passes. */
export interface TerminalSize {
  isTTY?: boolean;
  columns?: number;
  rows?: number;
}

/**
 * The resize frame a client is entitled to send, or `null` for "declare
 * nothing".
 *
 * THE SIZE-DECLARATION RULE (issue #43): only a client with a REAL TERMINAL
 * declares a size; a client reading programmatically declares nothing.
 *
 * The pty behind the WS is SHARED and opens at terminal.ts's
 * DEFAULT_COLS = 80. Nothing negotiates: whoever sends this frame sets the
 * size for EVERY client on that pty, including the human reading it. So a
 * client that does not know its own size must not invent one — a guessed
 * default is not a smaller lie than a wrong measurement, it is the same lie.
 * MEASURED 2026-09-23 on acme-os: cli/fleet.ts sent
 * `process.stdout.columns ?? 80` from an `ff` with no tty and pinned four
 * studios at 80 columns for hours while the operator's own client sat at 180,
 * which is what the torn output with stranded left-margin fragments was.
 *
 * A non-integer or non-positive size is refused for the same reason
 * parseFrame refuses one on the other side of the wire: the pty would take it
 * literally.
 */
export function resizeFrameFor(out: TerminalSize): string | null {
  if (out.isTTY !== true) return null;
  const { columns, rows } = out;
  if (!Number.isInteger(columns) || !Number.isInteger(rows)) return null;
  if ((columns as number) <= 0 || (rows as number) <= 0) return null;
  return encodeResize(columns as number, rows as number);
}
