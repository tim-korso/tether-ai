import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  net,
  protocol,
  shell,
} from "electron";
import {
  createTetherCredentialStore,
  ensureSessionRuntimeLink,
  getTetherHome,
  getStoredDeepSeekBaseUrl,
  getStoredModelSelection,
  getTetherRpcEntryPath,
  initializeTetherHome,
  listTetherThreads,
  TetherStateStore,
  defaultModelForProvider,
  providerDisplayName,
  providerEnvironmentKey,
  removeStoredProviderCredential,
  saveDeepSeekBaseUrl,
  saveProviderApiKey,
  SUPPORTED_PROVIDER_IDS,
  type ApiKeyProviderId,
  type SupportedProviderId,
} from "tether-agent-core";
import { AgentHostManager } from "./agent-host-manager";
import { reapOrphanedAgentHosts } from "./agent-orphans";
import {
  isIgnoredWatchPath,
  parseWorkspaceIgnore,
} from "./workspace-ignore";
import { listWorkspaceFiles } from "./workspace-files";
import {
  RENDERER_RECOVERY_WINDOW_MS,
  canRecoverRenderer,
  recentRecoveryAttempts,
} from "./renderer-recovery";
import { isPathInsideRoot } from "./workspace-path";
import { listLocalSkills, revealSkillPath } from "./skills-fs";
import { apiBaseUrl, listOpenAiModels } from "../shared/openai-models";
import {
  activeChat,
  activeCustomProfile,
  isDeepSeekUrl,
  mergeChatProfiles,
  migrateChatProfiles,
  officialDeepSeekKey,
  parseChatProfiles,
  type ChatProfiles,
  type CustomApiProfile,
} from "../shared/chat-profiles";
import {
  mergeWebSearchConfig,
  parseDeepSeekBalance,
  parseMcpServers,
  parseWebSearchConfig,
  serializeMcpServers,
  type McpServerRow,
  type WebSearchConfig,
} from "../shared/integrations";
import {
  DEFAULT_VISION_CONFIG,
  DEEPSEEK_VISION_BASE,
  parseVisionStore,
  resolveVisionRuntime,
  resolveVisionSettings,
  serializeVisionConfigFile,
  serializeVisionStore,
  visionSnapshot,
  visionTitle,
  type VisionConfig,
} from "../shared/vision-api";
import {
  DEFAULT_LOCALE,
  isLocale,
  resolveLocale,
  t,
  type Locale,
} from "../shared/i18n";
import { getLatestUpdate, pickReleaseAsset, type ReleaseAsset } from "./update-check";
import { downloadUpdate, installPlan } from "./update-install";
import {
  PREVIEW_SCHEME,
  parsePreviewPath,
  UPLOADS_HOST,
  type AgentSnapshot,
  type AgentStartOptions,
  type CheckpointPayload,
  type ProviderStatus,
  type SessionSummary,
  type UpdateCheckResult,
  type UpdateDownloadState,
  type UpdateInstallResult,
  type UpdateProgress,
  type WorkspaceItem,
} from "../shared/types";
import { PROJECT_SKILL_ROOTS } from "../shared/skills";

const ALLOWED_AGENT_COMMANDS = new Set([
  "prompt",
  "steer",
  "abort",
  "new_session",
  "get_state",
  "get_messages",
  "set_model",
  "set_thinking_level",
  "get_session_stats",
  "get_available_models",
  "get_available_thinking_levels",
  "get_fork_messages",
  "get_entries",
  "get_commands",
  "fork",
  "compact",
  "set_auto_compaction",
]);

const MAX_STAGE_IMAGES = 4;
const MAX_STAGE_IMAGE_MB = 12;
const MAX_STAGE_IMAGE_BYTES = MAX_STAGE_IMAGE_MB * 1024 * 1024;
/** Staged images are one-shot; sweep anything older than this so the folder cannot grow forever. */
const STAGED_UPLOAD_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const legacyUserDataPath = path.join(app.getPath("appData"), "DSHarness");
const userDataPath = path.join(app.getPath("appData"), "Tether");

// Preserve existing sessions and credentials across the product rename.
if (!fs.existsSync(userDataPath) && fs.existsSync(legacyUserDataPath)) {
  try {
    fs.renameSync(legacyUserDataPath, userDataPath);
  } catch {
    // The old directory remains usable only by older builds; start clean if migration is unavailable.
  }
}

// Desktop distribution favors a quiet first run; the owner-only file avoids OS keyring prompts.
process.env.TETHER_CREDENTIALS_STORE = "file";

let mainWindow: BrowserWindow | undefined;
let hostManager: AgentHostManager | undefined;
let activeAgentCwd: string | undefined;
let activeSessionPath: string | undefined;
let workspaceWatcher: fs.FSWatcher | undefined;
let watchedWorkspace = "";
let watchTimer: ReturnType<typeof setTimeout> | undefined;
let updateCheckStarted = false;
let appLocale: Locale = DEFAULT_LOCALE;

// A privileged scheme gives previews a real origin: storage APIs work, and the app stays cross-origin.
protocol.registerSchemesAsPrivileged([
  {
    scheme: PREVIEW_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
    },
  },
]);

app.setName("Tether");
fs.mkdirSync(userDataPath, { recursive: true, mode: 0o700 });
app.setPath("userData", userDataPath);

function appIconPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "icon.png")
    : path.join(currentDirectory, "../../build/icon.png");
}

function applyDockIcon(): void {
  if (process.platform !== "darwin" || app.isPackaged) return;
  const image = nativeImage.createFromPath(appIconPath());
  if (image.isEmpty()) return;
  void app.dock?.setIcon(image);
}

type PendingUpdate = {
  version: string;
  releaseUrl: string;
  asset?: ReleaseAsset;
};

let pendingUpdate: PendingUpdate | undefined;
let updateDownloadState: UpdateDownloadState = { status: "idle" };
let updateDownloadController: AbortController | undefined;
let updateDownloadTask: Promise<DownloadOutcome> | undefined;
let downloadedUpdateFile: string | undefined;
/** Kept after the startup event so a renderer that subscribed late can still fetch it. */
let startupUpdateNotice: { version: string; releaseUrl: string } | undefined;

/** Downloads live in the OS temp area: they are disposable, and the installers are large. */
function updateDownloadDirectory(): string {
  return path.join(app.getPath("temp"), "tether-update");
}

/**
 * The asset name comes from the release, so it is remote input: `basename` keeps the download
 * inside the update folder even if a name contains separators.
 */
function updateTargetFile(assetName: string): string {
  return path.join(updateDownloadDirectory(), path.basename(assetName));
}

function clearUpdateDownloads(): void {
  try {
    fs.rmSync(updateDownloadDirectory(), { recursive: true, force: true });
  } catch {
    /* A leftover folder must never block startup. */
  }
}

// Installers from a previous session are stale by definition: they were never installed.
clearUpdateDownloads();

function sendUpdateProgress(progress: UpdateProgress): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("app:update-progress", progress);
}

function updateErrorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return t(appLocale, "update.failedDetail");
}

/**
 * Resolves the release index into "is there an installer for this machine". GitHub Releases is the
 * only update source, so this stays a single unauthenticated request.
 */
async function resolveUpdate(): Promise<UpdateCheckResult> {
  const current = app.getVersion();
  try {
    const release = await getLatestUpdate(current, (url, init) =>
      net.fetch(url, init),
    );
    if (!release) {
      pendingUpdate = undefined;
      return { status: "latest", current };
    }
    const asset = pickReleaseAsset(
      release.assets,
      process.platform,
      process.arch,
      release.version,
    );
    pendingUpdate = {
      version: release.version,
      releaseUrl: release.url,
      ...(asset ? { asset } : {}),
    };
    return {
      status: "available",
      version: release.version,
      releaseUrl: release.url,
      ...(asset
        ? {
            asset: {
              name: asset.name,
              ...(asset.size !== undefined ? { size: asset.size } : {}),
            },
          }
        : {}),
      installable: Boolean(asset),
    };
  } catch (error) {
    pendingUpdate = undefined;
    return { status: "failed", error: updateErrorText(error) };
  }
}

/** Startup stays silent and only announces availability; the renderer owns the update surface. */
function updatesDisabledByLocalPatches(): boolean {
  return process.env.TETHER_ALLOW_UPDATES !== "1";
}

