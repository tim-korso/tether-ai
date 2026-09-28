import path from "node:path";
import { AgentHost } from "./agent-host";
import type { AgentEvent, AgentSnapshot, AgentStartOptions } from "../shared/types";

export interface AgentHostManagerOptions {
  maxIdleHosts?: number;
  idleTimeoutMs?: number;
}

export interface AgentHostStartResult {
  host: AgentHost;
  snapshot: AgentSnapshot;
  reused: boolean;
}

export class AgentHostManager {
  private hosts = new Map<string, AgentHost>();
  private activeSessionPath?: string;
  /**
   * 单飞：同一会话（或同一 tempId）的并发 start 只允许一个真正 spawn。
   * 没有它时，渲染层两次几乎同时的 `agent:start` 会让两个 rpc-entry 同时
   * 打开同一个 session.jsonl——pi 的 SessionManager 用 `openSync(file,"wx")`
   * 首次落盘、`_rewriteFile` 用 `"w"` 截断重写，两个写者 = EEXIST 抛错 /
   * 互相覆盖 / 追加行交错，用户侧表现为「点了发送没反应，退出重开才行」。
   */
  private starting = new Map<string, Promise<AgentHostStartResult>>();
  /**
   * 正在收尾的 host：`retire()` 会同步登记在这里，正在退出（SIGTERM→2s→SIGKILL）
   * 的进程仍然握着 session 文件。后续 start 必须先等它退干净，否则会起出第二个
   * 共享同一 session.jsonl 的 runtime。键 = 会话路径（含 host 曾用过的别名键）。
   */
  private stopping = new Map<string, Promise<void>>();
  private readonly maxIdleHosts: number;
  private readonly idleTimeoutMs: number;

  constructor(
    private readonly emitEvent: (event: AgentEvent) => void,
    private readonly emitError: (message: string, sessionPath?: string) => void,
    options: AgentHostManagerOptions = {},
  ) {
    this.maxIdleHosts = options.maxIdleHosts ?? 3;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 10 * 60_000;
  }

  getActiveSessionPath(): string | undefined {
    return this.activeSessionPath;
  }

  setActiveSessionPath(sessionPath?: string): void {
    this.activeSessionPath = sessionPath ? path.resolve(sessionPath) : undefined;
  }

  getRunningSessions(): string[] {
    const running = new Set<string>();
    for (const [sessionPath, host] of this.hosts.entries()) {
      if (host.isBusy() && !sessionPath.includes("unknown_")) {
        running.add(sessionPath);
        if (host.sessionPath && !host.sessionPath.includes("unknown_")) {
          running.add(host.sessionPath);
        }
        if (host.tempId) {
          running.add(host.tempId);
        }
      }
    }
    return Array.from(running);
  }

  getHost(sessionPath?: string): AgentHost | undefined {
    if (sessionPath) {
      const direct = this.hosts.get(sessionPath);
      if (direct) return direct;
      const resolved = path.resolve(sessionPath);
      const hostResolved = this.hosts.get(resolved);
      if (hostResolved) return hostResolved;
      const base = path.basename(sessionPath);
      for (const [key, h] of this.hosts.entries()) {
        if (key === sessionPath || path.basename(key) === base || h.tempId === sessionPath) {
          return h;
        }
      }
      return undefined;
    }
    if (this.activeSessionPath) {
      const activeHost = this.hosts.get(this.activeSessionPath);
      if (activeHost) return activeHost;
      // The active path is known but its host is gone (stopped or pruned). Falling back to
      // "whichever host runs first" would route the call into an unrelated conversation.
      return undefined;
    }
    // No active session: a single running host is unambiguous, several would be a guess.
    // One host is often keyed twice (tempId + resolved path), so de-duplicate first.
    const running = [...new Set(this.hosts.values())].filter((host) => host.isRunning());
    return running.length === 1 ? running[0] : undefined;
  }

  async getOrCreateHost(
    options: AgentStartOptions & {
      cwd: string;
      visionExtension?: string;
      visionConfig?: string;
      visionUploads?: string;
    },
  ): Promise<AgentHostStartResult> {
    const requestedSessionPath = options.sessionPath
      ? path.resolve(options.sessionPath)
      : undefined;

    // 单飞键：优先会话路径，其次 tempId，最后 cwd（无 session 的新会话）。
    const startKey =
      requestedSessionPath ?? (options.tempId ? `temp:${options.tempId}` : `cwd:${options.cwd}`);
    const inFlight = this.starting.get(startKey);
    if (inFlight) {
      // 并发的第二个请求等着复用同一次 spawn，绝不自己再起一个 runtime。
      const settled = await inFlight;
      return { host: settled.host, snapshot: settled.snapshot, reused: true };
    }

    const promise = this.createHost(options, requestedSessionPath);
    this.starting.set(startKey, promise);
    try {
      return await promise;
    } finally {
      if (this.starting.get(startKey) === promise) this.starting.delete(startKey);
    }
  }

