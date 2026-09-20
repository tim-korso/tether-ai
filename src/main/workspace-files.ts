import fsp from "node:fs/promises";
import path from "node:path";
import { isSkippedDirName, matchesWorkspaceIgnore } from "./workspace-ignore";

/**
 * 工作区文件树扫描（与 Electron 解耦，便于单测）。
 *
 * 原来的实现有两条会互相放大的问题：
 * 1) 忽略集合里没有 `target` / `resources` 这类构建产物，9 万文件的仓库一个个 readdir；
 * 2) 每次 watcher 事件都整树重扫，且目录数量不设上限。
 * 现在：忽略规则集中、目录数量有上限、缓存与单飞放在调用方（index.ts）。
 */

export const WORKSPACE_DIR_LIMIT = 4_000;
export const WORKSPACE_FILE_LIMIT = 8_000;
export const WORKSPACE_PER_DIR_LIMIT = 200;

export interface WorkspaceScanOptions {
  root: string;
  ignorePatterns?: string[];
  fileLimit?: number;
  perDirLimit?: number;
  dirLimit?: number;
  /** 需要额外补进来的项目技能清单目录（.agents/skills / .pi/skills ...）。 */
  skillRoots?: readonly string[];
  /** 需要额外补进来的固定文件（.agents/features.json ...）。 */
  skillExtras?: readonly string[];
}

/** 目录里带 CACHEDIR.TAG 就是标准缓存目录（rust target 等），一律跳过。 */
export async function isCacheDirectory(dir: string): Promise<boolean> {
  try {
    await fsp.access(path.join(dir, "CACHEDIR.TAG"));
    return true;
  } catch {
    return false;
  }
}

// ponytail: dirs always complete; files capped globally + per folder so DFS doesn't starve later siblings.
export async function listWorkspaceFiles(
  options: WorkspaceScanOptions,
): Promise<string[]> {
  const {
    root,
    ignorePatterns = [],
    fileLimit = WORKSPACE_FILE_LIMIT,
    perDirLimit = WORKSPACE_PER_DIR_LIMIT,
    dirLimit = WORKSPACE_DIR_LIMIT,
  } = options;
  const dirs: string[] = [];
  const files: string[] = [];
  async function walk(dir: string): Promise<void> {
    if (dirs.length >= dirLimit) return;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (dir !== root && (await isCacheDirectory(dir))) return;
    entries.sort(
      (left, right) =>
        Number(right.isDirectory()) - Number(left.isDirectory()) ||
        left.name.localeCompare(right.name),
    );
    let localFiles = 0;
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      const relative = path.relative(root, absolute).replaceAll("\\", "/");
      if (entry.isDirectory()) {
        if (isSkippedDirName(entry.name, false)) continue;
        if (matchesWorkspaceIgnore(relative, ignorePatterns)) continue;
        if (dirs.length >= dirLimit) continue;
        // 标记为缓存的目录（CACHEDIR.TAG）连目录项本身都不列，避免文件面板被构建产物淹没
        if (await isCacheDirectory(absolute)) continue;
        dirs.push(`${relative}/`);
        await walk(absolute);
        continue;
      }
      if (files.length >= fileLimit || localFiles >= perDirLimit) continue;
      if (!entry.isFile() || entry.name.startsWith(".")) continue;
      if (matchesWorkspaceIgnore(relative, ignorePatterns)) continue;
      files.push(relative);
      localFiles += 1;
    }
  }
  await walk(root);
  await addSkillManifests(root, files, options.skillRoots ?? [], options.skillExtras ?? []);
  return dirs.concat(files);
}

export async function addSkillManifests(
  root: string,
  files: string[],
  skillRoots: readonly string[],
  skillExtras: readonly string[],
): Promise<void> {
  const seen = new Set(files);
  for (const rel of skillRoots) {
    let entries;
    try {
      entries = await fsp.readdir(path.join(root, rel), {
        withFileTypes: true,
      });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skill = `${rel}/${entry.name}/SKILL.md`;
      try {
        await fsp.stat(path.join(root, skill));
      } catch {
        continue;
      }
      if (!seen.has(skill)) {
        files.push(skill);
        seen.add(skill);
      }
    }
  }
  for (const extra of skillExtras) {
    try {
      await fsp.stat(path.join(root, extra));
    } catch {
      continue;
    }
    if (!seen.has(extra)) {
      files.push(extra);
      seen.add(extra);
    }
  }
}
