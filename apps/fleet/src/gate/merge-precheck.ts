// #1169: merge-precheck pure rules, stubbed. Tests pin real behavior; this
// file is the red half of the TDD pair.
import { leakHitMessage, scanText } from "../leak-gate";

export const CLOSING_KEYWORD_RE = /(^|[^a-z])(close[sd]?|fix(es|ed)?|resolve[sd]?) #[0-9]/gim;

export function closingKeywordFailure(title: string, body: string): string | null {
  return null;
}

export function leakFailure(patterns: string[], blobs: string[]): string | null {
  return null;
}

export function mergePrecheckFailures(input: {
  title: string; body: string; patterns: string[]; blobs: string[];
}): string[] {
  return [];
}