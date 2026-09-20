/**
 * 工作区忽略规则（纯函数，便于单测）。
 *
 * 背景：工作区 watcher 与文件树扫描曾经只跳过少数几个目录，缺 Rust 的 `target`、
 * 各种构建产物与下载缓存（`resources/document-processing-cache`、`*-cache` 等）。
 * 在含 9 万文件、`src-tauri/target` 14GB 的仓库里跑一次 cargo 构建，主进程会持续
 * 190%+ CPU、RSS 涨到 900MB，UI 直接卡死。规则集中在这里，扫描与监听共用同一套判定。
 */

export const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "dist-dev",
  "dist-production",
  "build",
  "out",
  "coverage",
  ".next",
  ".nuxt",
  ".output",
  ".turbo",
  ".vite",
  ".cache",
  ".tether",
  ".build",
  "DerivedData",
  "Pods",
  "__pycache__",
  ".pnpm-store",
  // 构建产物与依赖/下载缓存：编译期会往里写海量文件，逐个通知会拖垮主进程
  "target",
  ".cargo",
  ".venv",
  "venv",
  ".tox",
  ".nox",
  "__pypackages__",
  ".mypy_cache",
  ".ruff_cache",
  ".pytest_cache",
  ".hypothesis",
  ".gradle",
  ".dart_tool",
  ".terraform",
  "CMakeFiles",
  "cmake-build-debug",
  "cmake-build-release",
  "_deps",
  "source-build",
  "document-processing-cache",
]);

/**
 * 目录名是否应被跳过。watch 场景例外放行 `.agents`（推理产物需要被感知），
 * 列表场景保持原有行为（所有点目录都跳过）。
 */
export function isSkippedDirName(name: string, allowAgents: boolean): boolean {
  if (name.startsWith(".") && !(allowAgents && name === ".agents")) return true;
  if (SKIP_DIRS.has(name)) return true;
  // 各种 *-cache 下载目录（nodejs-cache / npm-runtime-cache / cliproxy-cache ...）
  return name.endsWith("-cache");
}

/** `.tetherignore` 文本 → 模式数组（`#` 注释、空行忽略）。 */
export function parseWorkspaceIgnore(raw: string): string[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

/**
 * 模式匹配：`name` 匹配任意层级的同名文件/目录，`a/b` 匹配相对路径本身或其前缀。
 */
export function matchesWorkspaceIgnore(
  relative: string,
  patterns: string[],
): boolean {
  if (patterns.length === 0) return false;
  const segments = relative.split("/");
  return patterns.some((pattern) => {
    const clean = pattern.replace(/^\/+|\/+$/g, "");
    if (!clean) return false;
    if (clean.includes("/")) {
      return relative === clean || relative.startsWith(`${clean}/`);
    }
    return segments.includes(clean);
  });
}

/** watcher 回调入口：路径任一段命中忽略规则即跳过。 */
export function isIgnoredWatchPath(
  filename: string | null,
  patterns: string[],
): boolean {
  if (!filename) return true;
  const normalized = filename.replaceAll("\\", "/");
  const skipped = normalized
    .split("/")
    .filter(Boolean)
    .some((part) => isSkippedDirName(part, true));
  if (skipped) return true;
  return matchesWorkspaceIgnore(normalized, patterns);
}
