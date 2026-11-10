/**
 * Electron main process entry point.
 *
 * Its responsibilities are deliberately narrow:
 * - decide which project to open (command-line argument / directory picker);
 * - start two backends (Hyperframes preview and our own app server);
 * - create one window pointed at the app server.
 *
 * All the business logic (Studio, annotations, prompts) lives in the renderer. The
 * main process is a quiet host, which keeps failures easy to locate: a blank window
 * is a host problem, wrong behaviour is a frontend problem.
 */

import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import type { HostConfig } from "@mystudio/protocol";
import { FileOutboxSink } from "@mystudio/protocol/node";
import type { PromptSink } from "@mystudio/protocol";
import { startAppServer, type StartedServer } from "./appServer.js";
import { SubscribedSink } from "./subscribedSink.js";
import { newAppId, publishAppPresence, type PresenceHandle } from "./presence.js";
import { startPreviewServer, type PreviewServer } from "./previewServer.js";
import { detectProject, explainDetectFailure } from "./project.js";
import { discoverProjects } from "./discovery.js";
import { chooseOzonePlatform, inputMethodEnvPatch, requestedPlatform } from "./platform.js";
import { projectFromArgv as projectArgv } from "./projectArgv.js";
import {
  DEFAULT_WINDOW_HEIGHT,
  DEFAULT_WINDOW_WIDTH,
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
} from "./windowSize.js";

/**
 * The plugin's default inbox port.
 *
 * Only used for the informational `inboxEndpoint` in the host config now that delivery goes
 * to subscribers, whose real endpoints arrive with each subscription: a plugin that had to
 * take the next free port (two OpenCode servers) is still reachable.
 */
const DEFAULT_INBOX = "http://127.0.0.1:47812";

interface Running {
  readonly server: StartedServer;
  readonly preview: PreviewServer;
  readonly config: HostConfig;
  /** Presence record; removed when this project is torn down. */
  readonly presence: PresenceHandle;
}

let running: Running | null = null;
let mainWindow: BrowserWindow | null = null;

function studioDir(): string {
  // After packaging, dist/studio sits next to dist/main.js; in development we probe
  // the studio-shell build output.
  return join(app.getAppPath(), "dist", "studio");
}

/**
 * The project named on the command line, or `null`.
 *
 * The decision itself lives in `projectArgv.ts` because it has to be testable: this module
 * imports `electron`, and an untestable argument parser is how the same defect shipped twice
 * (found.md F-131). Here it is only wired to what Electron knows.
 */
function projectFromArgv(argv: readonly string[] = process.argv): string | null {
  return projectArgv(argv, { appPath: app.getAppPath() });
}

/**
 * Ask the user for a directory and resolve it to **one** project.
 *
 * The picked path may be a project itself or a folder full of them, so the result of
 * `discoverProjects` decides what happens next:
 * - a project → open it;
 * - a collection → ask which one (opening an arbitrary member would be guessing);
 * - nothing → say so with the count, instead of a bare "not a project".
 */
async function chooseProjectDir(): Promise<string | null> {
  const picked = await dialog.showOpenDialog({
    title: "Choose a Hyperframes project, or a folder containing projects",
    properties: ["openDirectory"],
    buttonLabel: "Open",
  });
  if (picked.canceled || picked.filePaths.length === 0) return null;
  const root = picked.filePaths[0];
  if (!root) return null;

  const discovery = await discoverProjects(root);

  if (discovery.kind === "project") return discovery.project.dir;

  if (discovery.kind === "collection") {
    /*
     * Several projects: ask, do not guess.
     *
     * Picking one silently would open something the user did not choose and leave them
     * unsure whether they clicked the wrong folder.
     */
    const choice = await dialog.showMessageBox({
      type: "question",
      title: "Choose a project",
      message: `${discovery.projects.length} projects found in this folder`,
      detail: discovery.projects.map((project) => project.name).join("\n"),
      buttons: [...discovery.projects.map((project) => project.name), "Cancel"],
      cancelId: discovery.projects.length,
      noLink: true,
    });
    const chosen = discovery.projects[choice.response];
    return chosen ? chosen.dir : null;
  }

  if (discovery.kind === "empty") {
    await dialog.showMessageBox({
      type: "info",
      title: "No Hyperframes project found",
      message: "Nothing in this folder looks like a Hyperframes project.",
      detail:
        `Looked at ${discovery.scanned} subfolder(s).\n\n` +
        "A project needs an index.html plus a hyperframes.json or package.json. " +
        "Pick the project folder itself, or a folder whose subfolders are projects.",
    });
    return null;
  }

  await dialog.showMessageBox({
    type: "warning",
    title: "Not a folder",
    message: `${root} is not a directory.`,
  });
  return null;
}

