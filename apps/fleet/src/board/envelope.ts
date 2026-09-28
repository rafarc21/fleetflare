// §6's agent→board envelope: validated on the way in, rendered as one issue
// comment, and readable back out as the same struct. Pure — no I/O, no token,
// no fetch — so every rule here is unit-tested directly.
//
// Two shapes, deliberately not one:
//
//   IN  — flat, only what a sender owns: sender, intent, status, artifacts,
//         evidence, verification, open_questions, context_digest, learnings,
//         notes.
//   OUT — §6's document verbatim (nested envelope/payload/notes, snake_case),
//         with `msg_id` and `schema_version` stamped HERE.
//
// The split is the single-writer rule applied to threading: a sender that
// could set its own msg_id could forge or collide a thread, and a sender that
// could set schema_version could claim a schema it did not write. Those two
// fields are the Worker's stamp, so they are not in the input shape at all.
//
// `task_id` is the mirror case: optional in, checked when present. An
// envelope whose task_id disagrees with the issue it is being posted to is
// the wrong-agent-contamination class landing on the board, so it is refused
// rather than silently re-addressed.

import {
  ENVELOPE_INTENTS, ENVELOPE_STATUSES,
  type EnvelopeArtifact, type EnvelopeDoc, type EnvelopeIntent, type EnvelopeStatus, type EnvelopeVerification,
} from "./types";

export const ENVELOPE_SCHEMA_VERSION = "1";

/** GitHub's own comment body limit. Checked against the RENDERED comment,
 *  which is what GitHub stores — a caller measuring only its own notes would
 *  miss the artifacts and evidence rendered around them. */
export const ENVELOPE_MAX_CHARS = 65_536;

export type EnvelopeResult =
  | { ok: true; doc: EnvelopeDoc }
  | { ok: false; message: string };

function textList(raw: unknown, field: string): { ok: true; list: string[] } | { ok: false; message: string } {
  if (raw === undefined || raw === null) return { ok: true, list: [] };
  if (!Array.isArray(raw)) return { ok: false, message: `${field} must be an array of strings` };
  for (const entry of raw) {
    if (typeof entry !== "string") return { ok: false, message: `${field} must contain only strings` };
  }
  return { ok: true, list: (raw as string[]).map((s) => s.trim()).filter((s) => s !== "") };
}

/**
 * Task 4 (P5a guardrails): the teardown learning harvest's read side
 * (src/studio/do.ts's harvestLearnings) validates a raw `learnings` field
 * pulled out of a studio's own done record (the delivered task's
 * `/workspace/.fleet/done/<task>.json`, #316/#361) against this SAME rule — wired here rather than reimplemented,
 * so a harvested learning is held to the identical bar a board envelope's
 * payload.learnings already enforces (array of strings, trimmed, blanks
 * dropped).
 *
 * A dedicated export rather than exporting `textList` itself: every OTHER
 * textList field (evidence, open_questions, context_digest) stays
 * board-only, and a generic export would let a caller outside this module
 * validate against any of them by accident.
 */
export function parseLearnings(raw: unknown): { ok: true; list: string[] } | { ok: false; message: string } {
  return textList(raw, "learnings");
}

function artifacts(raw: unknown): { ok: true; list: EnvelopeArtifact[] } | { ok: false; message: string } {
  if (raw === undefined || raw === null) return { ok: true, list: [] };
  if (!Array.isArray(raw)) return { ok: false, message: "artifacts must be an array" };
  const list: EnvelopeArtifact[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) {
      return { ok: false, message: "each artifact must be an object {kind, path|pr|url, digest?}" };
    }
    const a = entry as Record<string, unknown>;
    const kind = typeof a.kind === "string" ? a.kind.trim() : "";
    if (kind === "") return { ok: false, message: "each artifact needs a non-empty kind" };
    const artifact: EnvelopeArtifact = { kind };
    for (const locator of ["path", "pr", "url"] as const) {
      const v = a[locator];
      if (v === undefined || v === null) continue;
      if (typeof v !== "string" || v.trim() === "") {
        return { ok: false, message: `artifact ${locator} must be a non-empty string` };
      }
      artifact[locator] = v.trim();
    }
    // An artifact that locates nothing is a claim with no referent — exactly
    // what §6's evidence rule exists to keep off the board.
    if (!artifact.path && !artifact.pr && !artifact.url) {
      return { ok: false, message: "each artifact needs at least one of path, pr or url" };
    }
    if (typeof a.digest === "string" && a.digest.trim() !== "") artifact.digest = a.digest.trim();
    list.push(artifact);
  }
  return { ok: true, list };
}

const VERIFICATION_SHAPE = "a well-formed { url, steps: [\"...\"], expected }";

/**
 * §4: the same shape a human needs regardless of domain — a URL, the steps
 * they click through, what they should see. Sub-fields are shape-checked
 * whenever the block is present, required or not, so a malformed block
 * never slips through just because it was not required here.
 */