  private async createHost(
    options: AgentStartOptions & {
      cwd: string;
      visionExtension?: string;
      visionConfig?: string;
      visionUploads?: string;
    },
    requestedSessionPath: string | undefined,
  ): Promise<AgentHostStartResult> {
    // 上一个同会话 host 可能还在 SIGTERM→2s→SIGKILL 的窗口里握着 session 文件，
    // 先等它彻底退出再决定复用/新建，否则会起出第二个写同一份 jsonl 的进程。
    await this.awaitPendingStops(requestedSessionPath, options.tempId);

    // If we already have a running host for this session or tempId, reuse it!
    if (requestedSessionPath) {
      const existing = this.getHost(requestedSessionPath);
      if (existing && existing.isRunning()) {
        this.activeSessionPath = existing.sessionPath ?? requestedSessionPath;
        const snapshot = await existing.snapshot();
        return { host: existing, snapshot, reused: true };
      }
    }
    if (options.tempId) {
      const existingByTemp = this.getHost(options.tempId);
      if (existingByTemp && existingByTemp.isRunning()) {
        this.activeSessionPath = existingByTemp.sessionPath ?? options.tempId;
        const snapshot = await existingByTemp.snapshot();
        return { host: existingByTemp, snapshot, reused: true };
      }
    }

    // Before creating a new host, prune old idle non-active hosts
    this.pruneIdleHosts();

    const host = new AgentHost(
      (event) => {
        this.emitEvent(event);
      },
      (message, sPath) => {
        this.emitError(message, sPath ?? requestedSessionPath ?? this.activeSessionPath);
      },
      requestedSessionPath,
      options.cwd,
    );
    if (options.tempId) {
      host.tempId = options.tempId;
      this.hosts.set(options.tempId, host);
    }

    host.onSessionResolved = (resolved, previous) => {
      if (previous && previous !== host.tempId) {
        this.hosts.delete(previous);
      }
      this.hosts.set(resolved, host);
      this.activeSessionPath = resolved;
    };

    const snapshot = await host.start(options);
    const resolvedSessionPath =
      sessionFileOf(snapshot) ??
      host.sessionPath ??
      requestedSessionPath;

    if (resolvedSessionPath) {
      const canonicalPath = path.resolve(resolvedSessionPath);
      host.sessionPath = canonicalPath;
      this.hosts.set(canonicalPath, host);
      this.activeSessionPath = canonicalPath;
    } else {
      const tempKey = `unknown_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      host.sessionPath = tempKey;
      this.hosts.set(tempKey, host);
      this.activeSessionPath = tempKey;
    }

    return { host, snapshot, reused: false };
  }

  async stop(sessionPath?: string): Promise<void> {
    const host = sessionPath
      ? this.getHost(sessionPath)
      : (this.activeSessionPath ? this.hosts.get(this.activeSessionPath) : undefined);

    if (!host) {
      if (!sessionPath && !this.activeSessionPath) {
        return this.stopAll();
      }
      return;
    }

    await this.retire(host);
  }

  async stopAll(): Promise<void> {
    const allHosts = [...new Set(this.hosts.values())];
    await Promise.allSettled(allHosts.map((h) => this.retire(h)));
  }

  /**
   * 把 host 从路由表里摘掉并停掉它。语义要点：
   *  - 摘除是同步的（`getHost` 立刻看不到它，不会再被路由到）；
   *  - 停止是异步的，但“正在停止”这件事同步登记进 `stopping`，
   *    所以后续同会话的 start 会等待而不是并行 spawn。
   */
  private retire(host: AgentHost): Promise<void> {
    const keys: string[] = [];
    for (const [k, h] of this.hosts.entries()) {
      if (h === host) {
        keys.push(k);
        this.hosts.delete(k);
      }
    }
    if (this.activeSessionPath && !this.hosts.has(this.activeSessionPath)) {
      this.activeSessionPath = undefined;
    }
    const stopKey =
      host.sessionPath && !host.sessionPath.includes("unknown_") ? host.sessionPath : keys[0];
    const stopping = host.stop().catch(() => undefined);
    for (const key of new Set([...keys, ...(stopKey ? [stopKey] : [])])) {
      this.stopping.set(key, stopping);
      void stopping.finally(() => {
        if (this.stopping.get(key) === stopping) this.stopping.delete(key);
      });
    }
    return stopping;
  }

  /** 等待同会话上一轮 stop 落定（最多阻塞到 SIGKILL 兜底那 2s）。 */
  private async awaitPendingStops(
    ...candidates: Array<string | undefined>
  ): Promise<void> {
    const pending: Promise<void>[] = [];
    for (const candidate of candidates) {
      if (!candidate) continue;
      const direct = this.stopping.get(candidate) ?? this.stopping.get(path.resolve(candidate));
      if (direct) pending.push(direct);
    }
    if (pending.length > 0) await Promise.allSettled(pending);
  }

  pruneIdleHosts(): void {
    const now = Date.now();
    const idleCandidates: Array<{ path: string; host: AgentHost }> = [];

    for (const [sKey, host] of this.hosts.entries()) {
      if (sKey === this.activeSessionPath) continue;
      if (!host.isRunning()) {
        this.hosts.delete(sKey);
        continue;
      }
      if (!host.isBusy()) {
        idleCandidates.push({ path: sKey, host });
      }
    }

    // Sort by last active ascending (oldest first)
    idleCandidates.sort((a, b) => a.host.getLastActiveAt() - b.host.getLastActiveAt());

    // 1. Evict expired idle hosts
    const remaining: Array<{ path: string; host: AgentHost }> = [];
    for (const candidate of idleCandidates) {
      if (now - candidate.host.getLastActiveAt() > this.idleTimeoutMs) {
        void this.retire(candidate.host);
      } else {
        remaining.push(candidate);
      }
    }

    // 2. Evict excess idle hosts beyond maxIdleHosts
    while (remaining.length > this.maxIdleHosts) {
      const oldest = remaining.shift();
      if (oldest) {
        void this.retire(oldest.host);
      }
    }
  }
}

export function sessionFileOf(snapshot: AgentSnapshot): string | undefined {
  return (
    sessionFileFromUnknown(snapshot.stats) ??
    sessionFileFromUnknown(snapshot.state)
  );
}

function sessionFileFromUnknown(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || !("sessionFile" in value))
    return undefined;
  return typeof value.sessionFile === "string" ? value.sessionFile : undefined;
}
