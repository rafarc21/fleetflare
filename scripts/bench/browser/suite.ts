// The fixed assertion suite both engines run. It is deliberately engine-
// agnostic: it only knows a minimal Page surface (goto / title / locator /
// click / fill / textContent / waitForSelector). Both the in-container
// Chromium driver and the CF Browser Run driver map their real page onto
// this surface, so the measured leg wall is the SAME work on both.
//
// Why this shape: `playwright test` (the runner) is still "not yet fully
// supported" by Browser Run, so a shared minimal surface is the only honest
// way to run the SAME assertions over both engines. The suite mirrors what a
// real gate e2e leg does — load, assert, interact, wait on async — without
// depending on the test runner.

export interface SuitePage {
  goto(url: string): Promise<void>;
  title(): Promise<string>;
  text(selector: string): Promise<string | null>;
  click(selector: string): Promise<void>;
  fill(selector: string, value: string): Promise<void>;
  value(selector: string): Promise<string>;
  waitForSelector(selector: string): Promise<void>;
  count(selector: string): Promise<number>;
  close(): Promise<void>;
}

export interface SuiteResult {
  steps: number;
  ok: boolean;
  error?: string;
}

// One pass through the suite. Throws on the first failed assertion so the
// harness records the flake with its reason; a clean return is one green run.
export async function runSuite(page: SuitePage, baseUrl: string): Promise<SuiteResult> {
  let steps = 0;
  const step = <T>(fn: () => Promise<T>): Promise<T> => {
    steps += 1;
    return fn();
  };

  await step(() => page.goto(baseUrl));
  const title = await step(() => page.title());
  if (title !== "bench fixture") throw new Error(`title: expected "bench fixture", got ${JSON.stringify(title)}`);
  const heading = await step(() => page.text("#title"));
  if (heading !== "fixture ready") throw new Error(`h1: expected "fixture ready", got ${JSON.stringify(heading)}`);
  await step(() => page.click("#inc"));
  const count = await step(() => page.text("#count"));
  if (count !== "1") throw new Error(`count after click: expected "1", got ${JSON.stringify(count)}`);
  await step(() => page.fill("#name", "gate-leg"));
  const name = await step(() => page.value("#name"));
  if (name !== "gate-leg") throw new Error(`input value: expected "gate-leg", got ${JSON.stringify(name)}`);
  await step(() => page.waitForSelector("#items li"));
  const items = await step(() => page.count("#items li"));
  if (items !== 3) throw new Error(`items: expected 3, got ${items}`);

  return { steps, ok: true };
}