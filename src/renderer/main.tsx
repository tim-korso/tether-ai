import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { applyTheme, readStoredTheme, vibrancyForTheme } from "../shared/theme";
import { App } from "./App";
import { LocaleProvider } from "./i18n";
// Bundled so Windows/Linux render the same Latin text as macOS instead of thin Segoe UI.
import "@fontsource-variable/inter/wght.css";
import "./styles.css";

// The stored theme is the single source of truth for both the DOM palette and the
// native window material; keep them in lockstep from the very first paint.
const bootTheme = readStoredTheme();
applyTheme(bootTheme);
void window.harness.app.setVibrancy(vibrancyForTheme(bootTheme));

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <LocaleProvider>
      <App />
    </LocaleProvider>
  </StrictMode>,
);
