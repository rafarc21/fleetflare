import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleGitProxy, type GitProxyPorts } from "../../src/write-proxy/git-route";
import { writeProxyConfigCmd } from "../../src/write-proxy/container-config";
import { leakGuard } from "../../src/board/leak";
import { hashSpawnToken, mintSpawnToken } from "../../src/studio/org";

/**
 * Issue #7, end to end: REAL `git push` -> pushInsteadOf -> handleGitProxy
 * (Bun.serve) -> REAL `git http-backend` on a bare repo standing in for
 * github.com. Proves the pack git actually sends (no-thin honored, deltas,
 * report-status rendering) and that a refusal leaves the upstream untouched.
 * Fake terms only (acmeclient, 999999999): this file ships in a public repo.
 */

const REPO = "example-org/demo";
let root = "";
let port = 0;
let server: ReturnType<typeof Bun.serve>;
let token = "";
const upstreamPosts: string[] = [];

async function sh(cmd: string[], opts: { cwd?: string; env?: Record<string, string>; stdin?: Uint8Array } = {}) {
  const p = Bun.spawn({
    cmd, cwd: opts.cwd, env: { ...gitEnv(), ...opts.env },
    stdin: opts.stdin ?? "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).arrayBuffer(), new Response(p.stderr).text(), p.exited]);
  return { code, out: new Uint8Array(out), text: new TextDecoder().decode(out), err };
}

function gitEnv(): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: join(root, "home"), GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0", FLEET_SPAWN_TOKEN: token,
    GIT_AUTHOR_NAME: "Dev", GIT_AUTHOR_EMAIL: "dev@example.org", GIT_COMMITTER_NAME: "Dev", GIT_COMMITTER_EMAIL: "dev@example.org",
  };
}

/** github.com, played by git http-backend (CGI) over the bare repos in up/. */
async function httpBackend(url: string, init: RequestInit): Promise<Response> {
  const u = new URL(url);
  const body = init.body ? new Uint8Array(await new Response(init.body).arrayBuffer()) : new Uint8Array(0);
  const h = new Headers(init.headers);
  if (init.method === "POST") upstreamPosts.push(u.pathname);
  const r = await sh([(await sh(["git", "--exec-path"])).text.trim() + "/git-http-backend"], {
    env: {
      GIT_PROJECT_ROOT: join(root, "up"), GIT_HTTP_EXPORT_ALL: "1", REMOTE_USER: "x", REMOTE_ADDR: "127.0.0.1",
      REQUEST_METHOD: init.method ?? "GET", PATH_INFO: u.pathname, QUERY_STRING: u.search.slice(1),
      CONTENT_TYPE: h.get("content-type") ?? "", CONTENT_LENGTH: String(body.length),
      ...(h.get("git-protocol") ? { GIT_PROTOCOL: h.get("git-protocol") as string } : {}),
    },
    stdin: body,
  });
  const split = r.out.findIndex((_, i) => r.out[i] === 13 && r.out[i + 1] === 10 && r.out[i + 2] === 13 && r.out[i + 3] === 10);
  const head = new TextDecoder().decode(r.out.subarray(0, split));
  const headers = new Headers();
  let status = 200;
  for (const line of head.split("\r\n")) {
    const [k, ...v] = line.split(":");
    if (k.toLowerCase() === "status") status = Number(v.join(":").trim().split(" ")[0]);
    else if (k) headers.set(k, v.join(":").trim());
  }
  return new Response(r.out.subarray(split + 4), { status, headers });
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "fleet-wp-e2e-"));
  mkdirSync(join(root, "home"));
  token = mintSpawnToken();
  const hash = await hashSpawnToken(token);
  const bare = join(root, "up", "example-org", "demo.git");
  mkdirSync(bare, { recursive: true });
  await sh(["git", "init", "-q", "--bare", "-b", "main", bare]);
  await sh(["git", "-C", bare, "config", "http.receivepack", "true"]);
  const ports: GitProxyPorts = {
    rows: async () => [{ id: "demo--web-studio", state: "running", tailscaleHost: null, lastRefresh: null, error: null,
      lastRefreshError: null, burn: null, spawnedBy: null, spawnTokenHash: hash, repoSlug: REPO }],
    defaultRepo: "example-org/fleet",
    upstream: (url, init) => httpBackend(url, init),
    check: leakGuard({ isPrivate: async () => false, fetchDenylist: async () => "acmeclient\n9{9}\n" }),
  };
  server = Bun.serve({ port: 0, fetch: (req) => handleGitProxy(req, ports) });
  port = server.port as number;

  const work = join(root, "work");
  await sh(["git", "init", "-q", "-b", "main", work]);
  await sh(["git", "-C", work, "remote", "add", "origin", `https://github.com/${REPO}.git`]);
  const cfg = await sh(["bash", "-c", writeProxyConfigCmd("proxy", `http://127.0.0.1:${port}`, { realGit: "git", marker: join(root, "marker") })]);
  expect(cfg.code).toBe(0);
  writeFileSync(join(work, "big.txt"), Array.from({ length: 400 }, (_, i) => `line ${i} of shared text\n`).join(""));
  await sh(["git", "-C", work, "add", "-A"]);
  await sh(["git", "-C", work, "commit", "-qm", "base"]);
  const seed = await sh(["git", "-C", work, "push", "origin", "HEAD:refs/heads/main"]);
  expect(seed.err).not.toContain("rejected");
  expect(seed.code).toBe(0);
});

