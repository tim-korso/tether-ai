import { describe, expect, it } from "vitest";
import {
  isIgnoredWatchPath,
  isSkippedDirName,
  matchesWorkspaceIgnore,
  parseWorkspaceIgnore,
} from "./workspace-ignore";

describe("isSkippedDirName", () => {
  it("skips dependency and build artifact directories", () => {
    expect(isSkippedDirName("node_modules", false)).toBe(true);
    // Rust 构建产物：缺失这一条时，cargo 构建期间主进程会被事件风暴打满
    expect(isSkippedDirName("target", false)).toBe(true);
    expect(isSkippedDirName("source-build", false)).toBe(true);
    expect(isSkippedDirName("document-processing-cache", false)).toBe(true);
    // 通用 *-cache 下载目录（nodejs-cache / npm-runtime-cache ...）
    expect(isSkippedDirName("nodejs-cache", false)).toBe(true);
    expect(isSkippedDirName("nested", false)).toBe(false);
    expect(isSkippedDirName("src", false)).toBe(false);
  });

  it("keeps dot-directories hidden except .agents while watching", () => {
    expect(isSkippedDirName(".git", false)).toBe(true);
    expect(isSkippedDirName(".agents", false)).toBe(true);
    expect(isSkippedDirName(".agents", true)).toBe(false);
    expect(isSkippedDirName("src", true)).toBe(false);
  });
});

describe("parseWorkspaceIgnore", () => {
  it("drops comments and blank lines", () => {
    expect(
      parseWorkspaceIgnore("# 注释\n\nnode_modules\nsrc-tauri/resources\n"),
    ).toEqual(["node_modules", "src-tauri/resources"]);
  });
});

describe("matchesWorkspaceIgnore", () => {
  it("matches bare names at any depth", () => {
    expect(matchesWorkspaceIgnore("a/b/fixtures", ["fixtures"])).toBe(true);
    expect(matchesWorkspaceIgnore("fixtures", ["fixtures"])).toBe(true);
    expect(matchesWorkspaceIgnore("a/fixture", ["fixtures"])).toBe(false);
  });

  it("matches relative prefixes", () => {
    const patterns = ["src-tauri/resources"];
    expect(matchesWorkspaceIgnore("src-tauri/resources", patterns)).toBe(true);
    expect(
      matchesWorkspaceIgnore("src-tauri/resources/nodejs/bin/node", patterns),
    ).toBe(true);
    expect(
      matchesWorkspaceIgnore("src-tauri/resources-other/x", patterns),
    ).toBe(false);
  });

  it("ignores trailing slashes and keeps empty patterns inert", () => {
    expect(matchesWorkspaceIgnore("vendor/pkg", ["vendor/"])).toBe(true);
    expect(matchesWorkspaceIgnore("vendor/pkg", ["", "/", "//"])).toBe(false);
  });
});

describe("isIgnoredWatchPath", () => {
  it("skips anything under an ignored segment", () => {
    const big = "src-tauri/target/debug/deps/libfoo.rlib";
    expect(isIgnoredWatchPath(big, [])).toBe(true);
    expect(
      isIgnoredWatchPath(
        "src-tauri/resources/document-processing-cache/source-build/x/y",
        [],
      ),
    ).toBe(true);
    expect(isIgnoredWatchPath("src-tauri/resources/nodejs-cache/a", [])).toBe(true);
  });

  it("keeps ordinary source edits", () => {
    expect(isIgnoredWatchPath("src/main/index.ts", [])).toBe(false);
    expect(isIgnoredWatchPath("src-tauri/src/lib.rs", [])).toBe(false);
  });

  it("honours .tetherignore patterns and normalizes separators", () => {
    const patterns = parseWorkspaceIgnore("src-tauri/resources\nfixtures");
    expect(
      isIgnoredWatchPath("src-tauri\\resources\\server-dist.js", patterns),
    ).toBe(true);
    expect(isIgnoredWatchPath("a/b/fixtures/data.json", patterns)).toBe(true);
    expect(isIgnoredWatchPath("src-tauri/src/lib.rs", patterns)).toBe(false);
  });

  it("treats a missing filename as ignored", () => {
    expect(isIgnoredWatchPath(null, [])).toBe(true);
  });
});
