import { describe, expect, it } from "vitest";
import {
  pathSetHas,
  promoteQueuedPrompt,
  queuedPromptFrom,
  removeQueuedPrompt,
  restoreQueuedPrompt,
  samePathSet,
  shouldDispatchQueuedMessage,
  shouldReleaseSendLatch,
  staleRunningSessionKeys,
  type QueuedDispatchState,
  type SendLatchState,
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

describe("staleRunningSessionKeys", () => {
  const KEY = "/Users/x/.tether/sessions/stuck.jsonl";
  const OTHER = "/Users/x/.tether/sessions/live.jsonl";

  it("回归：主进程说空闲，但渲染层缓存粘住 running=true → 连续两轮后回落", () => {
    const streaks = new Map<string, number>();
    const cached = [{ key: KEY, running: true }];
    // 第一次：只记一笔（prompt 刚发出、agent 还没起跑的窗口）
    expect(staleRunningSessionKeys(cached, new Set(), streaks)).toEqual([]);
    expect(streaks.get(KEY)).toBe(1);
    // 第二次：确认主进程两轮都空闲 → 回落
    expect(staleRunningSessionKeys(cached, new Set(), streaks)).toEqual([KEY]);
    expect(streaks.has(KEY)).toBe(false);
  });

  it("主进程说在跑（或中途起跑）就不回落，并把计数清零", () => {
    const streaks = new Map<string, number>();
    const cached = [{ key: KEY, running: true }];
    expect(staleRunningSessionKeys(cached, new Set(), streaks)).toEqual([]);
    expect(staleRunningSessionKeys(cached, new Set([OTHER, KEY]), streaks)).toEqual([]);
    expect(streaks.has(KEY)).toBe(false);
    // 计数被清零后需要重新累计两轮
    expect(staleRunningSessionKeys(cached, new Set(), streaks)).toEqual([]);
  });

  it("阈值收紧为 1 时立即回落（真在跑的场景由主进程集合兜底）", () => {
    const streaks = new Map<string, number>();
    expect(staleRunningSessionKeys([{ key: KEY, running: true }], new Set(), streaks, 1)).toEqual([KEY]);
  });

  it("每个会话独立计数：一个真跑、一个粘住", () => {
    const streaks = new Map<string, number>();
    const cached = [
      { key: KEY, running: true },
      { key: OTHER, running: true },
    ];
    expect(staleRunningSessionKeys(cached, new Set([OTHER]), streaks)).toEqual([]);
    expect(streaks.get(KEY)).toBe(1);
    expect(streaks.has(OTHER)).toBe(false);
    expect(staleRunningSessionKeys(cached, new Set([OTHER]), streaks)).toEqual([KEY]);
  });

  it("已回落的会话不留陈旧计数", () => {
    const streaks = new Map<string, number>([["gone.jsonl", 1]]);
    expect(staleRunningSessionKeys([], new Set(), streaks)).toEqual([]);
    expect(streaks.size).toBe(0);
  });
});

describe("send latch release (P0, 2026-10-05)", () => {
  const base: SendLatchState = {
    phase: "prompt",
    elapsedMs: 16_000,
    stallMs: 15_000,
    mainBusy: false,
    landed: false,
  };

  it("prompt 阶段超时且主进程空闲、消息没落地 → 解闩", () => {
    expect(shouldReleaseSendLatch(base)).toBe(true);
  });

  it("冷启动阶段（starting）再久也不解闩：spawn runtime 十几秒是正常耗时", () => {
    expect(shouldReleaseSendLatch({ ...base, phase: "starting", elapsedMs: 120_000 })).toBe(false);
    expect(shouldReleaseSendLatch({ ...base, phase: "idle" })).toBe(false);
  });

  it("主进程还在跑（含长会话的同步压缩）就不解闩", () => {
    expect(shouldReleaseSendLatch({ ...base, mainBusy: true })).toBe(false);
  });

  it("消息已经落地（会话消息数增长）就不解闩，避免同一句话发两遍", () => {
    expect(shouldReleaseSendLatch({ ...base, landed: true })).toBe(false);
  });

  it("没到时限不解闩", () => {
    expect(shouldReleaseSendLatch({ ...base, elapsedMs: 15_000 })).toBe(false);
  });
});
