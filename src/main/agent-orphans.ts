import { execFileSync } from "node:child_process";

/**
 * 回收上一次进程留下的孤儿 agent runtime。
 *
 * 背景：`AgentHost.start()` 用 `detached: true` 起 rpc-entry（macOS 没有
 * PDEATHSIG，只能靠父进程显式 kill；detached 是为了能按进程组整树回收）。
 * 正常退出走 `before-quit` → `stopAll()`，这条路没问题。但如果 Electron 主进程
 * 是被 **SIGKILL** 掉的（内存压力下 Jetsam 就是这么干的），`before-quit` 根本不会
 * 触发，rpc-entry 被 reparent 到 launchd（ppid=1）并**继续活着**：它攥着
 * session.jsonl、往里面追加、也攥着模型连接。
 *
 * 之后再打开同一个会话时，新起的 rpc-entry 与这个孤儿**同时写同一份 jsonl**
 * （pi 的 SessionManager 用 `openSync(file,"wx")` 首次落盘、`"w"` 截断重写），
 * 结果就是追加行交错 / EEXIST 抛错 / 覆盖写，用户侧表现为
 * 「点了发送发不出去，退出重开才能发」——而退出重开之所以有效，正是因为
 * 这一次 `before-quit` 把新起的那个也杀干净了（孤儿仍在，只是本次没撞上）。
 *
 * 这里只回收**真孤儿**：ppid === 1 且命令行里含本 App 的 rpc-entry 路径。
 * 两条判据缺一不可——ppid 判据保证不会误杀另一个 Tether 实例正在用的 worker
 * （那种 worker 的 ppid 是那个实例的 pid，不是 1），路径判据保证不会碰任何
 * 不是本 App 起的东西。
 */

export interface OrphanAgentProcess {
  pid: number;
  pgid: number;
  sessionPath?: string;
}

export interface OrphanReapReport {
  scanned: number;
  reaped: OrphanAgentProcess[];
  failed: number[];
}

function parsePsLine(line: string): OrphanAgentProcess | undefined {
  // pid ppid pgid command...
  const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
  if (!match) return undefined;
  const pid = Number(match[1]);
  const ppid = Number(match[2]);
  const pgid = Number(match[3]);
  const command = match[4];
  if (!Number.isFinite(pid) || pid <= 0) return undefined;
  // 只认“父进程已经没了”的进程。
  if (ppid !== 1) return undefined;
  const sessionMatch = /--session\s+(\S+)/.exec(command);
  return {
    pid,
    pgid: Number.isFinite(pgid) && pgid > 0 ? pgid : pid,
    sessionPath: sessionMatch?.[1],
  };
}

export function listOrphanAgentProcesses(rpcEntryPath: string): OrphanAgentProcess[] {
  if (process.platform === "win32") return [];
  let out: string;
  try {
    out = execFileSync("ps", ["-Ao", "pid=,ppid=,pgid=,command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    return [];
  }
  const orphans: OrphanAgentProcess[] = [];
  for (const line of out.split("\n")) {
    const parsed = parsePsLine(line);
    if (!parsed) continue;
    // 命令行必须同时含本 App 的 rpc-entry 路径与自己的可执行文件，
    // 否则宁可不动（漏杀一次 < 误杀用户进程）。
    const raw = line;
    if (!raw.includes(rpcEntryPath)) continue;
    if (!raw.includes(process.execPath)) continue;
    if (parsed.pid === process.pid) continue;
    orphans.push(parsed);
  }
  return orphans;
}

function signalTree(pid: number, pgid: number, signal: NodeJS.Signals): boolean {
  let delivered = false;
  // detached 的 worker 自己是进程组组长，杀组能一次带走它 spawn 的子孙
  // （sh -lc、find、rg…）。pgid === pid 时才安全。
  if (pgid === pid) {
    try {
      process.kill(-pgid, signal);
      delivered = true;
    } catch {
      /* 组不存在则退回单进程 */
    }
  }
  try {
    process.kill(pid, signal);
    delivered = true;
  } catch {
    /* already gone */
  }
  return delivered;
}

/**
 * 启动时跑一次：回收上一次会话遗留的孤儿 runtime。
 * 先 SIGTERM，短暂等待后再对仍然活着的补 SIGKILL。
 */
export async function reapOrphanedAgentHosts(
  rpcEntryPath: string,
  options: { signalGraceMs?: number } = {},
): Promise<OrphanReapReport> {
  const orphans = listOrphanAgentProcesses(rpcEntryPath);
  if (orphans.length === 0) return { scanned: 0, reaped: [], failed: [] };

  for (const orphan of orphans) signalTree(orphan.pid, orphan.pgid, "SIGTERM");

  const grace = options.signalGraceMs ?? 1_000;
  await new Promise((resolve) => setTimeout(resolve, grace));

  const failed: number[] = [];
  for (const orphan of orphans) {
    let alive = true;
    try {
      process.kill(orphan.pid, 0);
    } catch {
      alive = false;
    }
    if (!alive) continue;
    signalTree(orphan.pid, orphan.pgid, "SIGKILL");
    try {
      process.kill(orphan.pid, 0);
      failed.push(orphan.pid);
    } catch {
      /* 已死 */
    }
  }

  return { scanned: orphans.length, reaped: orphans, failed };
}
