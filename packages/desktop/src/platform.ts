/**
 * Which windowing backend this app runs on, and the environment that backend needs.
 *
 * ## Why this is a module and not three lines in `main.ts`
 *
 * The choice used to be a hard-coded `--ozone-platform=x11` on the command line, justified by a
 * README line saying "Wayland + Vulkan does not start". That justification was wrong on both
 * halves, and the cost was invisible: an **XWayland** client cannot use Wayland's input-method
 * protocol, so fcitx reached it only through the reduced `dbus`/XIM path, and the user's input
 * method skin never appeared (found.md F-126).
 *
 * Measured on Electron 45.2.3 / Chromium 156 / niri 26.04, native Wayland starts normally and is
 * fully accelerated — `gpu_compositing`, `rasterization`, `2d_canvas` and `webgl` all
 * `enabled`, Mesa Intel Iris Xe, 120 rAF frames in 2 s at a 17 ms median. Vulkan is disabled in
 * *both* modes, so it was never a reason to avoid Wayland. And native Wayland is the only mode in
 * which the app reaches fcitx over `zwp_text_input_v3`, which is what draws the composition
 * window (found.md F-127).
 *
 * So the platform is now **decided from the environment** and testable without launching
 * anything.
 */

/** The backends Electron can be told to use. `null` leaves Electron's own default alone. */
export type OzonePlatform = "wayland" | "x11" | null;

/** The parts of the environment the decision depends on. Injected so tests need no real session. */
export interface SessionEnv {
  readonly sessionType?: string | undefined;
  readonly waylandDisplay?: string | undefined;
  readonly display?: string | undefined;
  /** An explicit `--ozone-platform=…` on the command line, if the user gave one. */
  readonly requested?: string | undefined;
}

/** A non-empty environment variable, treating blank as unset. */
function present(value: string | undefined): value is string {
  return (value ?? "").trim() !== "";
}

/**
 * Read a `--ozone-platform=<value>` the user put on the command line.
 *
 * A user's explicit flag **always** wins. Guessing over a deliberate choice is how a windowing
 * backend gets broken in a way nobody can reproduce.
 */
export function requestedPlatform(argv: readonly string[]): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    const prefix = "--ozone-platform=";
    if (arg.startsWith(prefix)) {
      const value = arg.slice(prefix.length).trim();
      return value === "" ? undefined : value;
    }
    if (arg === "--ozone-platform") {
      const value = (argv[index + 1] ?? "").trim();
      // A following flag is not a value: `--ozone-platform --no-sandbox` names no backend.
      return value === "" || value.startsWith("-") ? undefined : value;
    }
  }
  return undefined;
}

/**
 * Choose the backend.
 *
 * Preference order:
 *
 * 1. the user's own flag, untouched;
 * 2. **Wayland** when a Wayland display is actually reachable — this is the mode that gives the
 *    input method its native protocol;
 * 3. **X11** when only `DISPLAY` exists (X11 session, or a remote/older setup);
 * 4. `null` when neither is present, so Electron can decide instead of being told a lie.
 */
export function chooseOzonePlatform(env: SessionEnv): OzonePlatform {
  if (present(env.requested)) return null;
  if (present(env.waylandDisplay)) return "wayland";
  if (present(env.display)) return "x11";
  return null;
}

/**
 * Whether this backend is an **XWayland** client.
 *
 * The distinction matters for exactly one thing: input method plumbing. An XWayland client on a
 * Wayland session is not a Wayland client, and it cannot join the Wayland text-input protocol.
 */
export function isXwayland(platform: OzonePlatform, env: SessionEnv): boolean {
  return platform === "x11" && present(env.waylandDisplay);
}

/** Environment variables this app should add for the input method. */
export type EnvPatch = Readonly<Record<string, string>>;

/**
 * The input-method environment the chosen backend needs, as the variables to **add**.
 *
 * ## X11 / XWayland: XIM is the only road
 *
 * An XWayland client cannot use Wayland's `zwp_text_input_v3`, so fcitx is reached over XIM,
 * selected by `XMODIFIERS`. Without it GTK falls back to its built-in simple context: characters
 * arrive, but the composition window is drawn by GTK instead of fcitx — "it types, but the skin
 * is wrong" (found.md F-126).
 *
 * ## Native Wayland: add **nothing**
 *
 * The text-input protocol is negotiated by the toolkit. Setting `GTK_IM_MODULE` here actively
 * hurts: measured with fcitx's own input-context list, forcing `GTK_IM_MODULE=fcitx5` on a native
 * Wayland window left the app's input context at `focus:0`, while the untouched environment
 * reached `focus:1` over `wayland_v2`. Overriding a working path because it "looks like it should
 * help" is exactly the mistake this function now refuses to make.
 *
 * Only variables the environment does **not** already set are added.
 */
export function inputMethodEnvPatch(
  platform: OzonePlatform,
  env: SessionEnv,
  current: Readonly<Record<string, string | undefined>>,
): EnvPatch {
  if (!isXwayland(platform, env)) return {};

  const patch: Record<string, string> = {};
  if (!present(current["XMODIFIERS"])) patch["XMODIFIERS"] = "@im=fcitx";
  // GTK3/GTK4 ship `im-fcitx5.so`; plain `fcitx` is the GTK2 name and silently does nothing.
  if (!present(current["GTK_IM_MODULE"])) patch["GTK_IM_MODULE"] = "fcitx5";
  return patch;
}
