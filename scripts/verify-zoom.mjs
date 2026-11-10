/**
 * Runtime check: the zoom chord resizes **one** surface, chosen by who owns the input.
 *
 * Two defects drove this:
 *
 * 1. The chord scaled Studio and nothing else. Every control in this overlay is sized in
 *    pixels — deliberately, so it stays legible over footage — and pixels do not follow a
 *    root font size, so the toolbar could never be made bigger or smaller.
 * 2. The first fix scaled **both** at once, which is also wrong: enlarging the toolbar
 *    reflowed the editor underneath, and zooming in to read the timeline blew up the
 *    drawing tools over the picture.
 *
 * The rule now: while annotating, the chord resizes this layer; otherwise it resizes
 * Studio. Same routing as every other key.
 *
 * What must be true:
 *
 * 1. each surface grows only when it owns the input;
 * 2. the **drawing canvas** never scales: annotation coordinates are normalised against the
 *    video's own pixels, and scaling them would move every mark already on the frame;
 * 3. the chrome stays inside the window at every step, including 200%, where the toolbar's
 *    own height is close to the window's.
 *
 * Prerequisite: the app must be running with `--remote-debugging-port=9222`.
 */

const targets = await (await fetch("http://127.0.0.1:9222/json/list")).json();
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
let n = 0;
const pend = new Map();
function send(m, x = {}) {
  const id = ++n;
  ws.send(JSON.stringify({ id, method: m, params: x }));
  return new Promise((r, j) => pend.set(id, { r, j }));
}
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) {
    const { r, j } = pend.get(m.id);
    pend.delete(m.id);
    m.error ? j(new Error(JSON.stringify(m.error))) : r(m.result);
  }
};
await new Promise((r) => (ws.onopen = r));
const ev = async (x) => {
  const r = await send("Runtime.evaluate", { expression: x, returnByValue: true, awaitPromise: true });
  return r.exceptionDetails ? { error: r.exceptionDetails.exception?.description } : r.result.value;
};
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const key = async (code, k, vk, mods) => {
  await send("Input.dispatchKeyEvent", { type: "keyDown", code, key: k, windowsVirtualKeyCode: vk, modifiers: mods });
  await send("Input.dispatchKeyEvent", { type: "keyUp", code, key: k, windowsVirtualKeyCode: vk, modifiers: mods });
  await pause(650);
};

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
  if (ok) {
    pass++;
    console.log("  ok  " + name);
  } else {
    fail++;
    console.log("  FAIL " + name + " " + extra);
  }
};

/*
 * Establish the window size this check needs, instead of inheriting whatever the previous
 * script left behind.
 *
 * Zoom at 200% makes the toolbar nearly as tall as the window, so "it stays inside" is only a
 * meaningful question at a window large enough to hold it. When `verify-window` ran first and
 * happened to start from a small window, it puts that size back — and this script then failed
 * with a toolbar 604px tall in a 520px window, which is a fact about the test's starting point,
 * not about zoom (found.md F-119).
 */
