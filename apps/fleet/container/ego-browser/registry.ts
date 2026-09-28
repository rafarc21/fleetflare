/**
 * Pure task-space / label bookkeeping. Deliberately has no Playwright
 * import and does no I/O -- generic over the "target" type (a real
 * Playwright Page daemon-side, a plain fake object in tests) and the
 * "context" type (a real BrowserContext daemon-side, anything in tests).
 * daemon.ts is the only module that plugs real Playwright types in here;
 * everything below is fast, deterministic, and unit-testable on its own.
 */

export interface LabelState<TTarget> {
  readonly label: string;
  /** undefined = lazy: registered but no real target materialized yet. */
  target: TTarget | undefined;
}

export type FinishKeep = "all" | string[];

export interface FinishReceipt {
  retained: string[];
  closed: string[];
  /** true when nothing survived and the whole space (context) should close too. */
  spaceClosed: boolean;
}

export class TaskSpaceRecord<TTarget, TContext> {
  readonly spaceId: number;
  name: string;
  context: TContext;
  private labels = new Map<string, LabelState<TTarget>>();
  private autoLabelCounter = 1;
  // Keyed by label. Closes the same check-then-act window resolveTarget()
  // itself would otherwise have: two concurrent callers materializing the
  // SAME still-lazy label (the ordinary `Promise.all([p1.goto(...),
  // p1.evaluate(...)])` pattern on a page never touched yet, since a page
  // starts lazy by design) both see `getTarget(label) === undefined` and
  // both create a real target -- last `setTarget` wins, the other one is
  // silently leaked. The second (and any further) concurrent caller
  // instead awaits the FIRST caller's in-flight creation and reuses its
  // result. Cleared once settled so it never leaks memory across the
  // daemon's lifetime.
  private pendingTargets = new Map<string, Promise<TTarget>>();

  constructor(spaceId: number, name: string, context: TContext) {
    this.spaceId = spaceId;
    this.name = name;
    this.context = context;
    // "a new space starts with managed Page p1" -- registered lazily, no
    // real target until something actually acts on it.
    this.ensureLabel("p1");
    this.autoLabelCounter = 2;
  }

  /** Registers `label` if it is not already tracked (lazy: target stays undefined). Idempotent. */
  ensureLabel(label: string): LabelState<TTarget> {
    let state = this.labels.get(label);
    if (!state) {
      state = { label, target: undefined };
      this.labels.set(label, state);
    }
    return state;
  }

  setTarget(label: string, target: TTarget): void {
    this.ensureLabel(label).target = target;
  }

  getTarget(label: string): TTarget | undefined {
    return this.labels.get(label)?.target;
  }

  /**
   * Reuse-or-create `label`'s real target, de-duplicated against any other
   * concurrent caller resolving the SAME label at the same time (see
   * `pendingTargets` above). `create` is only invoked for the caller that
   * actually wins the race to materialize this label -- every other
   * concurrent caller awaits and reuses that same result instead of
   * creating (and leaking) a second one.
   */
  async resolveTarget(label: string, create: (context: TContext) => TTarget | Promise<TTarget>): Promise<TTarget> {
    const existing = this.getTarget(label);
    if (existing) return existing;

    const pending = this.pendingTargets.get(label);
    if (pending) return pending;

    const attempt = (async (): Promise<TTarget> => {
      const target = await create(this.context);
      this.setTarget(label, target);
      return target;
    })().finally(() => {
      this.pendingTargets.delete(label);
    });
    this.pendingTargets.set(label, attempt);
    return attempt;
  }

  hasLabel(label: string): boolean {
    return this.labels.has(label);
  }

  listLabels(): LabelState<TTarget>[] {
    return [...this.labels.values()];
  }

  /** Never reuses a number, even across closed labels -- matches durable-label semantics. */
  nextAutoLabel(): string {
    const label = `p${this.autoLabelCounter}`;
    this.autoLabelCounter += 1;
    return label;
  }

  removeLabel(label: string): TTarget | undefined {
    const state = this.labels.get(label);
    this.labels.delete(label);
    return state?.target;
  }

  /**
   * Pure receipt computation for task.finish({keep}). Does NOT close any
   * real target -- the caller (daemon.ts) reads `closed` back and does the
   * actual Playwright page.close()/context.close() work, then calls
   * removeLabel for each closed label itself.
   */
  finish(keep: FinishKeep): FinishReceipt {
    const allLabels = [...this.labels.keys()];
    const retained = keep === "all" ? allLabels : allLabels.filter((l) => keep.includes(l));
    const closed = allLabels.filter((l) => !retained.includes(l));
    return { retained, closed, spaceClosed: retained.length === 0 };
  }
}

