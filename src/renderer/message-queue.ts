import { isSamePath } from "./conversation";

/**
 * 对话队列（运行中提交）的纯逻辑：决策与队列操作集中在这里，便于单测。
 *
 * 背景：原实现的自动派发是一个只依赖 `[loading, running, sendMessage]` 的 effect + 纯 ref 守卫。
 * 一旦守卫在那一刻为真（刚中断过、状态未同步、加载中）就再也没人叫醒它，消息就永久躺在队列里；
 * 而 `queueHeld`（停止/出错后的暂停）还会被写进会话缓存并在切回来时恢复，变成“永远排不出去”。
 * Proma 的做法是：一个幂等的 `tryDispatch(sessionId)`，挂在明确事件上（run 结束 / 后台任务结束 /
 * 目标可用 / 新消息入队），并且派发失败会把条目归还队首、释放占坑。
 * 这里是同一形状的渲染层版本。
 */

export interface QueuedPrompt {
  /** 稳定 id：对齐 Proma 的 queueMessageId，用于「立即发送」仲裁与队列对账去重。 */
  id: string;
  text: string;
  images?: string[];
}

export function newQueuedPromptId(): string {
  return `q_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

export function queuedPromptFrom(text: string, images?: string[]): QueuedPrompt {
  return { id: newQueuedPromptId(), text, images };
}

/** 主进程运行态快照与渲染层集合是否一致（按路径比较，兼容 temp id 与真实路径）。 */
export function samePathSet(left: Set<string>, right: Set<string>): boolean {
  if (left.size !== right.size) return false;
  for (const item of left) {
    if (!pathSetHas(right, item)) return false;
  }
  return true;
}

export function pathSetHas(set: Set<string>, target: string): boolean {
  for (const item of set) {
    if (isSamePath(item, target)) return true;
  }
  return false;
}

/**
 * 运行态对账（看门狗的核心判定，抽出来便于单测）。
 *
 * 主进程的 `agent:running-sessions` 是运行态唯一权威；渲染层每个会话缓存里的 `running`
 * 只靠 `agent_settled` 事件回落，事件一旦丢失（子进程半死、IPC 丢包、跨会话切换）就会永久粘在
 * `true`：切回该会话永远是「Waiting for model」、新消息被塞进本地队列发不出去、只能重启。
 *
 * 这里对每个缓存会话独立对账，必须连续 `threshold` 轮主进程报告空闲才回落 ——
 * 阈值是为了避开「prompt 刚发出、agent 还没起跑」的窗口（那几轮主进程也报空闲）。
 * 返回本轮应当回落为 idle 的 key，并把命中计数写回 `streaks`。
 */
export function staleRunningSessionKeys(
  cached: Iterable<{ key: string; running: boolean }>,
  live: Set<string>,
  streaks: Map<string, number>,
  threshold = 2,
): string[] {
  const stale: string[] = [];
  const touched = new Set<string>();
  for (const { key, running } of cached) {
    if (!running || pathSetHas(live, key)) {
      streaks.delete(key);
      continue;
    }
    touched.add(key);
    const next = (streaks.get(key) ?? 0) + 1;
    if (next < threshold) {
      streaks.set(key, next);
      continue;
    }
    streaks.delete(key);
    stale.push(key);
  }
  // 缓存里已经不在（或已回落）的会话不要留下陈旧计数
  for (const key of [...streaks.keys()]) {
    if (!touched.has(key)) streaks.delete(key);
  }
  return stale;
}

export interface QueuedDispatchState {
  /** 队列里是否还有待发消息。 */
  hasPending: boolean;
  /** 渲染层的运行标志（当前会话）。 */
  running: boolean;
  /** 主进程说这个会话还在跑（权威运行态）。 */
  targetRunning: boolean;
  /** 正在加载历史。 */
  loading: boolean;
  /** 当前 turn 的 prompt 正在投递。 */
  sending: boolean;
  /** 已有派发在途（对标 Proma 的 dispatching 占坑）。 */
  dispatching: boolean;
  /** 中断/出错后的暂停。 */
  held: boolean;
  /** 没有可发送的目标会话。 */
  missingTarget: boolean;
}

/** 单一判定入口：所有调用点都问它，避免各处条件不一致。 */
export function shouldDispatchQueuedMessage(state: QueuedDispatchState): boolean {
  if (!state.hasPending) return false;
  if (state.dispatching || state.sending || state.loading) return false;
  if (state.held) return false;
  if (state.missingTarget) return false;
  // 权威运行态优先：主进程还在跑就不抢
  return !state.running && !state.targetRunning;
}

export function removeQueuedPrompt(
  queue: QueuedPrompt[],
  id: string,
): QueuedPrompt[] {
  return queue.filter((item) => item.id !== id);
}

/**
 * 一次发送的三个阶段。冷启动（spawn runtime + 等模型就绪）可能十几秒，它是正常耗时，
 * 不能和「prompt 发出后主进程没反应」用同一个时限。
 */
export type SendPhase = "idle" | "starting" | "prompt";

export interface SendLatchState {
  phase: SendPhase;
  /** 进入 prompt 阶段后经过的时间。 */
  elapsedMs: number;
  /** 超过这个时限才允许把卡住的发送判死。 */
  stallMs: number;
  /** 主进程权威运行态：这个会话还在跑（含同步压缩）就必须继续等。 */
  mainBusy: boolean;
  /** 本次发送之后会话消息数是否已经增长（增长 = prompt 已经落地，绝不能回收草稿）。 */
  landed: boolean;
}

/**
 * 发送门闩的解除判定（纯函数，便于单测）。
 *
 * 2026-10-05 P0：旧实现用「点击发送的时刻 + 15s」判卡死，有两个假阳性，两次都会
 * 把一条已经在飞的发送当成死掉 → 输入框被回填、乐观消息被删 → 用户重发 = 同一句话发两遍：
 *   1. 冷启动：spawn runtime 十几秒，任务其实在正常启动；
 *   2. 长会话：prompt 的 preflight 里同步跑 _checkCompaction，几十秒内主进程 busy=true
 *      而子进程 isStreaming=false，看着像没动静，其实在压缩。
 *
 * 所以只有三条同时成立才解闩：已经进入 prompt 阶段、超时、主进程权威空闲且消息没落地。
 * 解闩是破坏性的（回填输入框 + 删乐观消息），宁可多等一轮也不能误伤在飞的发送。
 */
export function shouldReleaseSendLatch(state: SendLatchState): boolean {
  if (state.phase !== "prompt") return false;
  if (state.mainBusy || state.landed) return false;
  return state.elapsedMs > state.stallMs;
}

/** 派发失败时归还队首；按 id 去重，避免与「入队分支」重复插入同一条。 */
export function restoreQueuedPrompt(
  queue: QueuedPrompt[],
  prompt: QueuedPrompt,
): QueuedPrompt[] {
  if (queue.some((item) => item.id === prompt.id)) return queue;
  return [prompt, ...queue];
}

/** 「立即发送」：把指定条目提到队首，其余保持不变（顺序稳定，不重排其他项）。 */
export function promoteQueuedPrompt(
  queue: QueuedPrompt[],
  id: string,
): QueuedPrompt[] {
  const item = queue.find((entry) => entry.id === id);
  if (!item) return queue;
  return [item, ...queue.filter((entry) => entry.id !== id)];
}
