// Child process for test/bun/reap-lock.test.ts: takes the reap lock on the
// state path in argv[2], prints "held", and holds it until killed.
import { withReapLock } from "../../cli/fleet";

const statePath = process.argv[2];
await withReapLock(statePath, async () => {
  console.log("held");
  await new Promise(() => {});
});