async function openProject(dir: string): Promise<Running> {
  console.error(`[mystudio] Checking project ${dir}`);
  const detected = await detectProject(dir);
  if (!detected.ok) {
    throw new Error(explainDetectFailure(detected.reason));
  }
  const project = detected.project;
  console.error(`[mystudio] Project ready: ${project.name}`);

  // Annotation artefacts live inside the project so they travel with it — copying
  // the directory keeps them.
  const runtimeDir = join(project.dir, ".mystudio");
  await mkdir(runtimeDir, { recursive: true });

  /*
   * Delivery goes to **subscribers**, so the app needs an identity of its own.
   *
   * The id is per launch, not per project: two windows may open the same project, and a
   * conversation subscribing to one of them must not silently receive the other's
   * annotations.
   */
  const appId = newAppId();
  const outbox = new FileOutboxSink({ dir: join(runtimeDir, "outbox") });
  const sink: PromptSink = new SubscribedSink({ appId, projectDir: project.dir, outbox });

  console.error(`[mystudio] Starting the preview service…`);
  const preview = await startPreviewServer({ projectDir: project.dir });
  console.error(`[mystudio] Preview service at ${preview.origin}`);
  const config: HostConfig = {
    schemaVersion: 1,
    projectId: project.name,
    projectName: project.name,
    projectDir: project.dir,
    inboxEndpoint: process.env.MYSTUDIO_INBOX ?? DEFAULT_INBOX,
    previewOrigin: preview.origin,
  };

  console.error(`[mystudio] Starting the app server, Studio build: ${studioDir()}`);
  const server = await startAppServer({
    studioDir: studioDir(),
    previewOrigin: preview.origin,
    config,
    sink,
    appId,
    framesDir: join(runtimeDir, "frames"),
    onQuit: () => app.quit(),
    onOpenProject: () => switchProject(),
  });
  console.error(`[mystudio] App server at ${server.url}`);

  /*
   * Advertise the app **after** the port is known: the endpoint is what the plugin posts
   * to, and the port may differ from the preferred one.
   */
  const presence = await publishAppPresence({
    appId,
    projectDir: project.dir,
    projectName: project.name,
    endpoint: server.url,
  });
  console.error(`[mystudio] Advertised as ${appId} for ${project.name}`);

  return { server, preview, config, presence };
}

async function stopProject(target: Running | null): Promise<void> {
  if (!target) return;
  // Withdraw first: a subscriber must stop being offered an app that cannot answer.
  await target.presence.stop().catch(() => undefined);
  await target.server.close().catch(() => undefined);
  await target.preview.stop().catch(() => undefined);
}

/**
 * Whether Electron should draw its own window buttons (− □ ×).
 *
 * Tiling Wayland compositors such as niri / Hyprland **manage window borders, titles
 * and buttons themselves**; drawing another set produces the screenshot-worthy mess
 * of "system buttons plus app buttons", partly clipped by the compositor too.
 *
 * The decision is based on XDG_CURRENT_DESKTOP / WAYLAND_DISPLAY, with an environment
 * override to reproduce issues in an X11 session.
 *
 * Note: `titleBarOverlay` only differs by platform from Electron 43 onward; it is
 * disabled explicitly here so the window degenerates into a frameless content area
 * and the compositor decides the look.
 */
function wantsNativeWindowButtons(): boolean {
  const forced = process.env.MYSTUDIO_WINDOW_BUTTONS;
  if (forced === "1") return true;
  if (forced === "0") return false;

  // Tiling Wayland compositor: buttons come from the compositor, the app must not draw them.
  const isWayland = Boolean(process.env.WAYLAND_DISPLAY);
  const desktop = (process.env.XDG_CURRENT_DESKTOP ?? "").toLowerCase();
  const isTiling = /niri|hyprland|sway|river|wayfire/.test(desktop);
  return !(isWayland || isTiling);
}

