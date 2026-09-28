import { describe, expect, test } from "bun:test";
import { buildGlobals, TaskSpace } from "../../container/ego-browser/api";

// These methods are real, callable globals/methods that must throw the
// instant they're invoked -- never a silent no-op, and never a bare
// ReferenceError (which an agent could misread as "typo in my script" and
// retry blindly instead of understanding it's unsupported). A fake `call`
// is enough here: none of these stubs are expected to ever reach the RPC
// layer at all.
const neverCalled = () => {
  throw new Error("RPC call should never be reached by an unimplemented stub");
};

describe("entry-point loud-fail stubs", () => {
  const globals = buildGlobals(neverCalled);

  test("profiles() throws synchronously, naming itself", () => {
    expect(() => globals.profiles()).toThrow(/profiles\(\)/);
  });

  test("claimTaskSpace() throws synchronously, naming itself", () => {
    expect(() => globals.claimTaskSpace()).toThrow(/claimTaskSpace\(\)/);
  });

  test("takeOverTaskSpace() throws synchronously, naming itself", () => {
    expect(() => globals.takeOverTaskSpace()).toThrow(/takeOverTaskSpace\(\)/);
  });
});

describe("TaskSpace loud-fail stubs", () => {
  const task = new TaskSpace(1, "test", neverCalled);

  test("task.userPage() throws synchronously, naming itself", () => {
    expect(() => task.userPage()).toThrow(/task\.userPage\(\)/);
  });

  test("task.handOff() throws synchronously, naming itself", () => {
    expect(() => task.handOff()).toThrow(/task\.handOff\(\)/);
  });

  test("task.waitForControl() throws synchronously, naming itself", () => {
    expect(() => task.waitForControl()).toThrow(/task\.waitForControl\(\)/);
  });

  test("task.adopt() throws synchronously, naming itself", () => {
    expect(() => task.adopt()).toThrow(/task\.adopt\(\)/);
  });

  test("task.release() throws synchronously, naming itself", () => {
    expect(() => task.release()).toThrow(/task\.release\(\)/);
  });
});
