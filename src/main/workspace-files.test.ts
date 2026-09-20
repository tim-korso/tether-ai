import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listWorkspaceFiles } from "./workspace-files";

let root = "";

async function writeFiles(files: string[]): Promise<void> {
  for (const file of files) {
    const target = path.join(root, file);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, "x");
  }
}

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), "tether-ws-"));
  await writeFiles([
    "src/a.ts",
    "src/nested/b.ts",
    "README.md",
    "node_modules/pkg/index.js",
    "target/CACHEDIR.TAG",
    "target/debug/app",
    "src-tauri/resources/document-processing-cache/onnx/model.onnx",
    "src-tauri/resources/nodejs-cache/node/bin/node",
    "cachedir-by-tag/CACHEDIR.TAG",
    "cachedir-by-tag/big.bin",
    ".git/config",
    "ignored-dir/private.ts",
    ".agents/skills/demo/SKILL.md",
    ".agents/features.json",
  ]);
});

afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

describe("listWorkspaceFiles", () => {
  it("keeps source files and skips build artifacts, caches and dot-directories", async () => {
    const entries = await listWorkspaceFiles({ root });

    expect(entries).toContain("src/a.ts");
    expect(entries).toContain("src/nested/b.ts");
    expect(entries).toContain("README.md");
    expect(entries).toContain("src/");
    expect(entries).toContain("src-tauri/");

    for (const skipped of [
      "node_modules/",
      "target/",
      ".git/",
      "src-tauri/resources/document-processing-cache/",
      "src-tauri/resources/nodejs-cache/",
      "cachedir-by-tag/",
    ]) {
      expect(entries).not.toContain(skipped);
    }
    // 没有规则命中时普通目录照常列出（ignore 规则由 .tetherignore 控制）
    expect(entries).toContain("ignored-dir/");
    expect(entries.some((entry) => entry.startsWith("target/"))).toBe(false);
    expect(
      entries.some((entry) => entry.includes("document-processing-cache")),
    ).toBe(false);
    expect(entries.some((entry) => entry.includes("nodejs-cache"))).toBe(false);
    // CACHEDIR.TAG 标记的目录即使名字不匹配也要跳过
    expect(entries.some((entry) => entry.startsWith("cachedir-by-tag"))).toBe(false);
  });

  it("honours extra ignore patterns (e.g. .tetherignore)", async () => {
    const entries = await listWorkspaceFiles({
      root,
      ignorePatterns: ["ignored-dir", "src-tauri/resources"],
    });
    expect(entries.some((entry) => entry.startsWith("ignored-dir"))).toBe(false);
    expect(entries.some((entry) => entry.startsWith("src-tauri/resources"))).toBe(false);
  });

  it("appends skill manifests that the plain walk would skip", async () => {
    const entries = await listWorkspaceFiles({
      root,
      skillRoots: [".agents/skills"],
      skillExtras: [".agents/features.json"],
    });
    expect(entries).toContain(".agents/skills/demo/SKILL.md");
    expect(entries).toContain(".agents/features.json");
  });

  it("caps the number of files and directories", async () => {
    await writeFiles(["many/f1.txt", "many/f2.txt", "many/f3.txt"]);
    const capped = await listWorkspaceFiles({ root, fileLimit: 2 });
    expect(capped.filter((entry) => !entry.endsWith("/")).length).toBeLessThanOrEqual(2);

    const limitedDirs = await listWorkspaceFiles({ root, dirLimit: 1 });
    expect(limitedDirs.filter((entry) => entry.endsWith("/")).length).toBe(1);
  });
});