async function checkForUpdatesOnStartup(): Promise<void> {
  if (!app.isPackaged || updateCheckStarted) return;
  if (updatesDisabledByLocalPatches()) return;
  updateCheckStarted = true;
  const result = await resolveUpdate();
  if (result.status !== "available") return;
  startupUpdateNotice = { version: result.version, releaseUrl: result.releaseUrl };
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("app:update-available", startupUpdateNotice);
}

type DownloadOutcome =
  | { ok: true; version: string }
  | { ok: false; cancelled?: boolean; error?: string };

async function startUpdateDownload(): Promise<DownloadOutcome> {
  // 本机构建带有本地补丁（v4-anchor / deepseek 前缀重挂 / retry 兼底），官方安装包会静默覆盖它们。
  // 需要升级时用 TETHER_ALLOW_UPDATES=1 启动，或手动重打补丁后替换应用。
  if (updatesDisabledByLocalPatches()) {
    return { ok: false, error: t(appLocale, "update.localBuild") };
  }
  if (updateDownloadController)
    return { ok: false, error: t(appLocale, "update.busy") };

  if (!pendingUpdate) {
    const result = await resolveUpdate();
    if (result.status !== "available") {
      return {
        ok: false,
        error:
          result.status === "failed"
            ? result.error
            : t(appLocale, "update.latest"),
      };
    }
  }
  const pending = pendingUpdate;
  if (!pending?.asset) return { ok: false, error: t(appLocale, "update.detail") };

  const file = updateTargetFile(pending.asset.name);
  const controller = new AbortController();
  updateDownloadController = controller;
  const initial: UpdateProgress = {
    received: 0,
    ...(pending.asset.size !== undefined
      ? { total: pending.asset.size, percent: 0 }
      : {}),
  };
  updateDownloadState = {
    status: "downloading",
    version: pending.version,
    progress: initial,
  };
  sendUpdateProgress(initial);

  const task = runUpdateDownload(pending, pending.asset, file, controller).finally(() => {
    updateDownloadController = undefined;
    updateDownloadTask = undefined;
  });
  updateDownloadTask = task;
  return task;
}

async function runUpdateDownload(
  pending: PendingUpdate,
  asset: ReleaseAsset,
  file: string,
  controller: AbortController,
): Promise<DownloadOutcome> {
  try {
    const result = await downloadUpdate({
      url: asset.url,
      file,
      fetchImpl: (url, init) => net.fetch(url, init),
      signal: controller.signal,
      onProgress: (progress) => {
        updateDownloadState = {
          status: "downloading",
          version: pending.version,
          progress,
        };
        sendUpdateProgress(progress);
      },
    });
    downloadedUpdateFile = result.file;
    updateDownloadState = { status: "ready", version: pending.version };
    return { ok: true, version: pending.version };
  } catch (error) {
    downloadedUpdateFile = undefined;
    // A user-initiated cancel returns to idle; anything else has to be reported.
    if (controller.signal.aborted) {
      updateDownloadState = { status: "idle" };
      return { ok: false, cancelled: true };
    }
    updateDownloadState = { status: "failed", error: updateErrorText(error) };
    return { ok: false, error: updateErrorText(error) };
  }
}

async function cancelUpdateDownload(): Promise<UpdateDownloadState> {
  updateDownloadController?.abort();
  // Wait for the aborted download to release its controller, so an immediate retry is accepted.
  await updateDownloadTask?.catch(() => undefined);
  return updateDownloadState;
}