function verification(raw: unknown): { ok: true; value: EnvelopeVerification } | { ok: false; message: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, message: `verification must be an object — ${VERIFICATION_SHAPE}` };
  }
  const v = raw as Record<string, unknown>;
  const url = typeof v.url === "string" ? v.url.trim() : "";
  if (url === "") return { ok: false, message: `verification.url must be a non-empty string — ${VERIFICATION_SHAPE}` };
  if (!Array.isArray(v.steps) || v.steps.some((s) => typeof s !== "string")) {
    return { ok: false, message: `verification.steps must be an array of strings — ${VERIFICATION_SHAPE}` };
  }
  const steps = (v.steps as string[]).map((s) => s.trim()).filter((s) => s !== "");
  if (steps.length === 0) {
    return { ok: false, message: `verification.steps needs at least one step — ${VERIFICATION_SHAPE}` };
  }
  const expected = typeof v.expected === "string" ? v.expected.trim() : "";
  if (expected === "") {
    return { ok: false, message: `verification.expected must be a non-empty string — ${VERIFICATION_SHAPE}` };
  }
  return { ok: true, value: { url, steps, expected } };
}

/**
 * Validates one sender's envelope against §6 and composes the stored
 * document. `taskId` is the issue the comment is going ON (the route's own
 * number, never the body's) and `msgId` is minted by the caller — the Worker
 * — for the same reason it is not in the input shape.
 */
export function parseEnvelope(raw: unknown, taskId: number, msgId: string): EnvelopeResult {
  if (typeof raw !== "object" || raw === null) return { ok: false, message: "envelope must be a JSON object" };
  const body = raw as Record<string, unknown>;

  if (body.task_id !== undefined && body.task_id !== null && body.task_id !== taskId) {
    return {
      ok: false,
      message: `envelope task_id ${JSON.stringify(body.task_id)} does not match task ${taskId} — ` +
        "refusing to post one task's result onto another",
    };
  }

  const sender = typeof body.sender === "string" ? body.sender.trim() : "";
  if (sender === "") return { ok: false, message: "envelope needs a non-empty sender" };

  if (!ENVELOPE_INTENTS.includes(body.intent as EnvelopeIntent)) {
    return { ok: false, message: `unknown intent ${JSON.stringify(body.intent)} — one of ${ENVELOPE_INTENTS.join("|")}` };
  }
  if (!ENVELOPE_STATUSES.includes(body.status as EnvelopeStatus)) {
    return { ok: false, message: `unknown status ${JSON.stringify(body.status)} — one of ${ENVELOPE_STATUSES.join("|")}` };
  }

  const arts = artifacts(body.artifacts);
  if (!arts.ok) return arts;
  const evidence = textList(body.evidence, "evidence");
  if (!evidence.ok) return evidence;
  const openQuestions = textList(body.open_questions, "open_questions");
  if (!openQuestions.ok) return openQuestions;
  const contextDigest = textList(body.context_digest, "context_digest");
  if (!contextDigest.ok) return contextDigest;
  const learnings = textList(body.learnings, "learnings");
  if (!learnings.ok) return learnings;

  // §4 (fix round 1): every GRADED RESULT — ok, partial, failed, blocked —
  // must say WHERE a human checks this landed. Exempt ONLY on intent !==
  // "result": a request/clarify/escalate produced nothing to point at.
  // status is NOT part of the test — partial still ships a PR (artifacts is
  // independent of status), failed work often still deployed something, and
  // even blocked writes down "nothing to verify — blocked before X", itself
  // information the operator wants. A narrower test let partial work reach the
  // checklist with no verification pointer (real path: partial + PR +
  // CI-green merge + staging deploy, §5/§7). Non-code studios have no
  // second net either — STUDIO_COMPLETION_GATE never installs for them, so
  // this schema check is their ONLY backstop, and cannot be narrower than
  // "nothing produced".
  const isGradedResult = body.intent === "result";
  let verificationValue: EnvelopeVerification | undefined;
  if (body.verification !== undefined && body.verification !== null) {
    const v = verification(body.verification);
    if (!v.ok) return v;
    verificationValue = v.value;
  } else if (isGradedResult) {
    return {
      ok: false,
      message: `a "result" envelope needs "verification": ${VERIFICATION_SHAPE} — ` +
        "where a human checks this landed, the same way the gate demands test evidence",
    };
  }

  if (body.notes !== undefined && body.notes !== null && typeof body.notes !== "string") {
    return { ok: false, message: "notes must be a string" };
  }

  const doc: EnvelopeDoc = {
    envelope: {
      msg_id: msgId,
      task_id: taskId,
      sender,
      intent: body.intent as EnvelopeIntent,
      schema_version: ENVELOPE_SCHEMA_VERSION,
    },
    payload: {
      status: body.status as EnvelopeStatus,
      artifacts: arts.list,
      evidence: evidence.list,
      verification: verificationValue,
      open_questions: openQuestions.list,
      context_digest: contextDigest.list,
      learnings: learnings.list,
    },
    notes: typeof body.notes === "string" ? body.notes.trim() : "",
  };

  const rendered = renderEnvelopeComment(doc);
  if (rendered.length > ENVELOPE_MAX_CHARS) {
    return {
      ok: false,
      message: `rendered envelope is ${rendered.length} chars, over GitHub's ${ENVELOPE_MAX_CHARS}-char comment limit`,
    };
  }
  return { ok: true, doc };
}

