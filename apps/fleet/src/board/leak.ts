// Issue #1 piece 4: the Worker-side leak gate on board writes. Every issue
// and comment (envelopes included) the board posts is scanned against the
// ops-repo denylist first; a hit refuses the write. Core rules live in
// src/leak-gate.ts -- fail closed, name the pattern index, never the term.
//
// Ports, not env: `isPrivate` and `fetchDenylist` are injected so every
// branch runs under the test pool without GitHub. Only a CONFIRMED private
// repo skips the scan; an isPrivate that throws is read as public.

import { GitHubError } from "./api";
import type { BoardApi } from "./board";
import {
  parseDenylist, scanText, leakHitMessage, LEAK_DENYLIST_MISSING, LEAK_SCAN_ERROR,
} from "../leak-gate";

export interface LeakGuardDeps {
  isPrivate: (repo: string) => Promise<boolean>;
  /** The raw denylist text. Throws when there is none to read. */
  fetchDenylist: () => Promise<string>;
}

export type LeakCheck = (repo: string, texts: string[]) => Promise<void>;

/** A refusal: 422 on a hit, 503 on anything that stopped the scan. A
 *  GitHubError so every caller's existing catch still sees it; its own class
 *  so the routes can surface it without re-reading a real GitHub 422/503. */
export class LeakGateError extends GitHubError {
  constructor(status: number, message: string) {
    super(status, message);
    this.name = "LeakGateError";
  }
}

/** One guard per BoardApi instance: the denylist is fetched once and reused. */
export function leakGuard(deps: LeakGuardDeps): LeakCheck {
  let patterns: Promise<string[]> | null = null;
  return async (repo, texts) => {
    let isPrivate = false;
    try {
      isPrivate = (await deps.isPrivate(repo)) === true;
    } catch (err) {
      console.error(`leak gate: visibility of ${repo} unknown, scanning as public`, err instanceof Error ? err.message : String(err));
    }
    if (isPrivate) return;

    patterns ??= deps.fetchDenylist().then(parseDenylist);
    let list: string[];
    try {
      list = await patterns;
    } catch (err) {
      console.error("leak gate: denylist unavailable", err instanceof Error ? err.message : String(err));
      throw new LeakGateError(503, LEAK_DENYLIST_MISSING);
    }
    let hits: number[];
    try {
      hits = scanText(list, texts.join("\n"));
    } catch {
      throw new LeakGateError(503, LEAK_SCAN_ERROR);
    }
    if (hits.length > 0) throw new LeakGateError(422, leakHitMessage(hits));
  };
}

/** `api` with its two text writes gated. Every other method passes through. */
export function guardBoardApi(api: BoardApi, check: LeakCheck): BoardApi {
  return {
    ...api,
    createIssue: async (repo, input) => {
      await check(repo, [input.title, input.body, ...input.labels]);
      return api.createIssue(repo, input);
    },
    createComment: async (repo, number, body) => {
      await check(repo, [body]);
      return api.createComment(repo, number, body);
    },
  };
}