async function installDownloadedUpdate(): Promise<UpdateInstallResult> {
  const file = downloadedUpdateFile;
  if (!file) return { ok: false, error: t(appLocale, "update.notDownloaded") };
  const plan = installPlan(process.platform, file);

  if (plan.kind === "open-dmg") {
    // An ad-hoc signed macOS build cannot be replaced by Squirrel, so the disk image is handed over.
    const failure = await shell.openPath(plan.path);
    if (failure) return { ok: false, error: failure };
    return { ok: true, action: "opened-installer" };
  }

  const window = mainWindow;
  if (window && !window.isDestroyed()) {
    const result = await dialog.showMessageBox(window, {
      type: "question",
      icon: nativeImage.createFromPath(appIconPath()),
      title: t(appLocale, "update.title"),
      message: t(appLocale, "update.confirmInstall", {
        version: pendingUpdate?.version ?? "",
      }),
      detail: t(appLocale, "update.confirmInstallDetail"),
      buttons: [t(appLocale, "update.installRestart"), t(appLocale, "common.cancel")],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (result.response !== 0) return { ok: false, cancelled: true };
  }

  // Detached: the installer outlives this process, which exits so its files can be replaced.
  spawn(plan.command, plan.args, { detached: true, stdio: "ignore" }).unref();
  app.quit();
  return { ok: true, action: "restarting" };
}

const RENDERER_UNRESPONSIVE_GRACE_MS = 20_000;
let rendererRecoveryAttempts: number[] = [];
let rendererFailureShown = false;
let rendererUnresponsiveTimer: ReturnType<typeof setTimeout> | undefined;

function loadMainRenderer(): void {
  const devServer = process.env.VITE_DEV_SERVER_URL;
  if (devServer) void mainWindow?.loadURL(devServer);
  else
    void mainWindow?.loadFile(
      path.join(currentDirectory, "../../dist/index.html"),
    );
}

/** 自愈预算用完后的降级页：不再无限重载，但保留 ⌘R 手动重试的退路。 */
function showRendererFailure(reason: string): void {
  rendererFailureShown = true;
  clearTimeout(rendererUnresponsiveTimer);
  rendererUnresponsiveTimer = undefined;
  const safeReason = reason.replace(/[<>&]/g, "").slice(0, 300);
  const html = `<!doctype html><meta charset="utf-8"><title>Tether</title>
<body style="font:14px -apple-system,system-ui;margin:0;display:flex;height:100vh;align-items:center;justify-content:center;background:#fafafb;color:#1f2328">
<div style="max-width:520px;text-align:center">
<p style="font-size:16px;font-weight:600;margin:0 0 8px">界面进程已连续异常退出</p>
<p style="margin:0 0 16px;color:#59636e">${safeReason}</p>
<p style="margin:0;color:#59636e">会话记录已保存在磁盘上，不会丢失。按 ⌘R 重新加载界面，或退出后重新打开应用。</p>
</div>`;
  void mainWindow?.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(html)}`,
  );
  mainWindow?.webContents.once("before-input-event", (event, input) => {
    if (input.type !== "keyDown" || !input.meta) return;
    if (input.key.toLowerCase() !== "r") return;
    event.preventDefault();
    rendererRecoveryAttempts = [];
    rendererFailureShown = false;
    loadMainRenderer();
  });
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 880,
    minHeight: 600,
    show: false,
    backgroundColor: "#fafafb",
    icon: appIconPath(),
    // The Windows controls overlay always paints above page content, so dialogs could never
    // cover it. Going frameless lets the renderer draw its own buttons in normal stacking order.
    ...(process.platform === "darwin"
      ? {
          titleBarStyle: "hiddenInset" as const,
          trafficLightPosition: { x: 16, y: 14 },
        }
      : {
          frame: false,
          // Transparent frameless windows lose the Windows resize border, and DWM rounding punches
          // the desktop through the corners, so the shell stays square with a CSS hairline instead.
          roundedCorners: false,
          hasShadow: true,
        }),
    webPreferences: {
      preload: path.join(currentDirectory, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  hostManager = new AgentHostManager(
    (event) => mainWindow?.webContents.send("agent:event", event),
    (message, sessionPath) =>
      mainWindow?.webContents.send("agent:error", message, sessionPath),
  );

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
    void checkForUpdatesOnStartup();
  });
  // Fullscreen hides the macOS traffic lights, so the renderer must stop reserving room for them.
  const reportFullscreen = () =>
    sendAppCommand(
      mainWindow?.isFullScreen() ? "fullscreen-on" : "fullscreen-off",
    );
  mainWindow.on("enter-full-screen", reportFullscreen);
  mainWindow.on("leave-full-screen", reportFullscreen);
  mainWindow.webContents.on("did-finish-load", reportFullscreen);
  mainWindow.on("closed", () => {
    mainWindow = undefined;
    // macOS keeps the app alive after the window closes; still reap the RPC tree
    // so sandbox shells don't keep burning RAM in the background.
    void hostManager?.stopAll();
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (url !== mainWindow?.webContents.getURL()) event.preventDefault();
  });

  // 崩溃/卡死自愈：渲染进程异常退出时在 30s 窗口内最多自动重载 2 次，超限降级为错误页。
  // 会话数据全在磁盘上，重载后渲染层会重新拉取 runningSessions 与当前会话，不需要主进程重建 run。
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    if (quitting || details.reason === "clean-exit") return;
    console.error(
      `[renderer] 异常退出 reason=${details.reason} exitCode=${details.exitCode}`,
    );
    logPerf(`renderer:gone reason=${details.reason} exitCode=${details.exitCode ?? "unknown"}`);
    rendererRecoveryAttempts = recentRecoveryAttempts(rendererRecoveryAttempts, Date.now());
    if (
      !rendererFailureShown &&
      canRecoverRenderer(rendererRecoveryAttempts, Date.now())
    ) {
      rendererRecoveryAttempts.push(Date.now());
      setTimeout(() => {
        if (quitting || !mainWindow || mainWindow.isDestroyed()) return;
        loadMainRenderer();
      }, 250);
      return;
    }
    showRendererFailure(
      `Renderer 进程异常退出（${details.reason}，退出码 ${details.exitCode ?? "unknown"}）`,
    );
  });

  // 卡死自愈：先给 20s 复原机会（也可能是长任务），仍无响应就重启渲染进程走重载路径。
  mainWindow.webContents.on("unresponsive", () => {
    console.warn("[renderer] 无响应，等待自愈窗口");
    clearTimeout(rendererUnresponsiveTimer);
    rendererUnresponsiveTimer = setTimeout(() => {
      if (quitting || !mainWindow || mainWindow.isDestroyed()) return;
      console.error("[renderer] 持续无响应，强制重建渲染进程");
      logPerf("renderer:unresponsive -> forcefullyCrashRenderer");
      rendererUnresponsiveTimer = undefined;
      mainWindow.webContents.forcefullyCrashRenderer();
    }, RENDERER_UNRESPONSIVE_GRACE_MS);
  });
  mainWindow.webContents.on("responsive", () => {
    clearTimeout(rendererUnresponsiveTimer);
    rendererUnresponsiveTimer = undefined;
  });

  mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription) => {
    if (quitting || rendererFailureShown) return;
    // 开发服务器未起、打包路径缺失等场景：重试一次，再失败就降级
    console.error(`[renderer] 加载失败 ${errorCode} ${errorDescription}`);
    const now = Date.now();
    if (canRecoverRenderer(rendererRecoveryAttempts, now)) {
      rendererRecoveryAttempts.push(now);
      setTimeout(() => {
        if (quitting || rendererFailureShown) return;
        loadMainRenderer();
      }, 500);
      return;
    }
    showRendererFailure(`界面加载失败（${errorDescription || errorCode}）`);
  });

  loadMainRenderer();
}

function sendAppCommand(command: string): void {
  mainWindow?.webContents.send("app:command", command);
}

function installMenu(): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(process.platform === "darwin" ? [{ role: "appMenu" as const }] : []),
      {
        label: t(appLocale, "menu.file"),
        submenu: [
          {
            label: t(appLocale, "menu.newThread"),
            accelerator: "CmdOrCtrl+N",
            click: () => sendAppCommand("new-thread"),
          },
          {
            label: t(appLocale, "menu.openFolder"),
            accelerator: "CmdOrCtrl+O",
            click: () => sendAppCommand("open-folder"),
          },
          { type: "separator" },
          process.platform === "darwin" ? { role: "close" } : { role: "quit" },
        ],
      },
      { role: "editMenu" },
      { role: "viewMenu" },
    ]),
  );
}

const SESSIONS_LIST_TTL_MS = 1_500;
const SESSIONS_REFRESH_DEBOUNCE_MS = 1_200;
const SESSIONS_REFRESH_MIN_INTERVAL_MS = 10_000;

let sessionsListCache: { key: string; at: number; rows: SessionSummary[] } | undefined;
let sessionsRefreshTimer: ReturnType<typeof setTimeout> | undefined;
let sessionsRefreshTask: Promise<void> | undefined;
let sessionsLastRefreshAt = 0;

function threadSummary(
  thread: Awaited<ReturnType<typeof listTetherThreads>>[number],
): SessionSummary {
  return {
    path: thread.sessionPath,
    storagePath: thread.storagePath,
    id: thread.id,
    cwd: thread.cwd,
    title: visionTitle(thread.title),
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    ...(thread.provider ? { provider: thread.provider } : {}),
    ...(thread.model ? { model: thread.model } : {}),
    messageCount: thread.messageCount,
    ...(thread.preview ? { preview: thread.preview } : {}),
    pinned: thread.pinned,
    archived: thread.archived,
  };
}

/**
 * 会话列表热路径：只读 SQLite 索引表 + 短 TTL 缓存。
 * 真正的 jsonl 解析（listTetherThreads → refresh → parseSession）成本与文件大小成正比
 * （实测 71MB 会话 ≈ 1.07s + 285MB 瞬时内存），因此绝不放在 IPC 等待链路上。
 */
async function listSessionSummaries(cwd?: string): Promise<SessionSummary[]> {
  const key = cwd ? path.resolve(cwd) : "";
  const cached = sessionsListCache;
  if (cached && cached.key === key && Date.now() - cached.at < SESSIONS_LIST_TTL_MS) {
    return cached.rows;
  }
  const store = new TetherStateStore();
  let rows: SessionSummary[] = [];
  try {
    rows = store.list(cwd ? { cwd } : {}).map(threadSummary);
  } catch {
    rows = [];
  } finally {
    store.close();
  }
  // 索引为空（首次启动/全新目录）时才有必要同步等一次，否则先给缓存、后台再校准
  if (rows.length === 0 && sessionsLastRefreshAt === 0) {
    try {
      const threads = await listTetherThreads(cwd ? { cwd } : {});
      rows = threads.map(threadSummary);
      sessionsLastRefreshAt = Date.now();
    } catch {
      /* 索引失败时返回空列表，不阻塞启动 */
    }
  }
  sessionsListCache = { key, at: Date.now(), rows };
  return rows;
}

function scheduleSessionsRefresh(): void {
  if (sessionsRefreshTimer || sessionsRefreshTask) return;
  const since = Date.now() - sessionsLastRefreshAt;
  const delay = Math.max(SESSIONS_REFRESH_DEBOUNCE_MS, SESSIONS_REFRESH_MIN_INTERVAL_MS - since);
  sessionsRefreshTimer = setTimeout(() => {
    sessionsRefreshTimer = undefined;
    void refreshSessionIndex();
  }, delay);
}

async function refreshSessionIndex(): Promise<void> {
  if (sessionsRefreshTask) return sessionsRefreshTask;
  const task = (async () => {
    try {
      const startedAt = Date.now();
      const rows = (await listTetherThreads({})).map(threadSummary);
      const elapsed = Date.now() - startedAt;
      if (elapsed > 500) logPerf(`sessions:refresh ${elapsed}ms rows=${rows.length}`);
      sessionsLastRefreshAt = Date.now();
      sessionsListCache = { key: "", at: Date.now(), rows };
      mainWindow?.webContents.send("sessions:changed", rows);
    } catch {
      /* 索引失败不影响 UI */
    }
  })().finally(() => {
    if (sessionsRefreshTask === task) sessionsRefreshTask = undefined;
  });
  sessionsRefreshTask = task;
  return task;
}

function registerIpc(): void {
  ipcMain.handle("app:version", () => app.getVersion());
  ipcMain.handle("app:check-update", () => resolveUpdate());
  ipcMain.handle("app:update-download", () => startUpdateDownload());
  ipcMain.handle("app:update-cancel", () => cancelUpdateDownload());
  ipcMain.handle("app:update-install", () => installDownloadedUpdate());
  ipcMain.handle("app:update-state", () => updateDownloadState);
  ipcMain.handle("app:update-notice", () => startupUpdateNotice);
  ipcMain.handle("app:get-locale", () => appLocale);
  ipcMain.handle("app:set-locale", async (_event, locale: unknown) => {
    if (!isLocale(locale)) throw new Error("Unsupported locale");
    await saveLocale(locale);
  });
  ipcMain.handle("app:open-external", async (_event, url: string) => {
    if (!isSafeExternalUrl(url))
      throw new Error("Only http(s) links can be opened");
    await shell.openExternal(url);
  });
  ipcMain.handle(
    "app:reveal-path",
    async (_event, skillName: string, hint?: string) => {
      if (typeof skillName !== "string" || !skillName.trim())
        throw new Error("Invalid skill name");
      await revealSkillPath(
        skillName.trim(),
        typeof hint === "string" ? hint : undefined,
      );
    },
  );
  ipcMain.handle("app:list-skills", async () =>
    listLocalSkills(activeAgentCwd),
  );

  ipcMain.handle("window:minimize", () => mainWindow?.minimize());
  ipcMain.handle("window:toggle-maximize", () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });
  ipcMain.handle("window:close", () => mainWindow?.close());

  ipcMain.handle("workspace:choose", async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: t(appLocale, "dialog.openWorkspace"),
      properties: ["openDirectory", "createDirectory"],
      buttonLabel: t(appLocale, "dialog.open"),
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return recentWorkspaces.touch(result.filePaths[0]);
  });
  ipcMain.handle("workspace:recent", () => recentWorkspaces.list());
  ipcMain.handle("workspace:forget", async (_event, workspacePath: string) => {
    const store = new TetherStateStore();
    try {
      await store.refresh();
      for (const thread of store.list({ cwd: workspacePath })) {
        await store.archive(thread.id);
      }
    } finally {
      store.close();
    }
    return recentWorkspaces.forget(workspacePath);
  });
  ipcMain.handle(
    "workspace:read",
    async (_event, relativePath: string, workspacePath?: string) => {
      try {
        const resolved = await resolveInWorkspace(relativePath, workspacePath);
        const buffer = await fsp.readFile(resolved);
        if (buffer.includes(0))
          return { path: relativePath, binary: true, content: "", missing: false };
        const text = buffer.toString("utf8");
        return {
          path: relativePath,
          binary: false,
          missing: false,
          content:
            text.length > 200_000 ? `${text.slice(0, 200_000)}\n…` : text,
        };
      } catch (error) {
        if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "ENOENT"
        ) {
          // "Not found here" is not "empty file": the renderer resolves relative paths against
          // the active project, which can differ from the one that produced the change.
          return { path: relativePath, binary: false, content: "", missing: true };
        }
        throw error;
      }
    },
  );
  ipcMain.handle(
    "workspace:open",
    async (_event, relativePath: string, workspacePath?: string) => {
      const error = await shell.openPath(
        await resolveInWorkspace(relativePath, workspacePath),
      );
      if (error) throw new Error(error);
    },
  );
  ipcMain.handle(
    "workspace:reveal",
    async (_event, relativePath: string, workspacePath?: string) => {
      shell.showItemInFolder(
        await resolveInWorkspace(
          typeof relativePath === "string" && relativePath.trim()
            ? relativePath
            : ".",
          workspacePath,
        ),
      );
    },
  );
  ipcMain.handle(
    "workspace:restore",
    async (_event, files: unknown, workspacePath?: string) => {
      if (!Array.isArray(files)) throw new Error("Invalid restore payload");
      const restored: string[] = [];
      for (const file of files) {
        if (!file || typeof file !== "object") continue;
        const item = file as {
          path?: unknown;
          content?: unknown;
          mode?: unknown;
        };
        if (typeof item.path !== "string" || !item.path.trim()) continue;
        const resolved = await resolveInWorkspace(item.path, workspacePath);
        if (item.content === null) {
          await fsp.rm(resolved, { force: true });
        } else if (typeof item.content === "string") {
          await fsp.mkdir(path.dirname(resolved), { recursive: true });
          await fsp.writeFile(resolved, item.content, {
            encoding: "utf8",
            ...(typeof item.mode === "number" ? { mode: item.mode } : {}),
          });
        } else {
          continue;
        }
        restored.push(item.path);
      }
      return { restored };
    },
  );
  ipcMain.handle("workspace:list", async (_event, workspacePath?: string) => {
    const root = path.resolve(
      typeof workspacePath === "string" && workspacePath
        ? workspacePath
        : (activeAgentCwd ?? ""),
    );
    if (!root) return [];
    const allowed =
      path.resolve(activeAgentCwd ?? "") === root ||
      (await recentWorkspaces.list()).some(
        (item) => path.resolve(item.path) === root,
      );
    if (!allowed) return [];
    watchWorkspace(root);
    return listWorkspaceFilesCached(root);
  });
  ipcMain.handle("vision:config", async () => {
    let raw: unknown = {};
    try {
      raw = JSON.parse(await fsp.readFile(visionConfigPath(), "utf8")) as unknown;
    } catch {
      raw = {
        ...DEFAULT_VISION_CONFIG,
        apiKey: process.env.ZHIPU_API_KEY?.trim() ?? "",
      };
    }
    const store = parseVisionStore(raw);
    const profiles = await loadChatProfiles().catch(() => undefined);
    const chatKey = profiles ? officialDeepSeekKey(profiles) : "";
    const next = store.profiles.map((item) => {
      const base = item.url.trim().replace(/\/+$/, "").replace(/\/chat\/completions$/i, "").replace(/\/+$/, "");
      if (chatKey && isDeepSeekUrl(base) && !item.apiKey.trim()) return { ...item, apiKey: chatKey };
      return item;
    });
    const snapshot = visionSnapshot(next, store.activeProfileId);
    return {
      ...snapshot,
      profiles: next,
      activeProfileId: store.activeProfileId,
      hasApiKey: Boolean(snapshot.apiKey.trim()),
    };
  });
  ipcMain.handle(
    "vision:save-config",
    async (
      _event,
      next: {
        profiles?: CustomApiProfile[];
        activeProfileId?: string;
      },
    ) => {
      const store = parseVisionStore({
        profiles: Array.isArray(next.profiles) ? next.profiles : [],
        activeProfileId: next.activeProfileId,
      });
      await fsp.writeFile(
        visionConfigPath(),
        `${JSON.stringify(serializeVisionStore(store.profiles, store.activeProfileId), null, 2)}\n`,
        { mode: 0o600 },
      );
    },
  );
  ipcMain.handle("vision:stage", async (_event, images: string[]) => {
    const refs = Array.isArray(images)
      ? images.filter((item) => typeof item === "string" && item).slice(0, MAX_STAGE_IMAGES)
      : [];
    if (refs.length === 0)
      throw new Error(t(appLocale, "error.noImage"));
    const dir = visionUploadsDir();
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
    const stamp = Date.now();
    return Promise.all(
      refs.map(async (item, index) => {
        const match = item.match(/^data:([^;]+);base64,(.+)$/);
        const mime = match?.[1] ?? "image/png";
        const data = match?.[2] ?? item.replace(/^data:[^;]+;base64,/, "");
        const bytes = Buffer.from(data, "base64");
        if (bytes.length === 0)
          throw new Error(t(appLocale, "error.invalidImage"));
        if (bytes.length > MAX_STAGE_IMAGE_BYTES)
          throw new Error(
            t(appLocale, "error.imageTooLarge", { mb: MAX_STAGE_IMAGE_MB }),
          );
        const ext =
          mime.includes("jpeg") || mime.includes("jpg")
            ? "jpg"
            : mime.includes("webp")
              ? "webp"
              : mime.includes("gif")
                ? "gif"
                : "png";
        const file = path.join(dir, `${stamp}-${index + 1}.${ext}`);
        await fsp.writeFile(file, bytes, { mode: 0o600 });
        return file;
      }),
    );
  });

  ipcMain.handle("services:web-search", async () => parseWebSearchConfig(await readHomeJson("web-search.json")));
  ipcMain.handle(
    "services:save-web-search",
    async (_event, next: WebSearchConfig) => {
      const previous = await readHomeJson("web-search.json");
      await writeHomeJson("web-search.json", mergeWebSearchConfig(previous, parseWebSearchConfig(next)));
    },
  );
  ipcMain.handle("services:mcp", async () => parseMcpServers(await readHomeJson("mcp.json")));
  ipcMain.handle("services:save-mcp", async (_event, rows: McpServerRow[]) => {
    await writeHomeJson("mcp.json", serializeMcpServers(Array.isArray(rows) ? rows : []));
  });
  ipcMain.handle("services:reveal-mcp", async () => {
    const file = path.join(getTetherHome(), "mcp.json");
    try {
      await fsp.access(file);
    } catch {
      await writeHomeJson("mcp.json", { mcpServers: {} });
    }
    await shell.showItemInFolder(file);
  });
  ipcMain.handle("services:deepseek-balance", async () => {
    const profiles = await loadChatProfiles();
    const chat = activeChat(profiles);
    const key = chat.apiKey;
    if (!key || !isDeepSeekUrl(chat.url)) return null;
    const response = await fetch("https://api.deepseek.com/user/balance", {
      headers: { authorization: `Bearer ${key}` },
    });
    const payload: unknown = await response.json().catch(() => undefined);
    if (!response.ok) throw new Error(`DeepSeek 余额查询失败（${response.status}）`);
    return parseDeepSeekBalance(payload) ?? null;
  });

  ipcMain.handle("sessions:list", async (_event, cwd?: string) => {
    const rows = await listSessionSummaries(cwd);
    // 索引（解析 jsonl）放后台并去抖：列表接口不再等它，避免大会话把主进程钉住
    scheduleSessionsRefresh();
    return rows;
  });
  ipcMain.handle("sessions:remove", async (_event, id: string) => {
    const store = new TetherStateStore();
    try {
      await store.refresh();
      await store.archive(id);
    } finally {
      store.close();
      sessionsListCache = undefined;
    }
  });
  ipcMain.handle(
    "sessions:pin",
    async (_event, id: string, pinned: boolean) => {
      const store = new TetherStateStore();
      try {
        await store.refresh();
        if (!store.setPinned(id, pinned))
          throw new Error("Conversation not found");
      } finally {
        store.close();
        sessionsListCache = undefined;
      }
    },
  );
  ipcMain.handle(
    "sessions:rename",
    async (_event, id: string, title: string) => {
      const name = title.trim().slice(0, 96);
      if (!name) throw new Error("Conversation name cannot be empty");
      const store = new TetherStateStore();
      try {
        await store.refresh();
        const thread = store.get(id);
        if (!thread) throw new Error("Conversation not found");
        await fsp.appendFile(
          thread.storagePath,
          `${JSON.stringify({
            type: "session_info",
            name,
            timestamp: new Date().toISOString(),
          })}\n`,
        );
        await store.indexSession(thread.storagePath);
      } finally {
        store.close();
        sessionsListCache = undefined;
      }
    },
  );

  ipcMain.handle("auth:status", async (): Promise<ProviderStatus[]> => {
    const credentialStore = await createTetherCredentialStore();
    const storedProviders = new Set(
      (await credentialStore.list()).map((entry) => entry.providerId),
    );
    const stored = getStoredModelSelection();
    const deepseekUrl = getStoredDeepSeekBaseUrl();
    return SUPPORTED_PROVIDER_IDS.filter((id) => id !== "openai-codex").map(
      (id) => {
        const hasStore = storedProviders.has(id);
        const environmentKey = providerEnvironmentKey(id);
        const environment = Boolean(
          environmentKey && process.env[environmentKey]?.trim(),
        );
        return {
          id,
          name: providerDisplayName(id),
          configured: hasStore || environment,
          ...(hasStore
            ? { source: "stored" as const }
            : environment
              ? { source: "environment" as const }
              : {}),
          defaultModel:
            stored?.providerId === id && stored.modelId
              ? stored.modelId
              : defaultModelForProvider(id),
          ...(id === "deepseek" && deepseekUrl ? { baseUrl: deepseekUrl } : {}),
          ...(stored?.providerId === id ? { preferred: true } : {}),
        };
      },
    );
  });
  ipcMain.handle(
    "auth:read-api-key",
    async (_event, provider: ApiKeyProviderId) => {
      const stored = await (await createTetherCredentialStore()).read(provider);
      if (stored && stored.type === "api_key" && typeof stored.key === "string")
        return stored.key;
      const envName = providerEnvironmentKey(provider);
      return envName ? (process.env[envName]?.trim() ?? "") : "";
    },
  );
  ipcMain.handle(
    "auth:save-api-key",
    async (
      _event,
      provider: ApiKeyProviderId,
      key: string,
      baseUrl?: string,
      model?: string,
    ) => {
      if (typeof key === "string" && key.trim())
        await saveProviderApiKey(provider, key.trim());
      if (baseUrl?.trim()) await saveDeepSeekBaseUrl(baseUrl.trim());
      if (model?.trim()) await saveDefaultModel(provider, model.trim());
    },
  );
  ipcMain.handle("auth:profiles", () => loadChatProfiles());
  ipcMain.handle("auth:save-profiles", async (_event, next: ChatProfiles) => {
    await saveChatProfiles(next);
  });
  ipcMain.handle(
    "auth:list-models",
    async (_event, baseUrl: string, apiKey: string) => {
      if (typeof baseUrl !== "string" || typeof apiKey !== "string")
        throw new Error(t(appLocale, "error.needUrlAndKey"));
      return listOpenAiModels(baseUrl, apiKey, fetch, appLocale);
    },
  );
  ipcMain.handle(
    "auth:logout",
    async (_event, provider: SupportedProviderId) => {
      await removeStoredProviderCredential(provider);
    },
  );

  ipcMain.handle("agent:start", async (_event, options: AgentStartOptions) => {
    const tasksDir = path.resolve(path.join(userDataPath, "tasks"));
    const cwd = options.cwd ? path.resolve(options.cwd) : tasksDir;
    await fsp.mkdir(cwd, { recursive: true });
    activeAgentCwd = cwd;
    if (options.project || cwd !== tasksDir) await recentWorkspaces.touch(cwd);
    const {
      resume: _resume,
      sandbox: requestedSandbox,
      storagePath,
      ...startOptions
    } = options;
    let sessionPath = startOptions.sessionPath;
    if (sessionPath) {
      sessionPath = await ensureSessionRuntimeLink(
        sessionPath,
        storagePath || sessionPath,
      );
    }
    const sandbox =
      cwd === tasksDir
        ? "read-only"
        : requestedSandbox === "read-only"
          ? "workspace-write"
          : requestedSandbox;
    const storedUrl =
      startOptions.provider === "deepseek"
        ? getStoredDeepSeekBaseUrl()
        : undefined;
    const rawUrl = startOptions.baseUrl ?? storedUrl;
    // Keep DeepSeek vision credentials in sync with the chat DeepSeek key/base URL.
    await syncDeepSeekVisionConfig().catch(() => undefined);
    const profiles = await loadChatProfiles();
    const maxTokens = activeCustomProfile(profiles)?.maxTokens;
    const baseUrl = rawUrl ? apiBaseUrl(rawUrl) : undefined;
    const { snapshot } = await hostManager!.getOrCreateHost({
      ...startOptions,
      ...(sessionPath ? { sessionPath } : {}),
      resume: options.resume,
      cwd,
      sandbox,
      visionExtension: visionExtensionPath(),
      visionConfig: visionConfigPath(),
      visionUploads: visionUploadsDir(),
      ...(baseUrl ? { baseUrl } : {}),
      ...(maxTokens ? { maxTokens } : {}),
    });
    activeSessionPath = sessionFileOf(snapshot) ?? sessionPath;
    return { ...snapshot, cwd: snapshot.cwd ?? cwd };
  });
  ipcMain.handle("agent:stop", (_event, sessionPath?: string) => {
    if (!sessionPath) activeSessionPath = undefined;
    return hostManager!.stop(sessionPath);
  });
  // 2026-09-27 P1：checkpoint 载荷外置后，撤销所需的文件正文不在会话 JSONL 里。
  // 渲染层只带 id 过来，主进程按 id 读 ~/.tether/checkpoints/<id>.json。
  // 这里刻意不整目录扫描、不缓存：一次 readFile 对应一次撤销请求。
  ipcMain.handle("agent:checkpoint-payload", (_event, id: string, sessionPath?: string) =>
    readCheckpointPayload(id, sessionPath),
  );
  ipcMain.handle(
    "agent:command",
    async (
      _event,
      type: string,
      data?: Record<string, unknown>,
      sessionPath?: string,
    ) => {
      if (!ALLOWED_AGENT_COMMANDS.has(type))
        throw new Error(`Unsupported agent command: ${type}`);
      const host = hostManager!.getHost(sessionPath);
      if (!host) throw new Error(t(appLocale, "error.noActiveSession"));
      const result = await host.request(type, data);
      if (
        type === "new_session" ||
        type === "get_state" ||
        type === "get_session_stats"
      ) {
        const file = sessionFileFromUnknown(result);
        if (file) {
          activeSessionPath = file;
          // Route through the setter: a bare field write left the session index cold and the
          // manager's host map keyed by the old path, so later lookups fell back to guessing.
          host.setSessionPath(file);
          hostManager!.setActiveSessionPath(file);
        }
      }
      return result;
    },
  );
  ipcMain.handle(
    "agent:ui-response",
    (
      _event,
      id: string,
      response: Record<string, unknown>,
      sessionPath?: string,
    ) => {
      const host = hostManager!.getHost(sessionPath);
      if (!host) throw new Error(t(appLocale, "error.noActiveSession"));
      return host.respondToUi(id, response);
    },
  );
  ipcMain.handle("agent:running-sessions", () => {
    return hostManager!.getRunningSessions();
  });
}

const HOST_IDLE_REAP_INTERVAL_MS = 60_000;
const SESSIONS_PERIODIC_REFRESH_TICKS = 5;
let maintenanceTimer: ReturnType<typeof setInterval> | undefined;
let maintenanceTicks = 0;

/**
 * 主进程维护定时器：
 * - 空闲会话 runtime 回收（原逻辑只在“新建 host 前”顺带执行，闲置进程因此能活好几天）；
 * - 会话索引低频校准（让外部写入的会话也能被发现）。
 */
function startMaintenanceTimers(): void {
  clearInterval(maintenanceTimer);
  maintenanceTicks = 0;
  maintenanceTimer = setInterval(() => {
    maintenanceTicks += 1;
    try {
      hostManager?.pruneIdleHosts();
    } catch {
      /* 回收失败不影响主流程 */
    }
    if (maintenanceTicks % SESSIONS_PERIODIC_REFRESH_TICKS === 0) {
      scheduleSessionsRefresh();
    }
  }, HOST_IDLE_REAP_INTERVAL_MS);
}

async function readHomeJson(name: string): Promise<unknown> {
  try {
    return JSON.parse(await fsp.readFile(path.join(getTetherHome(), name), "utf8"));
  } catch {
    return {};
  }
}

async function writeHomeJson(name: string, value: unknown): Promise<void> {
  const file = path.join(getTetherHome(), name);
  await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fsp.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

async function saveDefaultModel(
  providerId: string,
  modelId: string,
): Promise<void> {
  const settingsPath = path.join(getTetherHome(), "settings.json");
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(await fsp.readFile(settingsPath, "utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    /* first write */
  }
  settings.defaultProvider = providerId;
  settings.defaultModel = modelId;
  await fsp.mkdir(path.dirname(settingsPath), { recursive: true, mode: 0o700 });
  await fsp.writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, {
    mode: 0o600,
  });
}

async function readSettingsFile(): Promise<Record<string, unknown>> {
  const settingsPath = path.join(getTetherHome(), "settings.json");
  try {
    return JSON.parse(await fsp.readFile(settingsPath, "utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return {};
  }
}

async function loadLocale(): Promise<Locale> {
  const settings = await readSettingsFile();
  const stored = typeof settings.locale === "string" ? settings.locale : null;
  const system =
    typeof app.getPreferredSystemLanguages === "function"
      ? app.getPreferredSystemLanguages()
      : [];
  appLocale = resolveLocale(stored, system);
  return appLocale;
}

async function saveLocale(locale: Locale): Promise<void> {
  const settingsPath = path.join(getTetherHome(), "settings.json");
  const settings = await readSettingsFile();
  settings.locale = locale;
  await fsp.mkdir(path.dirname(settingsPath), { recursive: true, mode: 0o700 });
  await fsp.writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, {
    mode: 0o600,
  });
  appLocale = locale;
  installMenu();
}

function isSafeExternalUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

const recentFile = path.join(userDataPath, "recent-workspaces.json");
const recentWorkspaces = {
  async list(): Promise<WorkspaceItem[]> {
    try {
      const parsed = JSON.parse(
        await fsp.readFile(recentFile, "utf8"),
      ) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(isWorkspaceItem).slice(0, 12);
    } catch {
      return [];
    }
  },
  async touch(workspacePath: string): Promise<string> {
    const resolved = path.resolve(workspacePath);
    const stat = await fsp.stat(resolved);
    if (!stat.isDirectory())
      throw new Error(t(appLocale, "error.notAFolder"));
    const current = await this.list();
    const next = [
      {
        path: resolved,
        name: path.basename(resolved) || resolved,
        lastOpenedAt: new Date().toISOString(),
      },
      ...current.filter((item) => item.path !== resolved),
    ].slice(0, 12);
    await fsp.mkdir(path.dirname(recentFile), { recursive: true });
    await fsp.writeFile(recentFile, `${JSON.stringify(next, null, 2)}\n`, {
      mode: 0o600,
    });
    return resolved;
  },
  async forget(workspacePath: string): Promise<WorkspaceItem[]> {
    const next = (await this.list()).filter(
      (item) => item.path !== workspacePath,
    );
    await fsp.writeFile(recentFile, `${JSON.stringify(next, null, 2)}\n`, {
      mode: 0o600,
    });
    return next;
  },
};

async function servePreview(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const parsed = parsePreviewPath(url.pathname);
  const name = parsed.path;
  let target: string;
  if (url.host === UPLOADS_HOST) {
    // basename only: this host serves staged uploads, never an arbitrary path on disk.
    target = path.join(visionUploadsDir(), path.basename(name));
  } else {
    try {
      target = await resolveInWorkspace(name, parsed.workspace);
    } catch (error) {
      return new Response(
        error instanceof Error ? error.message : "Forbidden",
        { status: 403 },
      );
    }
  }
  try {
    return await net.fetch(pathToFileURL(target).toString());
  } catch {
    return new Response("Not found", { status: 404 });
  }
}

function visionConfigPath(): string {
  return path.join(userDataPath, "vision-config.json");
}

function chatProfilesPath(): string {
  return path.join(userDataPath, "chat-profiles.json");
}

async function loadChatProfiles(): Promise<ChatProfiles> {
  try {
    const parsed = parseChatProfiles(
      JSON.parse(await fsp.readFile(chatProfilesPath(), "utf8")),
    );
    if (parsed) return parsed;
  } catch {
    /* migrate from the single stored slot */
  }
  const stored = await (await createTetherCredentialStore()).read("deepseek");
  const apiKey =
    stored && stored.type === "api_key" && typeof stored.key === "string"
      ? stored.key
      : "";
  const selected = getStoredModelSelection();
  return migrateChatProfiles({
    url: getStoredDeepSeekBaseUrl() ?? "",
    model: selected?.providerId === "deepseek" ? (selected.modelId ?? "") : "",
    apiKey,
  });
}

async function saveChatProfiles(next: ChatProfiles): Promise<void> {
  const merged = mergeChatProfiles(await loadChatProfiles(), next);
  await fsp.mkdir(path.dirname(chatProfilesPath()), {
    recursive: true,
    mode: 0o700,
  });
  await fsp.writeFile(
    chatProfilesPath(),
    `${JSON.stringify(merged, null, 2)}\n`,
    { mode: 0o600 },
  );
  const chat = activeChat(merged);
  if (chat.apiKey) await saveProviderApiKey("deepseek", chat.apiKey);
  if (chat.url) await saveDeepSeekBaseUrl(chat.url.replace(/\/+$/, ""));
  if (chat.model) await saveDefaultModel("deepseek", chat.model);
}

function visionUploadsDir(): string {
  return path.join(userDataPath, "uploads");
}

/**
 * Staged uploads live outside the workspace and are only referenced by a timestamped name, so
 * after their turn they are unreachable leftovers. Sweep stale ones on startup.
 */
async function pruneStagedUploads(): Promise<void> {
  const dir = visionUploadsDir();
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const cutoff = Date.now() - STAGED_UPLOAD_TTL_MS;
  await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map(async (entry) => {
        const file = path.join(dir, entry.name);
        try {
          const stat = await fsp.stat(file);
          if (stat.mtimeMs < cutoff) await fsp.rm(file, { force: true });
        } catch {
          // Raced with another removal, or the file vanished; nothing to do.
        }
      }),
  );
}

function visionExtensionPath(): string {
  return path.join(currentDirectory, "../extensions/vision.js");
}

async function loadVisionConfig(): Promise<VisionConfig> {
  try {
    const raw = JSON.parse(
      await fsp.readFile(visionConfigPath(), "utf8"),
    ) as Partial<VisionConfig>;
    const settings = resolveVisionSettings(raw);
    const base: VisionConfig = {
      ...settings,
      apiKey: typeof raw.apiKey === "string" ? raw.apiKey.trim() : "",
    };
    if (base.provider === "deepseek")
      return materializeDeepSeekVision(base.apiKey);
    return base;
  } catch {
    return {
      ...DEFAULT_VISION_CONFIG,
      apiKey: process.env.ZHIPU_API_KEY?.trim() ?? "",
    };
  }
}

async function materializeDeepSeekVision(
  fallbackKey = "",
): Promise<VisionConfig> {
  const store = await createTetherCredentialStore();
  try {
    const profiles = await loadChatProfiles().catch(() => undefined);
    const stored = await store.read("deepseek");
    const storedKey =
      stored && stored.type === "api_key" && typeof stored.key === "string"
        ? stored.key.trim()
        : "";
    // Prefer an explicit vision key; only reuse an official DeepSeek chat key
    // (the credential slot is overwritten by whichever profile is enabled).
    const chatKey = profiles ? officialDeepSeekKey(profiles) : storedKey;
    const key =
      fallbackKey.trim() ||
      chatKey ||
      process.env.DEEPSEEK_API_KEY?.trim() ||
      "";
    return resolveVisionRuntime(
      { provider: "deepseek", endpoint: "", model: "", apiKey: "" },
      { baseUrl: DEEPSEEK_VISION_BASE, apiKey: key },
    );
  } finally {
    // Credential store may hold file handles on some backends; ignore close failures.
  }
}

async function syncDeepSeekVisionConfig(): Promise<void> {
  const current = await loadVisionConfig();
  if (current.provider !== "deepseek") return;
  const next = await materializeDeepSeekVision(current.apiKey);
  const serialized = serializeVisionConfigFile(next);
  // This runs at the start of every message: skipping an identical write stops a long session
  // from rewriting the same few hundred bytes on every turn.
  const file = visionConfigPath();
  try {
    if ((await fsp.readFile(file, "utf8")) === serialized) return;
  } catch {
    // Missing or unreadable config: fall through and write a fresh one.
  }
  await fsp.writeFile(file, serialized, { mode: 0o600 });
}

async function resolveInWorkspace(
  relativePath: string,
  workspacePath?: string,
): Promise<string> {
  const candidate =
    typeof workspacePath === "string" && workspacePath.trim()
      ? workspacePath
      : activeAgentCwd;
  if (!candidate) throw new Error(t(appLocale, "error.noActiveSession"));
  const root = path.resolve(candidate);
  const allowed =
    path.resolve(activeAgentCwd ?? "") === root ||
    (await recentWorkspaces.list()).some(
      (item) => path.resolve(item.path) === root,
    );
  if (!allowed) throw new Error(t(appLocale, "error.folderNotOpened"));
  const resolved = path.resolve(root, relativePath);
  if (!isPathInsideRoot(root, resolved))
    throw new Error(t(appLocale, "error.pathOutsideWorkspace"));
  // Lexical check alone loses to symlinks (e.g. workspace/link → ~/.ssh). Re-check after realpath.
  let realRoot: string;
  try {
    realRoot = await fsp.realpath(root);
  } catch {
    throw new Error(t(appLocale, "error.workspaceInaccessible"));
  }
  const realPath = await realpathExistingOrJoin(resolved);
  if (!isPathInsideRoot(realRoot, realPath))
    throw new Error(t(appLocale, "error.pathOutsideWorkspace"));
  return resolved;
}

/** realpath(target), or realpath(nearest existing ancestor) + remaining segments for create paths. */
async function realpathExistingOrJoin(target: string): Promise<string> {
  try {
    return await fsp.realpath(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new Error(t(appLocale, "error.pathOutsideWorkspace"));
  }
  const parts: string[] = [];
  let cursor = target;
  while (true) {
    parts.unshift(path.basename(cursor));
    const parent = path.dirname(cursor);
    if (parent === cursor)
      throw new Error(t(appLocale, "error.pathOutsideWorkspace"));
    try {
      return path.join(await fsp.realpath(parent), ...parts);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error(t(appLocale, "error.pathOutsideWorkspace"));
      cursor = parent;
    }
  }
}

function sessionFileOf(snapshot: AgentSnapshot): string | undefined {
  return (
    sessionFileFromUnknown(snapshot.stats) ??
    sessionFileFromUnknown(snapshot.state)
  );
}

function sessionFileFromUnknown(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || !("sessionFile" in value))
    return undefined;
  return typeof value.sessionFile === "string" ? value.sessionFile : undefined;
}

/** 与 tether-agent-core/dist/checkpoint.js 的外置载荷契约保持一致（那边是写入方）。 */
const CHECKPOINT_PAYLOAD_SCHEMA = "tether-checkpoint-payload@1";
const CHECKPOINT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * 读一份外置 checkpoint 载荷。缺文件 / 无权限 / 解析失败 / schema 不符 / 归属别的会话
 * 都抛错 —— 静默返回空会让撤销悄悄少撤几个文件，比报错危险得多。
 */
async function readCheckpointPayload(id: string, sessionPath?: string): Promise<CheckpointPayload> {
  if (typeof id !== "string" || !CHECKPOINT_ID_PATTERN.test(id))
    throw new Error(`Invalid checkpoint id: ${String(id)}`);
  const file = path.join(getTetherHome(), "checkpoints", `${id}.json`);
  let raw: string;
  try {
    raw = await fsp.readFile(file, "utf8");
  } catch {
    throw new Error(`Checkpoint ${id} is missing from ${file}; it can no longer be restored.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Checkpoint ${id} is corrupt (${file}).`);
  }
  if (!parsed || typeof parsed !== "object" || (parsed as { schema?: unknown }).schema !== CHECKPOINT_PAYLOAD_SCHEMA)
    throw new Error(`Checkpoint ${id} has an unexpected payload schema.`);
  const record = parsed as { sessionFile?: unknown; checkpoint?: unknown };
  if (
    sessionPath &&
    typeof record.sessionFile === "string" &&
    path.basename(record.sessionFile) !== path.basename(sessionPath)
  )
    throw new Error(`Checkpoint ${id} belongs to a different session.`);
  if (!record.checkpoint || typeof record.checkpoint !== "object")
    throw new Error(`Checkpoint ${id} payload has no checkpoint body.`);
  return record.checkpoint as CheckpointPayload;
}

function isWorkspaceItem(value: unknown): value is WorkspaceItem {
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof (value as WorkspaceItem).path === "string" &&
    typeof (value as WorkspaceItem).name === "string" &&
    typeof (value as WorkspaceItem).lastOpenedAt === "string",
  );
}

const WORKSPACE_WATCH_DEBOUNCE_MS = 250;
const WORKSPACE_BURST_WINDOW_MS = 2_000;
// 一个窗口期内超过这个事件量就认定为构建/批量写盘风暴，改为“安静后整体刷新一次”。
const WORKSPACE_BURST_EVENT_LIMIT = 600;
const WORKSPACE_BURST_QUIET_MS = 3_000;
const WORKSPACE_CHANGE_PATH_LIMIT = 500;
const WORKSPACE_WATCH_RETRY_MS = 5_000;

/**
 * 工作区根的 .tetherignore：一行一个模式，`#` 开头为注释。
 * `name` 匹配任意层级的同名文件/目录，`a/b` 匹配相对路径前缀。
 */
async function loadWorkspaceIgnore(root: string): Promise<string[]> {
  try {
    const raw = await fsp.readFile(path.join(root, ".tetherignore"), "utf8");
    return parseWorkspaceIgnore(raw);
  } catch {
    return [];
  }
}

// FSEvents 风暴保护：正常编辑走防抖逐条路径通知，构建期风暴则静默并在安静后整体刷新。
let watchIgnorePatterns: string[] = [];
let watchBurstMode = false;
let watchEventCount = 0;
let watchWindowStart = 0;
let watchPathsTruncated = false;
let watchQuietTimer: ReturnType<typeof setTimeout> | undefined;
let watchRetryTimer: ReturnType<typeof setTimeout> | undefined;
let watchPendingPaths = new Set<string>();

function sendWorkspaceChange(root: string, paths: string[], truncated: boolean): void {
  // 变更后让下一次 list 真正重扫（否则 TTL 缓存会返回过期文件树）
  workspaceListCache = undefined;
  mainWindow?.webContents.send("workspace:changed", { root, paths, truncated });
}

function skipWatch(filename: string | null): boolean {
  return isIgnoredWatchPath(filename, watchIgnorePatterns);
}

function watchWorkspace(root: string): void {
  if (watchedWorkspace === root && workspaceWatcher) return;
  workspaceWatcher?.close();
  workspaceWatcher = undefined;
  watchedWorkspace = root;
  watchIgnorePatterns = [];
  watchBurstMode = false;
  watchEventCount = 0;
  watchWindowStart = 0;
  watchPathsTruncated = false;
  watchPendingPaths = new Set<string>();
  void loadWorkspaceIgnore(root).then((patterns) => {
    if (watchedWorkspace === root) watchIgnorePatterns = patterns;
  });
  try {
    workspaceWatcher = fs.watch(
      root,
      { persistent: false, recursive: true },
      (_event, filename) => {
        if (skipWatch(filename)) return;
        const relative = filename!.replaceAll("\\", "/");
        const now = Date.now();
        if (now - watchWindowStart > WORKSPACE_BURST_WINDOW_MS) {
          watchWindowStart = now;
          watchEventCount = 0;
        }
        watchEventCount += 1;
        if (watchEventCount > WORKSPACE_BURST_EVENT_LIMIT) {
          // 事件风暴：清空待发路径，安静下来后只通知一次“整体刷新”
          watchBurstMode = true;
          watchPendingPaths.clear();
          clearTimeout(watchTimer);
          clearTimeout(watchQuietTimer);
          watchQuietTimer = setTimeout(() => {
            watchBurstMode = false;
            watchEventCount = 0;
            watchPathsTruncated = false;
            sendWorkspaceChange(root, [], true);
          }, WORKSPACE_BURST_QUIET_MS);
          return;
        }
        if (watchBurstMode) return;
        if (watchPendingPaths.size < WORKSPACE_CHANGE_PATH_LIMIT) {
          watchPendingPaths.add(relative);
        } else {
          watchPathsTruncated = true;
        }
        clearTimeout(watchTimer);
        watchTimer = setTimeout(() => {
          const paths = [...watchPendingPaths];
          const truncated = watchPathsTruncated;
          watchPendingPaths.clear();
          watchPathsTruncated = false;
          sendWorkspaceChange(root, paths, truncated);
        }, WORKSPACE_WATCH_DEBOUNCE_MS);
      },
    );
    workspaceWatcher.on("error", () => {
      workspaceWatcher?.close();
      workspaceWatcher = undefined;
      // 监听器自身出错不该让文件面板永久失联：稍后重建一次
      clearTimeout(watchRetryTimer);
      watchRetryTimer = setTimeout(() => {
        if (watchedWorkspace !== root) return;
        watchedWorkspace = "";
        watchWorkspace(root);
      }, WORKSPACE_WATCH_RETRY_MS);
    });
  } catch {
    watchedWorkspace = "";
  }
}

const WORKSPACE_LIST_TTL_MS = 3_000;
const PERF_LOG_LIMIT_BYTES = 10 * 1024 * 1024;
let workspaceListCache: { root: string; at: number; value: string[] } | undefined;
const workspaceListInflight = new Map<string, Promise<string[]>>();

/** 轻量可观测性：只记录真正慢的操作，落在 <Tether home>/perf.log，超过 10MB 轮转一份。 */
function logPerf(message: string): void {
  try {
    const file = path.join(getTetherHome(), "perf.log");
    const stat = fs.statSync(file, { throwIfNoEntry: false });
    if (stat && stat.size > PERF_LOG_LIMIT_BYTES) {
      fs.renameSync(file, `${file}.1`);
    }
  } catch {
    /* 日志失败不影响主流程 */
  }
  try {
    fs.appendFile(
      path.join(getTetherHome(), "perf.log"),
      `${new Date().toISOString()} ${message}\n`,
      () => undefined,
    );
  } catch {
    /* 同上 */
  }
}

/** 目录里带 CACHEDIR.TAG 就是标准缓存目录（rust target 等），一律跳过。 */
/**
 * 文件树列表：TTL 缓存 + 单飞，避免 watcher 事件让多个订阅者同时全量重扫。
 */
async function listWorkspaceFilesCached(root: string): Promise<string[]> {
  const cached = workspaceListCache;
  if (cached && cached.root === root && Date.now() - cached.at < WORKSPACE_LIST_TTL_MS) {
    return cached.value;
  }
  const inflight = workspaceListInflight.get(root);
  if (inflight) return inflight;
  const task = (async () => {
    const startedAt = Date.now();
    const ignore = await loadWorkspaceIgnore(root);
    const value = await listWorkspaceFiles({
      root,
      ignorePatterns: ignore,
      skillRoots: PROJECT_SKILL_ROOTS,
      skillExtras: [".agents/features.json", ".agents/progress.md"],
    });
    workspaceListCache = { root, at: Date.now(), value };
    const elapsed = Date.now() - startedAt;
    if (elapsed > 300) logPerf(`workspace:list ${elapsed}ms entries=${value.length} root=${root}`);
    return value;
  })().finally(() => {
    workspaceListInflight.delete(root);
  });
  workspaceListInflight.set(root, task);
  return task;
}

app.whenReady().then(async () => {
  await initializeTetherHome();
  // 上一次进程若被 SIGKILL（内存压力下 Jetsam 会这么干），before-quit 不会跑，
  // detached 的 rpc-entry 就成了 ppid=1 的孤儿，继续攥着 session.jsonl 和模型连接，
  // 让新会话写不进去（「点了发送没反应」）。启动时先清一遍，只杀 ppid=1 的真孤儿。
  void reapOrphanedAgentHosts(getTetherRpcEntryPath())
    .then((report) => {
      if (report.reaped.length > 0 || report.failed.length > 0)
        logPerf(
          `orphans:reap found=${report.reaped.length} failed=${report.failed.length}` +
            (report.reaped.length > 0 ? ` pids=${report.reaped.map((p) => p.pid).join(",")}` : ""),
        );
    })
    .catch((error) => logPerf(`orphans:reap error=${error instanceof Error ? error.message : error}`));
  await loadLocale();
  void pruneStagedUploads();
  protocol.handle(PREVIEW_SCHEME, servePreview);
  registerIpc();
  installMenu();
  if (process.platform === "darwin") applyDockIcon();
  startMaintenanceTimers();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

let quitting = false;
app.on("before-quit", (event) => {
  if (quitting) return;
  // Always wait for stop on quit (Cmd+Q / Dock → Quit). macOS Seatbelt shells
  // are detached; skipping this leaves orphan `sh -lc` / find / rg processes.
  event.preventDefault();
  quitting = true;
  clearInterval(maintenanceTimer);
  maintenanceTimer = undefined;
  clearTimeout(watchTimer);
  clearTimeout(watchQuietTimer);
  clearTimeout(watchRetryTimer);
  clearTimeout(rendererUnresponsiveTimer);
  workspaceWatcher?.close();
  void Promise.resolve(hostManager?.stopAll())
    .catch(() => undefined)
    .finally(() => app.exit(0));
});
