import type { Container } from "@cloudflare/containers";
import type { TaskStatus } from "../tasks/types";

export interface StartTaskInput {
  taskId: string;
  prompt: string;
  repo: string;
  ref: string;
  ghToken: string;
}

/** The one thing a Worker test cannot execute: a real container. */
export interface AgentRuntime {
  startTask(input: StartTaskInput): Promise<void>;
  status(): Promise<TaskStatus>;
  abort(): Promise<void>;
}

export class FakeRuntime implements AgentRuntime {
  public readonly started: StartTaskInput[] = [];
  public aborted = false;

  constructor(
    private readonly statuses: TaskStatus[],
    private readonly failWith?: Error,
  ) {}

  async startTask(input: StartTaskInput): Promise<void> {
    this.started.push(input);
    if (this.failWith) throw this.failWith;
  }

  async status(): Promise<TaskStatus> {
    if (this.failWith) throw this.failWith;
    const next = this.statuses.shift();
    if (!next) throw new Error("FakeRuntime: no scripted status left");
    return next;
  }

  async abort(): Promise<void> {
    this.aborted = true;
  }
}

/** Talks to the agent container over its internal HTTP port. */
export class ContainerRuntime implements AgentRuntime {
  constructor(
    private readonly container: Container,
    private readonly port: number = 8080,
  ) {}

  private async call(path: string, body?: unknown): Promise<Response> {
    const res = await this.container.containerFetch(
      new Request(`http://container${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      this.port,
    );
    if (!res.ok) {
      throw new Error(`container ${path} returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    return res;
  }

  async startTask(input: StartTaskInput): Promise<void> {
    const res = await this.call("/task", input);
    await res.text(); // drain; see webhook.ts on isolated storage
  }

  async status(): Promise<TaskStatus> {
    const res = await this.container.containerFetch(
      new Request("http://container/status"),
      this.port,
    );
    if (!res.ok) {
      throw new Error(`container /status returned ${res.status}`);
    }
    return (await res.json()) as TaskStatus;
  }

  async abort(): Promise<void> {
    const res = await this.call("/abort");
    await res.text();
  }
}