function artifactLine(a: EnvelopeArtifact): string {
  const locator = a.pr ? `PR #${a.pr}` : a.url ? a.url : `\`${a.path}\``;
  return `- ${locator} — ${a.kind}${a.digest ? ` (${a.digest})` : ""}`;
}

/** A heading with nothing under it reads as a section someone forgot to
 *  fill in. "(none)" is a statement: this slot was considered and is empty —
 *  which is the whole point of open_questions being structural. */
function listBlock(heading: string, entries: string[]): string[] {
  return ["", `**${heading}**`, "", ...(entries.length === 0 ? ["- (none)"] : entries.map((e) => `- ${e}`))];
}

/** §4's block, rendered only when present — most envelopes are not
 *  graded results and carry nothing here. Release Studio concatenates these
 *  across studios into one checklist, mechanically — so the shape stays
 *  fixed (URL, Steps, Expected) rather than free prose. */
function verificationBlock(v: EnvelopeVerification | undefined): string[] {
  if (!v) return [];
  return [
    "", "**Verification**", "",
    `- URL: ${v.url}`,
    "- Steps:",
    ...v.steps.map((s) => `  - ${s}`),
    `- Expected: ${v.expected}`,
  ];
}

/**
 * The comment body: caveman prose first, the struct last and collapsed.
 *
 * Both halves are required by §5/§6 at once — "machine-parseable,
 * human-readable" — and they are not the same rendering. A human on the phone
 * reads the top; parseEnvelopeComment below reads the bottom.
 */
export function renderEnvelopeComment(doc: EnvelopeDoc): string {
  const { envelope: e, payload: p } = doc;
  const lines: string[] = [`**${e.intent}** from \`${e.sender}\` — status **${p.status}**`];
  if (doc.notes !== "") lines.push("", doc.notes);
  lines.push(
    ...listBlock("Artifacts", p.artifacts.map(artifactLine).map((l) => l.replace(/^- /, ""))),
    ...listBlock("Evidence", p.evidence),
    ...verificationBlock(p.verification),
    ...listBlock("Open questions", p.open_questions),
    ...listBlock("Context digest", p.context_digest),
  );
  if (p.learnings.length > 0) lines.push(...listBlock("Learnings", p.learnings));
  lines.push(
    "",
    "<details>",
    "<summary>envelope (machine-readable)</summary>",
    "",
    "```json",
    JSON.stringify(doc, null, 2),
    "```",
    "",
    "</details>",
    "",
  );
  return lines.join("\n");
}

const FENCE_JSON = "```json";

/** One fenced slice into §6's shape, or null. Shape-checked, not just
 *  JSON-parsed: a caller must never mistake some other fenced object in the
 *  comment for a result. */
function decodeDoc(slice: string): EnvelopeDoc | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(slice);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const doc = parsed as Partial<EnvelopeDoc>;
  if (!doc.envelope || !doc.payload || typeof doc.notes !== "string") return null;
  if (typeof doc.envelope.msg_id !== "string" || typeof doc.envelope.task_id !== "number") return null;
  return doc as EnvelopeDoc;
}

/**
 * The struct back out of a comment body, or null when this comment is not an
 * envelope (a human wrote it, or an older schema did).
 *
 * The closing fence is the body's LAST one, because the struct is always
 * appended last. The opening fence is then searched BACKWARDS from there, and
 * the first candidate that decodes into §6's shape wins — a plain
 * lastIndexOf(FENCE_JSON) is wrong, and the failure is not hypothetical:
 * `notes` is free text, so a sender that quotes a json block gets that block
 * serialised INSIDE the struct's own JSON, putting a later "```json" in the
 * body than the struct's real opener. Candidates that start mid-string decode
 * to nothing and are skipped; the real opener is the one that parses.
 */
export function parseEnvelopeComment(body: string): EnvelopeDoc | null {
  const close = body.lastIndexOf("```");
  if (close === -1) return null;
  let searchFrom = close - 1;
  while (searchFrom >= 0) {
    const open = body.lastIndexOf(FENCE_JSON, searchFrom);
    if (open === -1) return null;
    const doc = decodeDoc(body.slice(open + FENCE_JSON.length, close));
    if (doc) return doc;
    searchFrom = open - 1;
  }
  return null;
}
