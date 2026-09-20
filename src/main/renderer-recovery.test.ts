import { describe, expect, it } from "vitest";
import {
  MAX_RENDERER_RECOVERY_ATTEMPTS,
  RENDERER_RECOVERY_WINDOW_MS,
  canRecoverRenderer,
  recentRecoveryAttempts,
} from "./renderer-recovery";

describe("canRecoverRenderer", () => {
  const now = 1_000_000;

  it("allows recovering when there is no recent attempt", () => {
    expect(canRecoverRenderer([], now)).toBe(true);
  });

  it("allows up to the attempt budget inside the window", () => {
    const attempts = [now - 1_000];
    expect(attempts.length).toBeLessThan(MAX_RENDERER_RECOVERY_ATTEMPTS);
    expect(canRecoverRenderer(attempts, now)).toBe(true);
  });

  it("stops recovering once the budget is spent", () => {
    const attempts = [now - 5_000, now - 1_000];
    expect(canRecoverRenderer(attempts, now)).toBe(false);
  });

  it("forgets attempts that fell out of the window", () => {
    const attempts = [now - RENDERER_RECOVERY_WINDOW_MS - 1, now - RENDERER_RECOVERY_WINDOW_MS * 3];
    expect(canRecoverRenderer(attempts, now)).toBe(true);
  });
});

describe("recentRecoveryAttempts", () => {
  it("keeps only in-window attempts in order", () => {
    const now = 100_000;
    expect(
      recentRecoveryAttempts([1_000, now - 100, now - 40_000], now),
    ).toEqual([now - 100]);
  });
});
