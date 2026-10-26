// The 50-spec suite. Engine-agnostic: each spec is a named async function
// over the same minimal Page surface, so in-container Chromium (config A) and
// Browser Run (config C) run IDENTICAL work. Specs 1-48 are single-account
// interactions; spec 49 is the 2-account ISOLATION spec (the data-isolation
// risk signal); spec 50 is the multi-page spec (navigates home -> list).
//
// All 50 specs hit real app state (bump/add/fetch/list) — none are pure DOM
// reads — so the suite exercises the app-under-test on every spec, matching a
// real e2e leg, not a hello-world smoke.
import type { SpecPage } from "./harness.ts";

export interface Spec {
  name: string;
  run(page: SpecPage, baseUrl: string): Promise<void>;
}

function acct(n: number): string {
  // Give each of the 48 single-account specs its own account id so they never
  // collide on the shared store when run concurrently. Only spec 49 pairs two
  // accounts on purpose.
  return `a${n}`;
}

function url(base: string, path: string, account?: string): string {
  const u = new URL(base);
  u.pathname = path;
  if (account) u.search = `account=${account}`;
  return u.toString();
}

export const SPECS: Spec[] = [];

// 48 single-account specs: bump counter, add an item, read items, read count.
for (let i = 1; i <= 48; i++) {
  const a = acct(i);
  SPECS.push({
    name: `counter-${String(i).padStart(2, "0")}`,
    async run(page, base) {
      await page.goto(url(base, "/", a));
      await page.click("#bump");
      const count = await page.valueText("#count");
      if (count !== "1") throw new Error(`counter-${i}: expected 1, got ${count}`);
    },
  });
  SPECS.push({
    name: `item-${String(i).padStart(2, "0")}`,
    async run(page, base) {
      await page.goto(url(base, "/", a));
      await page.fill("#name", `item-${i}`);
      await page.click("#add");
      await page.waitForSelector(`#items li`);
      const first = await page.valueText("#items li");
      if (first !== `item-${i}`) throw new Error(`item-${i}: expected item-${i}, got ${first}`);
    },
  });
}
SPECS.length = 48; // keep exactly 48 single-account specs (24 counter + 24 item)

// Spec 49: the 2-account isolation spec. Account iso-w writes, iso-r must not
// see it. These ids are used by NO other spec — specs 1-48 already own a1..a24,
// so a shared id here would collide with item-01/item-02 (item-02 writes a2,
// which would read as "1 item" and fail the isolation assertion).
SPECS.push({
  name: "isolation-2-account",
  async run(page, base) {
    await page.goto(url(base, "/", "iso-w"));
    await page.fill("#name", "secret-iso");
    await page.click("#add");
    await page.waitForSelector("#items li");

    // Same page, switch to account iso-r: must see an EMPTY list. Wait on the
    // always-visible #bump button (the empty <ul> is never "visible", so a
    // waitForSelector on it would time out), then count.
    await page.goto(url(base, "/", "iso-r"));
    await page.waitForSelector("#bump");
    const count = await page.count("#items li");
    if (count !== 0) throw new Error(`isolation: iso-r saw ${count} items from iso-w`);
  },
});

// Spec 50: multi-page — home then navigate to /list and assert list title.
SPECS.push({
  name: "multi-page",
  async run(page, base) {
    await page.goto(url(base, "/", "a50"));
    const title = await page.valueText("title");
    if (title !== "throughput home") throw new Error(`multi-page: home title ${title}`);
    await page.click("#to-list");
    await page.waitForSelector("#list-title");
    const listTitle = await page.valueText("#list-title");
    if (listTitle !== "list page") throw new Error(`multi-page: list title ${listTitle}`);
  },
});

if (SPECS.length !== 50) {
  throw new Error(`specs: expected 50, got ${SPECS.length}`);
}