async function createWindow(url: string): Promise<BrowserWindow> {
  const nativeButtons = wantsNativeWindowButtons();

  const win = new BrowserWindow({
    width: DEFAULT_WINDOW_WIDTH,
    height: DEFAULT_WINDOW_HEIGHT,
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    backgroundColor: "#0a0a0a",
    // Frameless: the content (Studio plus our own header) reaches the window edge.
    // Whether to also draw − □ × is decided by wantsNativeWindowButtons() — on a
    // tiling desktop like niri it must not, because the compositor does window
    // management there.
    titleBarStyle: "hidden",
    ...(nativeButtons
      ? { titleBarOverlay: { color: "#0a0a0a", symbolColor: "#e5e5e5", height: 36 } }
      : {}),
    webPreferences: {
      // Node integration stays off by default: Studio is upstream code and gets no privileges.
      nodeIntegration: false,
      contextIsolation: true,
      // Studio and preview are both proxy-served same-origin by this process on
      // loopback, so the sandbox can stay on.
      sandbox: true,
    },
  });

  // External links go to the system browser instead of opening a new window in-app.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    void shell.openExternal(target);
    return { action: "deny" };
  });

  await win.loadURL(url);
  return win;
}

/**
 * Switch to a different project chosen through the in-app dialog.
 *
 * The old project must be torn down **before** the new one starts: two preview services
 * for two projects would leave the first one running behind a window that no longer
 * shows it, and the CLI refuses a second service on a project that already has one.
 *
 * The window is loaded afresh rather than re-rendered: Studio is a whole app with its
 * own stores and iframe; asking it to swap projects in place is not something it
 * supports, and a reload is the honest implementation.
 */
async function switchProject(): Promise<{ ok: boolean; error?: string; cancelled?: boolean }> {
  let dir: string | null;
  try {
    dir = await chooseProjectDir();
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }
  if (!dir) return { ok: false, cancelled: true };

  try {
    await stopProject(running);
    running = null;

    const started = await openProject(dir);
    running = started;

    if (mainWindow) {
      await mainWindow.loadURL(started.server.url);
    } else {
      mainWindow = await createWindow(started.server.url);
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }
}

async function boot(projectDir: string | null): Promise<void> {
  let dir = projectDir;
  if (!dir) dir = await chooseProjectDir();
  if (!dir) {
    app.quit();
    return;
  }

  const started = await openProject(dir);
  running = started;
  mainWindow = await createWindow(started.server.url);
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

/**
 * Tell Electron which windowing backend to use, and give the input method what that backend needs.
 *
 * ## The correction this replaces
 *
 * The app used to force `--ozone-platform=x11` because "Wayland + Vulkan does not start". Measured
 * on Electron 45.2.3 / Chromium 156 / niri 26.04, that is false: native Wayland starts normally and
 * is fully accelerated (`gpu_compositing`, `rasterization`, `2d_canvas` and `webgl` all enabled;
 * Mesa Intel Iris Xe; 120 rAF frames in 2 s at a 17 ms median). Vulkan is disabled in **both**
 * modes, so it was never the obstacle.
 *
 * Forcing X11 was not neutral, though. It made this an **XWayland** client, which cannot use
 * Wayland's text-input protocol, so fcitx could only reach it through the reduced XIM path — and
 * the user's input method skin never appeared (found.md F-126, F-127).
 *
 * ## The rule
 *
 * The backend now comes from the environment (`platform.ts`, fully unit-tested), and the
 * input-method variables are only added for the mode that actually needs them. Both are computed
 * before `whenReady`, because GTK reads them when the toolkit initialises.
 */
const sessionEnv = {
  sessionType: process.env["XDG_SESSION_TYPE"],
  waylandDisplay: process.env["WAYLAND_DISPLAY"],
  display: process.env["DISPLAY"],
  requested: requestedPlatform(process.argv),
};
const ozonePlatform = chooseOzonePlatform(sessionEnv);
if (ozonePlatform) {
  app.commandLine.appendSwitch("ozone-platform", ozonePlatform);
}
for (const [name, value] of Object.entries(
  inputMethodEnvPatch(ozonePlatform, sessionEnv, process.env),
)) {
  process.env[name] = value;
}


/** Only the first instance works; a second forwards its directory and exits. */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", async (_event, argv) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
      return;
    }
    const dir = projectFromArgv(argv);
    if (dir) {
      await stopProject(running);
      running = null;
      try {
        const started = await openProject(dir);
        running = started;
        mainWindow = await createWindow(started.server.url);
      } catch (error) {
        await dialog.showErrorBox("Failed to open", describeError(error));
      }
    }
  });

  void app.whenReady().then(async () => {
    ipcMain.handle("mystudio:project-dir", () => running?.config.projectDir ?? null);

    try {
      await boot(projectFromArgv());
    } catch (error) {
      await dialog.showErrorBox("MyStudio could not start", describeError(error));
      app.quit();
    }

    app.on("activate", async () => {
      if (BrowserWindow.getAllWindows().length > 0) return;
      if (running) {
        mainWindow = await createWindow(running.server.url);
      }
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", () => {
    void stopProject(running);
    running = null;
  });
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
