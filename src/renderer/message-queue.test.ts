import { describe, expect, it } from "vitest";
import {
  pathSetHas,
  promoteQueuedPrompt,
  queuedPromptFrom,
  removeQueuedPrompt,
  restoreQueuedPrompt,
  samePathSet,
  shouldDispatchQueuedMessage,
  type QueuedDispatchState,
} from "./message-queue";

const IDLE: QueuedDispatchState = {
  hasPending: true,
  running: false,
  targetRunning: false,
  loading: false,
  sending: false,
  dispatching: false,
  held: false,
  missingTarget: false,
};

describe("shouldDispatchQueuedMessage", () => {
  it("派发：空闲且队列有消息", () => {
    expect(shouldDispatchQueuedMessage(IDLE)).toBe(true);
  });

  it("不派发：没有待发消息或没有目标会话", () => {
    expect(shouldDispatchQueuedMessage({ ...IDLE, hasPending: false })).toBe(false);
    expect(shouldDispatchQueuedMessage({ ...IDLE, missingTarget: true })).toBe(false);
  });

  it("不派发：本轮还在跑（渲染层或主进程任一为真）", () => {
    expect(shouldDispatchQueuedMessage({ ...IDLE, running: true })).toBe(false);
    expect(shouldDispatchQueuedMessage({ ...IDLE, targetRunning: true })).toBe(false);
  });

  it("不派发：加载历史 / prompt 投递中 / 已有派发在途", () => {
    expect(shouldDispatchQueuedMessage({ ...IDLE, loading: true })).toBe(false);
    expect(shouldDispatchQueuedMessage({ ...IDLE, sending: true })).toBe(false);
    expect(shouldDispatchQueuedMessage({ ...IDLE, dispatching: true })).toBe(false);
  });

  // 回归：用户报的「消息一直在队列，没机会发出」
  it("回归：暂停期间不派发，解除暂停（正常结束/显式继续）后立刻恢复派发", () => {
    const held = { ...IDLE, held: true };
    expect(shouldDispatchQueuedMessage(held)).toBe(false);
    // agent_settled / agent_start / 「立即插话发送」都会把 held 置回 false
    expect(shouldDispatchQueuedMessage({ ...held, held: false })).toBe(true);
  });

  it("回归：守卫条件同时为真时（旧实现的黑洞）不会误派发，但条件解除后仍能派发", () => {
    const stuckWindow = { ...IDLE, loading: true, sending: true };
    expect(shouldDispatchQueuedMessage(stuckWindow)).toBe(false);
    expect(
      shouldDispatchQueuedMessage({ ...stuckWindow, loading: false, sending: false }),
    ).toBe(true);
  });
});

describe("queue operations", () => {
  const a = queuedPromptFrom("A");
  const b = queuedPromptFrom("B");

  it("remove 按 id 移除", () => {
    expect(removeQueuedPrompt([a, b], a.id)).toEqual([b]);
    expect(removeQueuedPrompt([a, b], "missing")).toEqual([a, b]);
  });

  it("restore 归还到队首且按 id 去重", () => {
    const restored = restoreQueuedPrompt([b], a);
    expect(restored.map((item) => item.id)).toEqual([a.id, b.id]);
    expect(restoreQueuedPrompt(restored, a).map((item) => item.id)).toEqual([a.id, b.id]);
  });

  it("promote 把指定条目提到队首且不重排其他项", () => {
    const c = queuedPromptFrom("C");
    expect(promoteQueuedPrompt([a, b, c], b.id).map((item) => item.text)).toEqual([
      "B",
      "A",
      "C",
    ]);
    expect(promoteQueuedPrompt([a, b], "missing").map((item) => item.text)).toEqual([
      "A",
      "B",
    ]);
  });

  it("每条排队消息都有稳定 id", () => {
    expect(a.id).toBeTruthy();
    expect(a.id).not.toBe(b.id);
  });
});

describe("path set helpers", () => {
  it("按路径比较，大小写与分隔符归一", () => {
    const live = new Set(["/Users/x/.tether/sessions/a.jsonl"]);
    expect(pathSetHas(live, "/users/x/.tether/sessions/a.jsonl")).toBe(true);
    expect(pathSetHas(live, "/Users/x/.tether/sessions/b.jsonl")).toBe(false);
  });

  it("samePathSet 忽略顺序，比较成员", () => {
    const left = new Set(["/a/one.jsonl", "/a/two.jsonl"]);
    const same = new Set(["/a/two.jsonl", "/a/one.jsonl"]);
    const other = new Set(["/a/one.jsonl"]);
    expect(samePathSet(left, same)).toBe(true);
    expect(samePathSet(left, other)).toBe(false);
  });

  it("temp id 与真实路径不会被当作同一个会话", () => {
    const live = new Set(["/Users/x/.tether/sessions/real.jsonl"]);
    expect(pathSetHas(live, "temp_1712345678")).toBe(false);
  });
});
