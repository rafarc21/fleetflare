// `fleet task new`'s retry, issue #139. Pure — the send and the sleep are
// injected — so test/cli.task-new-retry.test.ts drives it without a network.
//
// Safe to retry a CREATE only because the caller builds the request body once,
// with one idempotency key, and replays it unchanged: the Worker resolves a
// replay of a create that already landed to the existing issue. A 5xx or a
// dropped connection is exactly "may or may not have landed"; a 4xx is the
// request itself being wrong, and repeating it cannot help.

export const TASK_NEW_RETRY_DELAYS_MS = [2_000, 5_000];

export async function sendWithRetry(
  send: () => Promise<Response>,
  delaysMs: number[] = TASK_NEW_RETRY_DELAYS_MS,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const last = attempt >= delaysMs.length;
    try {
      const res = await send();
      if (res.status < 500 || last) return res;
    } catch (err) {
      if (last) throw err;
    }
    await sleep(delaysMs[attempt]);
  }
}

/**
 * The whole of `fleet task new`'s send: the body is serialized ONCE, key
 * inside, and every retry replays that same string. A key minted per attempt
 * — or dropped — would turn the retry itself into the duplicate it exists to
 * prevent.
 */
export async function postTaskNew(
  post: (body: string) => Promise<Response>,
  payload: Record<string, unknown>,
  key: string = crypto.randomUUID(),
  delaysMs: number[] = TASK_NEW_RETRY_DELAYS_MS,
  sleep?: (ms: number) => Promise<void>,
): Promise<Response> {
  const body = JSON.stringify({ ...payload, idempotencyKey: key });
  return sendWithRetry(() => post(body), delaysMs, sleep);
}

/** The stderr line when every attempt failed. A 5xx may still have filed the
 *  task, and a human rerun mints a NEW key — that is how #56 duplicated #57 —
 *  so it says to look first. A 4xx is the request being wrong; nothing filed. */
export function taskNewFailureLine(status: number, text: string, key: string): string {
  const line = `fleet task new: ${status} ${text.slice(0, 500)}`;
  return status < 500 ? line
    : `${line}\nfleet task new: the task may exist anyway (key ${key}) — fleet task ls before rerunning`;
}
