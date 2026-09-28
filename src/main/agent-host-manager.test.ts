import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * P2 回归：这一组测试锁死三件“会话写坏”的成因——
 *  1. 并发 start 只 spawn 一个 runtime（单飞）；
 *  2. stop 之后、旧进程还没退干净之前，新的 start 必须等它（否则两个写者写同一份 jsonl）；
 *  3. pruneIdleHosts 摘除是同步的（摘掉后 getHost 立刻看不到），停止是异步的。
 */
const fake = vi.hoisted(() => {
  interface FakeInstance {
    sessionPath?: string;
    tempId?: string;
    running: boolean;
    busy: boolean;
    lastActiveAt: number;
    stopCalls: number;
    stopResolvers: Array<() => void>;
    resolveStop(): void;
  }

  const created: FakeInstance[] = [];

  class FakeAgentHost implements FakeInstance {
    sessionPath?: string;
    tempId?: string;
    running = true;
    busy = false;
    lastActiveAt = Date.now();
    stopCalls = 0;
    stopResolvers: Array<() => void> = [];
    onSessionResolved?: (resolved: string, previous?: string) => void;

    constructor(
      _emit: unknown,
      _err: unknown,
      sessionPath?: string,
      public cwd?: string,
    ) {
      this.sessionPath = sessionPath;
      created.push(this);
    }

    isRunning(): boolean {
      return this.running;
    }
    isBusy(): boolean {
      return this.running && this.busy;
    }
    getLastActiveAt(): number {
      return this.lastActiveAt;
    }

    async start(): Promise<Record<string, unknown>> {
      return { sessionFile: this.sessionPath };
    }
    async snapshot(): Promise<Record<string, unknown>> {
      return { stats: { sessionFile: this.sessionPath } };
    }
    /** 直到测试显式 resolveStop() 之前，stop() 一直挂着——模拟 SIGTERM→2s→SIGKILL 窗口。 */
    stop(): Promise<void> {
      this.stopCalls += 1;
      this.running = false;
      return new Promise<void>((resolve) => {
        this.stopResolvers.push(() => {
          this.running = false;
          resolve();
        });
      });
    }
    resolveStop(): void {
      const pending = this.stopResolvers.splice(0, this.stopResolvers.length);
      for (const resolve of pending) resolve();
    }
  }

  return { FakeAgentHost, created };
});

vi.mock("./agent-host", () => ({ AgentHost: fake.FakeAgentHost }));

import { AgentHostManager } from "./agent-host-manager";

function makeManager(): AgentHostManager {
  return new AgentHostManager(() => undefined, () => undefined);
}

const SESSION = "/tmp/tether-test/session.jsonl";

beforeEach(() => {
  fake.created.length = 0;
});

describe("AgentHostManager", () => {
  it("并发 start 同一个会话只 spawn 一个 runtime", async () => {
    const manager = makeManager();
    const [a, b, c] = await Promise.all([
      manager.getOrCreateHost({ cwd: "/tmp/tether-test", sessionPath: SESSION } as never),
      manager.getOrCreateHost({ cwd: "/tmp/tether-test", sessionPath: SESSION } as never),
      manager.getOrCreateHost({ cwd: "/tmp/tether-test", sessionPath: SESSION } as never),
    ]);
    expect(fake.created).toHaveLength(1);
    expect(a.host).toBe(b.host);
    expect(b.host).toBe(c.host);
    // 第一个是真正 spawn 的那个，其余复用。
    expect([a.reused, b.reused, c.reused].filter((r) => r === false)).toHaveLength(1);
  });

  it("stop 未落定之前，重开同一会话不会并行 spawn 第二个 runtime", async () => {
    const manager = makeManager();
    await manager.getOrCreateHost({ cwd: "/tmp/tether-test", sessionPath: SESSION } as never);
    const firstHost = fake.created[0]!;

    const stopping = manager.stop(SESSION);
    // 旧进程仍在退出窗口里：此刻 getHost 已经看不到它（同步摘除），但 start 不能直接新建。
    expect(manager.getHost(SESSION)).toBeUndefined();

    const restart = manager.getOrCreateHost({ cwd: "/tmp/tether-test", sessionPath: SESSION } as never);
    await new Promise((r) => setTimeout(r, 20));
    expect(fake.created).toHaveLength(1); // 仍在等旧进程退出

    firstHost.resolveStop();
    await stopping;
    const { host } = await restart;
    expect(fake.created).toHaveLength(2); // 退出后才新建
    expect(host).toBe(fake.created[1]);
  });

  it("pruneIdleHosts 同步摘除、异步停止", async () => {
    const manager = makeManager();
    await manager.getOrCreateHost({ cwd: "/tmp/tether-test", sessionPath: SESSION } as never);
    const host = fake.created[0]!;
    host.lastActiveAt = Date.now() - 60 * 60_000; // 远远超过 idleTimeoutMs

    manager.setActiveSessionPath("/tmp/tether-test/other.jsonl");
    manager.pruneIdleHosts();

    expect(manager.getHost(SESSION)).toBeUndefined();
    expect(host.stopCalls).toBe(1);
    // 停止是异步的：promise 还没落定，但路由表已经摘干净了。
    host.resolveStop();
  });

  it("stop 落定后再 start 不再阻塞", async () => {
    const manager = makeManager();
    await manager.getOrCreateHost({ cwd: "/tmp/tether-test", sessionPath: SESSION } as never);
    const firstHost = fake.created[0]!;
    const stopping = manager.stop(SESSION);
    firstHost.resolveStop();
    await stopping;

    const { host, reused } = await manager.getOrCreateHost({
      cwd: "/tmp/tether-test",
      sessionPath: SESSION,
    } as never);
    expect(reused).toBe(false);
    expect(host).toBe(fake.created[1]);
  });
});
