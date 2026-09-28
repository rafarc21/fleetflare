export interface MediaRef { key: string; name: string; type: string; }
export interface Item { status: string; note: string; media: MediaRef[]; }
export interface AddedRole { id: string; name: string; }
export interface AddedItem { id: string; role: string; pr: number; lab: string; where: string; }
export interface ReviewState {
  release: string;
  updated: string;
  items: Record<string, Item>;
  addedRoles: AddedRole[];
  addedItems: AddedItem[];
}
export interface Env {
  REVIEW_ROOM: DurableObjectNamespace;
  MEDIA: R2Bucket;
  REVIEW_READ_TOKEN: string;
  REVIEW_WRITE_TOKEN: string;
  /** Optional JSON map {"<token>":"<repo-prefix>"} of namespace-scoped read tokens. */
  REVIEW_READ_TOKENS?: string;
}
export function emptyState(release: string): ReviewState {
  return { release, updated: "", items: {}, addedRoles: [], addedItems: [] };
}