export class Registry<TTarget, TContext> {
  private spaces = new Map<number, TaskSpaceRecord<TTarget, TContext>>();
  private nameToId = new Map<string, number>();
  private nextAutoSpaceId = 1;
  // Keyed the same way resolve() itself keys a nameOrId (see lockKey below).
  // Same TOCTOU shape as TaskSpaceRecord.pendingTargets, one level up: two
  // concurrent `taskSpace("same-new-name")` calls (or two concurrent
  // `taskSpace(<same never-seen id>)` calls) would otherwise both see no
  // existing space, both `await makeContext()`, and both write the maps --
  // the loser's context silently orphaned by the winner's overwrite. A
  // second concurrent caller instead awaits the first caller's whole
  // resolve attempt and reuses its result. Cleared once settled.
  private inFlight = new Map<string, Promise<TaskSpaceRecord<TTarget, TContext>>>();

  /**
   * Reuse-or-create a task space.
   *
   * A numeric `nameOrId` (or a numeric-looking string, e.g. "7") is treated
   * as a literal spaceId: if that id already exists it is reused; if not,
   * a NEW space is created using that exact id (not an auto-generated one)
   * -- this is what lets a second, separate process's `taskSpace(<same
   * id>)` resolve to the same space a first process created.
   *
   * A non-numeric string is treated as a name: reused if a space with that
   * name already exists, otherwise created with an internally
   * auto-incremented id.
   */
  // makeContext is only invoked when a space is actually being CREATED
  // (never for a reuse), and may itself be async -- daemon.ts's real
  // factory is `() => browser.newContext()`; tests pass a plain sync
  // function returning a fake object. Either way `resolve` stays
  // deterministic given the same inputs and the same factory result.
  async resolve(
    nameOrId: string | number,
    makeContext: () => TContext | Promise<TContext>,
  ): Promise<TaskSpaceRecord<TTarget, TContext>> {
    const key = this.lockKey(nameOrId);
    const pending = this.inFlight.get(key);
    if (pending) return pending;

    const attempt = this.resolveLocked(nameOrId, makeContext).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, attempt);
    return attempt;
  }

  private lockKey(nameOrId: string | number): string {
    const asNumber = typeof nameOrId === "number" ? nameOrId : Number(nameOrId);
    const isNumeric = Number.isFinite(asNumber) && String(nameOrId).trim() !== "" && !Number.isNaN(asNumber);
    return isNumeric ? `id:${asNumber}` : `name:${String(nameOrId)}`;
  }

  private async resolveLocked(
    nameOrId: string | number,
    makeContext: () => TContext | Promise<TContext>,
  ): Promise<TaskSpaceRecord<TTarget, TContext>> {
    const asNumber = typeof nameOrId === "number" ? nameOrId : Number(nameOrId);
    const isNumeric = Number.isFinite(asNumber) && String(nameOrId).trim() !== "" && !Number.isNaN(asNumber);

    if (isNumeric) {
      const existing = this.spaces.get(asNumber);
      if (existing) return existing;
      const created = new TaskSpaceRecord<TTarget, TContext>(asNumber, String(nameOrId), await makeContext());
      this.spaces.set(asNumber, created);
      this.nextAutoSpaceId = Math.max(this.nextAutoSpaceId, asNumber + 1);
      return created;
    }

    const name = String(nameOrId);
    const existingId = this.nameToId.get(name);
    if (existingId !== undefined) {
      const existing = this.spaces.get(existingId);
      if (existing) return existing;
    }
    const spaceId = this.nextAutoSpaceId;
    this.nextAutoSpaceId += 1;
    const created = new TaskSpaceRecord<TTarget, TContext>(spaceId, name, await makeContext());
    this.spaces.set(spaceId, created);
    this.nameToId.set(name, spaceId);
    return created;
  }

  get(spaceId: number): TaskSpaceRecord<TTarget, TContext> | undefined {
    return this.spaces.get(spaceId);
  }

  list(): TaskSpaceRecord<TTarget, TContext>[] {
    return [...this.spaces.values()];
  }

  remove(spaceId: number): void {
    this.spaces.delete(spaceId);
    for (const [name, id] of this.nameToId) {
      if (id === spaceId) this.nameToId.delete(name);
    }
  }
}
