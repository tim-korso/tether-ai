import { describe, expect, it } from "vitest";
import { nextConversationGroups, type ConversationGroupCache } from "./conversation";
import { optimisticUserMessage, type ChatMessage } from "./conversation";

function user(id: string, text = id): ChatMessage {
  return optimisticUserMessage(text, false, []);
  // optimisticUserMessage 自带 id，这里用参数覆盖成稳定 id 便于断言
}

function assistant(id: string, text: string, streaming = false): ChatMessage {
  return {
    id,
    role: "assistant",
    text,
    images: [],
    tools: [],
    work: [],
    streaming,
  };
}

function msg(id: string, role: "user" | "assistant", text = id, streaming = false): ChatMessage {
  return role === "user" ? { ...user(id), id, text } : assistant(id, text, streaming);
}

describe("nextConversationGroups", () => {
  it("第一轮：分组并与边界一致", () => {
    const messages = [msg("u1", "user"), msg("a1", "assistant", "hi")];
    const first = nextConversationGroups(messages, undefined);
    expect(first.groups.map((group) => group.type)).toEqual(["user", "assistant"]);
    expect(first.liveStart).toBe(0); // 只有一条 user 消息，前缀为空
  });

  it("流式更新尾部：前缀 group 对象与引用保持复用", () => {
    const u1 = msg("u1", "user");
    const a1 = msg("a1", "assistant", "part");
    const u2 = msg("u2", "user");
    const messages = [u1, a1, u2];

    const first = nextConversationGroups(messages, undefined);
    // 第二轮开始时边界在 u2，前缀 = [u1, a1] → 1 个 user group + 1 个 assistant group
    expect(first.liveStart).toBe(2);

    // 尾部追加流式消息（不动前缀引用）
    const streamed: ChatMessage[] = [u1, a1, u2, msg("a2", "assistant", "stream", true)];
    const second = nextConversationGroups(streamed, first.cache);
    expect(second.groups.slice(0, second.liveStart)).toEqual(first.groups.slice(0, first.liveStart));
    expect(second.groups[0]).toBe(first.groups[0]); // 同一对象，memo 不会失效
    expect(second.groups[1]).toBe(first.groups[1]);
    expect(second.liveStart).toBe(2);
    expect(second.groups.length).toBe(4); // 2 个历史 group + 尾段 [user(u2), assistant(a2)]
  });

  it("同一轮内尾部消息被替换：前缀仍然复用", () => {
    const u1 = msg("u1", "user");
    const u2 = msg("u2", "user");
    const first = nextConversationGroups([u1, u2, msg("a1", "assistant", "a")], undefined);
    const second = nextConversationGroups([u1, u2, msg("a1", "assistant", "a-longer")], first.cache);
    expect(second.groups[0]).toBe(first.groups[0]);
    expect(second.liveStart).toBe(first.liveStart);
  });

  it("新的一轮推进：旧尾并入前缀，只对新增片段分组", () => {
    const u1 = msg("u1", "user");
    const a1 = msg("a1", "assistant", "done");
    const u2 = msg("u2", "user");
    const a2 = msg("a2", "assistant", "done2");
    const u3 = msg("u3", "user");

    const first = nextConversationGroups([u1, a1, u2, a2], undefined);
    const firstPrefix = first.groups.slice(0, first.liveStart);
    const second = nextConversationGroups([u1, a1, u2, a2, u3], first.cache);

    // 前缀变长，但既有前缀对象整段复用
    expect(second.liveStart).toBeGreaterThan(first.liveStart);
    expect(second.groups.slice(0, firstPrefix.length)).toEqual(firstPrefix);
    expect(second.groups[0]).toBe(firstPrefix[0]);
    expect(second.groups.at(-1)?.type).toBe("user");
    expect(second.groups.at(-1)).toMatchObject({ id: "u3" });
  });

  it("信息本身变化（如加载了另一段历史）时不复用旧前缀", () => {
    const u1 = msg("u1", "user");
    const u2 = msg("u2", "user");
    const first = nextConversationGroups([u1, u2], undefined);
    const other = nextConversationGroups([msg("u1", "user"), u2], first.cache);
    expect(other.groups[0]).not.toBe(first.groups[0]);
  });

  it("没有用户消息时 liveStart 为 0", () => {
    const result = nextConversationGroups([msg("a1", "assistant", "x")], undefined);
    expect(result.liveStart).toBe(0);
    expect(result.groups.map((group) => group.type)).toEqual(["assistant"]);
  });

  it("与一次性 groupConversation 的结果保持一致（含跨轮合并语义）", () => {
    const messages = [
      msg("u1", "user"),
      msg("a1", "assistant", "one"),
      msg("a1b", "assistant", "two"),
      msg("u2", "user"),
      msg("a2", "assistant", "three"),
    ];
    let cache: ConversationGroupCache | undefined;
    let incremental = nextConversationGroups(messages, cache);
    cache = incremental.cache;
    incremental = nextConversationGroups(messages, cache);
    const types = incremental.groups.map((group) => group.type);
    expect(types).toEqual(["user", "assistant", "user", "assistant"]);
    expect(
      incremental.groups.filter((group) => group.type === "assistant").flatMap((group) =>
        group.type === "assistant" ? group.messages.map((message) => message.id) : [],
      ),
    ).toEqual(["a1", "a1b", "a2"]);
  });
});
