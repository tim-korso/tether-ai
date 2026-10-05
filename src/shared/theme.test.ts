import { describe, expect, it } from "vitest";
import {
  DEFAULT_THEME,
  GLASS_THEMES,
  THEMES,
  isGlassTheme,
  isDarkTheme,
  parseTheme,
  vibrancyForTheme,
} from "./theme";

describe("parseTheme", () => {
  it("accepts every declared theme", () => {
    for (const id of THEMES) expect(parseTheme(id)).toBe(id);
  });

  it("falls back to the default theme", () => {
    expect(parseTheme(null)).toBe(DEFAULT_THEME);
    expect(parseTheme("solarized")).toBe(DEFAULT_THEME);
  });
});

describe("glass family", () => {
  it("covers the four hues and nothing else", () => {
    expect([...GLASS_THEMES]).toEqual([
      "glass",
      "glass-red",
      "glass-amber",
      "glass-cosmos",
    ]);
    for (const id of GLASS_THEMES) expect(isGlassTheme(id)).toBe(true);
    expect(isGlassTheme("dark")).toBe(false);
    expect(isGlassTheme("paper")).toBe(false);
  });

  it("only paints light-on-dark for dark and cosmos", () => {
    expect(isDarkTheme("dark")).toBe(true);
    expect(isDarkTheme("glass-cosmos")).toBe(true);
    for (const id of ["white", "paper", "glass", "glass-red", "glass-amber"] as const) {
      expect(isDarkTheme(id)).toBe(false);
    }
  });

  it("pairs the native material with the palette", () => {
    expect(vibrancyForTheme("glass-cosmos")).toBe("hud");
    expect(vibrancyForTheme("dark")).toBe("hud");
    expect(vibrancyForTheme("glass")).toBe("under-window");
    expect(vibrancyForTheme("glass-red")).toBe("under-window");
    expect(vibrancyForTheme("glass-amber")).toBe("under-window");
  });
});