afterAll(() => {
  server?.stop(true);
  if (root) rmSync(root, { recursive: true, force: true });
});

const work = () => join(root, "work");
const bareRef = async (ref: string) =>
  (await sh(["git", "-C", join(root, "up", "example-org", "demo.git"), "rev-parse", "--verify", "-q", ref])).text.trim();

describe("write proxy e2e (real git both ends)", () => {
  test("a clean feature push lands upstream", async () => {
    await sh(["git", "-C", work(), "checkout", "-qb", "feat-a"]);
    writeFileSync(join(work(), "big.txt"), Array.from({ length: 400 }, (_, i) => `line ${i} of shared text${i === 7 ? " edited" : ""}\n`).join(""));
    mkdirSync(join(work(), "dir", "sub"), { recursive: true });
    writeFileSync(join(work(), "dir", "sub", "file.txt"), "nested\n");
    await sh(["git", "-C", work(), "add", "-A"]);
    await sh(["git", "-C", work(), "commit", "-qm", "edit a line"]);
    const r = await sh(["git", "-C", work(), "push", "origin", "feat-a"]);
    expect(r.code).toBe(0);
    expect(await bareRef("refs/heads/feat-a")).toBe((await sh(["git", "-C", work(), "rev-parse", "HEAD"])).text.trim());
  });

  test("a denylisted commit message is rejected with the pattern index; upstream untouched", async () => {
    await sh(["git", "-C", work(), "checkout", "-qb", "feat-b"]);
    writeFileSync(join(work(), "b.txt"), "b\n");
    await sh(["git", "-C", work(), "add", "-A"]);
    await sh(["git", "-C", work(), "commit", "-qm", "work for AcmeClient"]);
    const before = upstreamPosts.length;
    const r = await sh(["git", "-C", work(), "push", "origin", "feat-b"]);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("remote rejected");
    expect(r.err).toContain("#1");
    expect(r.err.toLowerCase()).not.toContain("acmeclient");
    expect(await bareRef("refs/heads/feat-b")).toBe("");
    expect(upstreamPosts.slice(before).filter((p) => p.endsWith("git-receive-pack"))).toEqual([]);
  });

  test("a denylisted term in a file body is rejected", async () => {
    await sh(["git", "-C", work(), "checkout", "-q", "feat-a"]);
    await sh(["git", "-C", work(), "checkout", "-qb", "feat-c"]);
    writeFileSync(join(work(), "c.txt"), "id 999999999\n");
    await sh(["git", "-C", work(), "add", "-A"]);
    await sh(["git", "-C", work(), "commit", "-qm", "clean message"]);
    const r = await sh(["git", "-C", work(), "push", "origin", "feat-c"]);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("#2");
    expect(await bareRef("refs/heads/feat-c")).toBe("");
  });

  test("push options are refused by the client itself (capability withdrawn)", async () => {
    const r = await sh(["git", "-C", work(), "push", "-o", "ci.skip", "origin", "feat-a:refs/heads/feat-o"]);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("push options");
    expect(await bareRef("refs/heads/feat-o")).toBe("");
  });

  test("an explicit --thin push still sends a self-contained pack (no-thin honored)", async () => {
    await sh(["git", "-C", work(), "checkout", "-q", "feat-a"]);
    await sh(["git", "-C", work(), "checkout", "-qb", "feat-d"]);
    writeFileSync(join(work(), "big.txt"), Array.from({ length: 400 }, (_, i) => `line ${i} of shared text${i === 300 ? " again" : ""}\n`).join(""));
    await sh(["git", "-C", work(), "commit", "-qam", "edit another line"]);
    const r = await sh(["git", "-C", work(), "push", "--thin", "origin", "feat-d"]);
    expect(r.err).not.toContain("rejected");
    expect(r.code).toBe(0);
    expect(await bareRef("refs/heads/feat-d")).not.toBe("");
  });

  test("a delete lands", async () => {
    const r = await sh(["git", "-C", work(), "push", "origin", ":refs/heads/feat-d"]);
    expect(r.code).toBe(0);
    expect(await bareRef("refs/heads/feat-d")).toBe("");
  });

  test("ls-remote through the proxy (the wrapper's probe path) works", async () => {
    const r = await sh(["git", "ls-remote", "--symref", `http://127.0.0.1:${port}/fleet/git/github.com/${REPO}.git`, "HEAD"]);
    expect(r.code).toBe(0);
    expect(r.text).toContain("ref: refs/heads/main");
  });
});
