/**
 * 渲染进程崩溃自愈预算（纯函数，便于单测）。
 *
 * 之前主进程完全没有 `render-process-gone` / `unresponsive` 处理：渲染进程一死，
 * 窗口只剩空白页，必须人工重载（本项目第一次救援就是用 kill -9 + 菜单 Reload 做的）。
 * 这里给出「滑动窗口 + 最大次数」的自愈预算，超限后降级为错误页，避免无限重载循环。
 * 该模式与 Proma 的 renderer-process-recovery 一致（30s 窗口内最多 2 次）。
 */

export const RENDERER_RECOVERY_WINDOW_MS = 30_000;
export const MAX_RENDERER_RECOVERY_ATTEMPTS = 2;

/** 只保留窗口内的尝试记录。 */
export function recentRecoveryAttempts(
  attempts: number[],
  now: number,
): number[] {
  return attempts.filter(
    (attemptAt) => now - attemptAt < RENDERER_RECOVERY_WINDOW_MS,
  );
}

export function canRecoverRenderer(attempts: number[], now: number): boolean {
  return recentRecoveryAttempts(attempts, now).length < MAX_RENDERER_RECOVERY_ATTEMPTS;
}
