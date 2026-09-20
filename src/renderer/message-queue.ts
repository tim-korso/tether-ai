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