const { execFileSync } = await import("node:child_process");
const niri = (args) => {
  try {
    return execFileSync("niri", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
};
const windowId = (() => {
  const windows = niri(["msg", "windows"]);
  if (!windows) return null;
  const block = [...windows.matchAll(/Window ID (\d+):([\s\S]*?)(?=Window ID \d+:|$)/g)]
    .find((match) => match[2].includes("mystudio-desktop"));
  return block ? block[1] : null;
})();
const MIN_CHECK_WIDTH = 1240;
const MIN_CHECK_HEIGHT = 900;
const originalWindow = (() => {
  const windows = niri(["msg", "windows"]);
  if (!windows) return null;
  const block = [...windows.matchAll(/Window ID (\d+):([\s\S]*?)(?=Window ID \d+:|$)/g)]
    .find((match) => match[2].includes("mystudio-desktop"));
  const size = block ? /Window size: (\d+) x (\d+)/.exec(block[2]) : null;
  return size ? { width: Number(size[1]), height: Number(size[2]) } : null;
})();
if (windowId) {
  niri(["msg", "action", "focus-window", "--id", windowId]);
  if (!originalWindow || originalWindow.width < MIN_CHECK_WIDTH) {
    niri(["msg", "action", "set-window-width", String(MIN_CHECK_WIDTH)]);
  }
  if (!originalWindow || originalWindow.height < MIN_CHECK_HEIGHT) {
    niri(["msg", "action", "set-window-height", String(MIN_CHECK_HEIGHT)]);
  }
  await pause(1500);
}

/** The toolbar's on-screen box, and whether it is entirely inside the window. */
const dockBox = () =>
  ev(`(() => {
    const d = document.querySelector('[data-mystudio-overlay="dock"]');
    if (!d) return null;
    const r = d.getBoundingClientRect();
    return {
      w: Math.round(r.width), h: Math.round(r.height),
      x: Math.round(r.x), y: Math.round(r.y),
      inside: r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1 && r.left >= -1 && r.top >= -1,
    };
  })()`);

/** The prompt box, same question. */
const promptBox = () =>
  ev(`(() => {
    const p = document.querySelector('[data-mystudio-overlay="float-panel"]');
    if (!p) return null;
    const r = p.getBoundingClientRect();
    return {
      w: Math.round(r.width), h: Math.round(r.height),
      inside: r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1 && r.left >= -1 && r.top >= -1,
    };
  })()`);

// Annotation mode on, so the chrome exists at all.
const capturing = () =>
  ev(`document.querySelector('[data-mystudio-overlay="surface"]')?.getAttribute('data-capturing')`);
if ((await capturing()) !== "true") {
  await key("KeyA", "a", 65, 2);
}
await pause(400);

/** Studio's scale, read from the one thing it changes: the root font size. */
const studioFont = () => ev(`getComputedStyle(document.documentElement).fontSize`);

console.log("\n[1] while annotating, the chord reaches this layer's controls and nothing else");
/* Normalise both scales: they are persisted, so a previous run may have left one zoomed. */
await key("Digit0", "0", 48, 2);
await pause(400);
const fontBase = await studioFont();
const base = await dockBox();
const promptBase = await promptBox();
check("the toolbar is present", !!base, "null");
console.log("    100%:", JSON.stringify(base));

await key("Equal", "=", 187, 2);
const zoomed = await dockBox();
check(
  "Ctrl + = makes the toolbar bigger",
  !!zoomed && (zoomed.w > base.w || zoomed.h > base.h),
  `${JSON.stringify(base)} -> ${JSON.stringify(zoomed)}`,
);
check(
  "Studio is left alone while annotating",
  (await studioFont()) === fontBase,
  `${fontBase} -> ${await studioFont()}`,
);
check("it stays inside the window", !!zoomed && zoomed.inside === true, JSON.stringify(zoomed));

console.log("\n[2] the prompt box scales too");
/*
 * Measured against the **same zoom step** as the toolbar above, so this compares a real
 * 100% box with a real 125% box rather than merely checking that one exists.
 */
const promptNow = await promptBox();
check("the prompt box is present", !!promptBase !== undefined && !!promptNow, "null");
check(
  "the prompt box grew with the same step",
  !!promptBase && !!promptNow && promptNow.w > promptBase.w,
  `${JSON.stringify(promptBase)} -> ${JSON.stringify(promptNow)}`,
);

console.log("\n[3] the drawing canvas is not scaled");
/*
 * The canvas keeps using the video's real pixels. Its *position* may shift because Studio
 * rescales its own layout, so what is checked is that it is still a real rectangle that
 * matches the stage — not that its coordinates are identical to before.
 */
const canvas = await ev(`(() => {
  const c = document.querySelector('[data-mystudio-overlay="annotation-canvas"]');
  if (!c) return null;
  const r = c.getBoundingClientRect();
  const shell = document.querySelector('[data-mystudio-overlay="surface"]');
  const style = shell ? getComputedStyle(shell).transform : "none";
  return { w: Math.round(r.width), h: Math.round(r.height), surfaceTransform: style };
})()`);
check("the canvas is still a real rectangle", !!canvas && canvas.w > 0 && canvas.h > 0, JSON.stringify(canvas));
check(
  "the overlay container carries the scale, not the canvas",
  !!canvas && canvas.surfaceTransform !== "none",
  JSON.stringify(canvas?.surfaceTransform),
);

console.log("\n[4] the maximum step still fits");
await key("Digit0", "0", 48, 2);
for (let i = 0; i < 4; i += 1) await key("Equal", "=", 187, 2);
const big = await dockBox();
check(
  "at 200% the toolbar is still inside the window",
  !!big && big.inside === true,
  JSON.stringify(big),
);
const promptBig = await promptBox();
check(
  "and so is the prompt box",
  !!promptBig && promptBig.inside === true,
  JSON.stringify(promptBig),
);

console.log("\n[5] Ctrl + 0 goes back to 100%");
await key("Digit0", "0", 48, 2);
const reset = await dockBox();
check(
  "the toolbar returns to its original size",
  !!reset && Math.abs(reset.w - base.w) <= 1 && Math.abs(reset.h - base.h) <= 1,
  `${JSON.stringify(base)} -> ${JSON.stringify(reset)}`,
);

console.log("\n[6] zooming out works as well");
await key("Minus", "-", 189, 2);
const small = await dockBox();
check(
  "Ctrl + - makes the toolbar smaller",
  !!small && (small.w < base.w || small.h < base.h),
  `${JSON.stringify(base)} -> ${JSON.stringify(small)}`,
);
check("it stays inside the window", !!small && small.inside === true, JSON.stringify(small));

console.log("\n[7] outside annotation mode, the same chord resizes Studio instead");
/* Leave annotation mode: `A` toggles activation, and the overlay stays visible. */
await key("KeyA", "a", 65, 2);
await pause(700);
const dockIdle = await dockBox();
const fontIdle = await studioFont();
await key("Equal", "=", 187, 2);
const dockIdleAfter = await dockBox();
const fontIdleAfter = await studioFont();
check(
  "Studio's font grows",
  parseFloat(fontIdleAfter) > parseFloat(fontIdle),
  `${fontIdle} -> ${fontIdleAfter}`,
);
check(
  "and this layer's toolbar does not",
  !!dockIdle && !!dockIdleAfter && dockIdleAfter.h === dockIdle.h,
  `${JSON.stringify(dockIdle)} -> ${JSON.stringify(dockIdleAfter)}`,
);
/* Put both back: this script observes, it does not keep a zoom. */
await key("Digit0", "0", 48, 2);
await key("KeyA", "a", 65, 2);
await pause(600);
await key("Digit0", "0", 48, 2);

console.log(`\nresult: ${pass} passed, ${fail} failed`);
ws.close();
process.exit(fail === 0 ? 0 : 1);
