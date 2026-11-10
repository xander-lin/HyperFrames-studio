/**
 * Runtime check: the app is usable in the window it is actually in.
 *
 * ## It must not fake the window size
 *
 * An earlier version used CDP's `Emulation.setDeviceMetricsOverride` to shrink the
 * *renderer viewport* and measured the layout inside it. That is not the same thing as the
 * window being small: it shrinks the page while the OS window stays put, so the app draws
 * small in a corner with black around it. And because a failed run never reached the
 * cleanup, that state **outlived the test** — the user was left with a window that looked
 * broken.
 *
 * So this script:
 *
 * 1. **clears any override it finds on start**, restoring a window left broken by an
 *    earlier run;
 * 2. never sets one itself;
 * 3. runs its work in `try/finally` so nothing it did can survive it.
 *
 * ## What it checks
 *
 * The size *values* are unit-tested, because they are pure arithmetic:
 * `desktop/src/windowSize.test.ts` pins the window minimum, `dockLayout.test.ts` pins the
 * floors that must fit inside it.
 *
 * What only a running app can answer is whether a **real** window draws its overlays inside
 * itself. When `niri` is available this asks the compositor to resize the actual window —
 * what the user does — and measures after each size, then puts the window back.
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

/** Leave the renderer at its real window size, whatever a previous run did to it. */
async function clearViewportOverride() {
  try {
    await send("Emulation.clearDeviceMetricsOverride");
  } catch {
    // Nothing was set; that is the normal case.
  }
}

await clearViewportOverride();
await pause(400);

/*
 * The truth about the window's size.
 *
 * `outerWidth` cannot answer this. On Wayland a client is not told how large the compositor made
 * its window, so Electron **estimates** a frame: a 954 × 1072 client reported `outerWidth` 974 in
 * every mode we measured. Comparing `innerWidth === outerWidth` therefore fails on native Wayland
 * even though the layout is completely correct (`bad: []`) — it measures the estimate, not the
 * window.
 *
 * The compositor does know, so ask it. `niri msg windows` reports the real size, and it matched
 * `innerWidth` in both modes (954 × 1072 in each). When niri is absent, fall back to the old
 * comparison and say so rather than silently claiming a stronger check.
 */
const { execFileSync } = await import("node:child_process");
const niri = (args) => {
  try {
    return execFileSync("niri", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
};

/** The compositor's view of this window: `{ width, height }` of the app's tile. */
function compositorWindowSize() {
  const windows = niri(["msg", "windows"]);
  if (!windows) return null;
  const block = [...windows.matchAll(/Window ID (\d+):([\s\S]*?)(?=Window ID \d+:|$)/g)]
    .find((match) => match[2].includes("mystudio-desktop"));
  if (!block) return null;
  const size = /Window size: (\d+) x (\d+)/.exec(block[2]);
  if (!size) return null;
  return { id: block[1], width: Number(size[1]), height: Number(size[2]) };
}

const compositorSize = compositorWindowSize();

/** How far a real window may drift from the size it was asked for before it counts as wrong. */
const SIZE_TOLERANCE = 2;

/**
 * Assert the page is the size of its window.
 *
 * This is what the old `innerWidth === outerWidth` check was reaching for: a device-metrics
 * override shrinks the page while the OS window stays put, leaving the app drawn small in a
 * corner. Comparing against the compositor's size catches exactly that, on both backends.
 */
function pageMatchesWindow(state, expected) {
  if (state.bad.length > 0) return false;
  if (expected) {
    return (
      Math.abs(state.iw - expected.width) <= SIZE_TOLERANCE &&
      Math.abs(state.ih - expected.height) <= SIZE_TOLERANCE
    );
  }
  // No compositor to ask: the best available signal is the window's own estimate.
  return state.iw === state.ow && state.ih === state.oh;
}

{
  const firstLook = await ev(`(() => {
    const bad = [];
    for (const el of document.querySelectorAll('[data-mystudio-overlay]')) {
      const ov = el.getAttribute('data-mystudio-overlay');
      if (ov === 'shield' || ov === 'surface' || ov === 'sprite') continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.right > innerWidth + 1 || r.bottom > innerHeight + 1 || r.left < -1 || r.top < -1) {
        bad.push({ ov, x: Math.round(r.x), y: Math.round(r.y) });
      }
    }
    return { iw: innerWidth, ih: innerHeight, ow: outerWidth, oh: outerHeight, bad };
  })()`);
  check(
    "the page is the size of its window",
    pageMatchesWindow(firstLook, compositorSize),
    JSON.stringify({ ...firstLook, compositorSize }),
  );
  if (compositorSize) {
    console.log(
      `    page ${firstLook.iw}x${firstLook.ih}, window ${compositorSize.width}x${compositorSize.height}` +
        ` (outerWidth reads ${firstLook.ow} — Electron's estimate, not a measurement)`,
    );
  } else {
    console.log("  --  no compositor to ask; compared against outerWidth, which Wayland cannot answer");
  }
}

try {
  // Annotation mode on, so the floating panels exist and are measurable.
  const isCapturing = () =>
    ev(`document.querySelector('[data-mystudio-overlay="surface"]')?.getAttribute('data-capturing')`);
  if ((await isCapturing()) !== "true") {
    await send("Input.dispatchKeyEvent", { type: "keyDown", code: "KeyA", key: "a", windowsVirtualKeyCode: 65, modifiers: 2 });
    await send("Input.dispatchKeyEvent", { type: "keyUp", code: "KeyA", key: "a", windowsVirtualKeyCode: 65, modifiers: 2 });
    await pause(900);
  }
  if ((await isCapturing()) !== "true") {
    console.log("  FAIL annotation mode is on (needed for the following checks)");
    throw new Error("annotation mode unavailable");
  }

  /**
   * Wait for the layout to stop changing.
   *
   * Dockview re-lays-out asynchronously, so measuring right after a resize can read the
   * *previous* geometry — which looks exactly like an overflow (the numbers equal the old
   * width minus the new one). A genuine overflow never settles, so waiting cannot hide one.
   */
  const settled = async () => {
    let last = null;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const info = await ev(`(() => {
        const groups = [...document.querySelectorAll('.dv-groupview')].map((g) => {
          const r = g.getBoundingClientRect();
          return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y) };
        });
        const right = Math.max(...groups.map((g) => g.x + g.w));
        const bottom = Math.max(...groups.map((g) => g.y + g.h));
        const bad = [];
        for (const el of document.querySelectorAll('[data-mystudio-overlay]')) {
          const ov = el.getAttribute('data-mystudio-overlay');
          // The shield and canvas are full-viewport by design. The sprite is a tab that
          // deliberately peeks a few pixels out of the edge so it can be grabbed.
          if (ov === 'shield' || ov === 'surface' || ov === 'sprite') continue;
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          if (r.right > innerWidth + 1 || r.bottom > innerHeight + 1 || r.left < -1 || r.top < -1) {
            bad.push({ ov, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) });
          }
        }
        return {
          vw: innerWidth, vh: innerHeight, groups: groups.length,
          overflowR: right - innerWidth, overflowB: bottom - innerHeight,
          bad, sig: groups.map((g) => g.w + 'x' + g.h).join(','),
        };
      })()`);
      if (last && info.sig === last.sig) return info;
      last = info;
      await pause(150);
    }
    return last;
  };

  console.log("\n[1] every overlay is inside the real window");
  const info = await settled();
  console.log(`    window: ${info.vw}x${info.vh}`);
  check("every overlay fits", info.bad.length === 0, JSON.stringify(info.bad));
  check(
    "dock columns stay inside the window",
    info.groups > 0 && info.overflowR <= 0 && info.overflowB <= 0,
    JSON.stringify({ overflowR: info.overflowR, overflowB: info.overflowB }),
  );

  console.log("\n[2] the same is true when the real window shrinks");
  /*
   * Resize the **actual window** through the compositor, which is what the user does. The
   * alternative — CDP's device-metrics override — is forbidden here (see the header).
   */
  /*
   * The size the page ends up with is read back from the compositor instead of assumed to equal
   * the size requested: a tiling compositor may adjust what it was asked for, and comparing
   * against the request would then blame the layout for the compositor's decision.
   */
  const appWid = compositorSize?.id;

  if (!appWid) {
    console.log("  --  niri not available; resize the window by hand and re-run");
  } else {
    const originalSize = compositorSize;
    niri(["msg", "action", "focus-window", "--id", appWid]);
    try {
      for (const [width, height] of [[760, 520], [560, 400], [420, 340]]) {
        niri(["msg", "action", "set-window-width", String(width)]);
        niri(["msg", "action", "set-window-height", String(height)]);
        /*
         * Wait for the **compositor** to report the new size before measuring the page.
         *
         * A fixed pause is a guess at how long a tiling compositor needs, and when it guesses
         * short the script measures the *previous* size: `actual` is still the old height while
         * `innerWidth` has already changed, which reads as an overflow in the layout. That is a
         * race in the probe, not a defect in the app (found.md F-119).
         */
        const settledOn = async (wantW, wantH) => {
          const started = Date.now();
          for (;;) {
            const size = compositorWindowSize();
            if (size && Math.abs(size.width - wantW) <= SIZE_TOLERANCE && Math.abs(size.height - wantH) <= SIZE_TOLERANCE) {
              // One more frame for the page to re-lay-out inside the new window.
              await pause(500);
              return true;
            }
            if (Date.now() - started > 8000) return false;
            await pause(200);
          }
        };
        const reached = await settledOn(width, height);
        /*
         * And wait for the **canvas** to be re-measured, not just the window.
         *
         * The drawing surface is laid out from the preview stage, which is measured in an effect
         * after layout. Right after a resize it is still at the previous stage's rect, which reads
         * as "the canvas is outside the window" — the overlay really is at the old coordinates,
         * but only for a frame. Waiting for the two to agree is what makes this check about the
         * layout instead of about the timing (found.md F-119).
         */
        const canvasSettled = async () => {
          const started = Date.now();
          for (;;) {
            const ok = await ev(`(() => {
              const c = document.querySelector('[data-mystudio-overlay="annotation-canvas"]');
              if (!c) return true;
              const r = c.getBoundingClientRect();
              if (r.width === 0 || r.height === 0) return true;
              return r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1 && r.left >= -1 && r.top >= -1;
            })()`);
            if (ok === true) return true;
            if (Date.now() - started > 6000) return false;
            await pause(150);
          }
        };
        const canvasOk = await canvasSettled();
        const state = await ev(`(() => {
          const bad = [];
          for (const el of document.querySelectorAll('[data-mystudio-overlay]')) {
            const ov = el.getAttribute('data-mystudio-overlay');
            if (ov === 'shield' || ov === 'surface' || ov === 'sprite') continue;
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) continue;
            if (r.right > innerWidth + 1 || r.bottom > innerHeight + 1 || r.left < -1 || r.top < -1) {
              bad.push({ ov, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) });
            }
          }
          return { iw: innerWidth, ih: innerHeight, ow: outerWidth, oh: outerHeight, bad };
        })()`);
        const actual = compositorWindowSize();
        check(
          `${width}x${height}: the real window fits its overlays`,
          reached && canvasOk && pageMatchesWindow(state, actual),
          JSON.stringify({ ...state, actual, reached, canvasOk }),
        );
      }
    } finally {
      // Put the window back: this script observes the user's window, it does not keep it.
      if (originalSize) {
        niri(["msg", "action", "set-window-width", String(originalSize.width)]);
        niri(["msg", "action", "set-window-height", String(originalSize.height)]);
        await pause(1200);
      }
    }
  }

  console.log("\n[3] the pager turns the board's own pages, and leaves the video alone");
  const key = async (code, k, vk, mods) => {
    await send("Input.dispatchKeyEvent", { type: "keyDown", code, key: k, windowsVirtualKeyCode: vk, modifiers: mods });
    await send("Input.dispatchKeyEvent", { type: "keyUp", code, key: k, windowsVirtualKeyCode: vk, modifiers: mods });
    await pause(800);
  };
  if (!(await ev(`!!document.querySelector('[data-mystudio-overlay="dock-page-panel"]')`))) await key("KeyB", "b", 66, 2);
  await pause(800);

  /** "3 / 12" -> 3. */
  const pageNumber = () =>
    ev(`(() => {
      const n = document.querySelector('[data-mystudio-overlay="dock-page-number"]');
      if (!n) return null;
      return Number(n.textContent.trim().split("/")[0].trim());
    })()`);
  const step = async (label) => {
    const c = await ev(`(() => {
      const b = [...document.querySelectorAll('[data-mystudio-overlay="dock-page-step"]')].find((x) => x.getAttribute('aria-label') === ${JSON.stringify(label)});
      if (!b || b.disabled) return null;
      const r = b.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`);
    if (!c) return false;
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: c.x, y: c.y, button: "left", clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: c.x, y: c.y, button: "left", clickCount: 1 });
    await pause(900);
    return true;
  };
  const videoTime = () =>
    ev(`(() => {
      const all = [...document.querySelectorAll('body *')].filter((e) => e.children.length === 0 && /^\\d\\d:\\d\\d$/.test((e.textContent || '').trim()));
      return all.length > 0 ? all[0].textContent.trim() : null;
    })()`);

  const pager = await ev(`(() => {
    const el = document.querySelector('[data-mystudio-overlay="dock-page-panel"]');
    if (!el) return null;
    return {
      steps: [...el.querySelectorAll('[data-mystudio-overlay="dock-page-step"]')].map((b) => b.getAttribute('aria-label')),
      number: (el.querySelector('[data-mystudio-overlay="dock-page-number"]') || {}).textContent ?? null,
    };
  })()`);
  check("the pager has exactly two arrows", !!pager && pager.steps.length === 2, JSON.stringify(pager));
  check(
    "it shows the position out of the total",
    !!pager && /^\d+\s*\/\s*\d+$/.test(String(pager.number).trim()),
    JSON.stringify(pager?.number),
  );

  // Rewind: "previous" is disabled on page 1, so a fresh run must start elsewhere.
  for (let i = 0; i < 60; i += 1) if (!(await step("Previous page"))) break;
  check("it lands on page 1", (await pageNumber()) === 1, JSON.stringify(await pageNumber()));

  /*
   * Establish the state this section needs instead of inheriting it.
   *
   * The board starts with a single page, so on a fresh app there is nothing to advance to and
   * "next moves to page 2" failed for reasons that had nothing to do with the pager. It passed
   * only when `verify-pages` had happened to run first and left extra pages behind — a script
   * depending on another script's leftovers is exactly the coupling this suite must not have
   * (found.md F-119).
   */
  const ensureTwoPages = async () => {
    const total = await ev(`(() => {
      const n = document.querySelector('[data-mystudio-overlay="dock-page-number"]');
      if (!n) return null;
      return Number(n.textContent.trim().split("/")[1].trim());
    })()`);
    if ((total ?? 0) < 2) {
      const c = await ev(`(() => {
        const b = document.querySelector('[data-mystudio-overlay="dock-page-add"]');
        if (!b) return null;
        const r = b.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      })()`);
      if (c) {
        await send("Input.dispatchMouseEvent", { type: "mousePressed", x: c.x, y: c.y, button: "left", clickCount: 1 });
        await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: c.x, y: c.y, button: "left", clickCount: 1 });
        await pause(700);
      }
    }
    /*
     * Adding a page also **navigates** to it, so the starting point has to be restored
     * afterwards; otherwise this section begins on the last page with "next" disabled.
     */
    for (let i = 0; i < 60; i += 1) if (!(await step("Previous page"))) break;
  };
  await ensureTwoPages();

  const videoBefore = await videoTime();
  const canAdvance = await step("Next page");
  check("next moves to page 2", canAdvance && (await pageNumber()) === 2, JSON.stringify(await pageNumber()));
  /*
   * The board is its own deck: a page turn must **not** move the film. Pages used to be the
   * playhead, so sketching a plan also scrubbed the video — two unrelated things tied
   * together.
   */
  const videoAfter = await videoTime();
  check(
    "and the video does not move",
    videoBefore === videoAfter,
    `${JSON.stringify(videoBefore)} -> ${JSON.stringify(videoAfter)}`,
  );
} finally {
  /*
   * Nothing this script did may outlive it. It no longer touches the viewport, but a run
   * that dies halfway must still leave the app clean: the last time it did not, the user
   * ended up with a window drawn at a fraction of its size.
   */
  await clearViewportOverride();
  /*
   * "Restored" means the page is its window's size again — measured the same way as everywhere
   * else in this script. Comparing `innerWidth` against `outerWidth` here would report the
   * failure on native Wayland even when nothing is wrong, because `outerWidth` is an estimate
   * there. A real leftover override still shows up, because the compositor keeps reporting the
   * window's size while the page has been shrunk away from it.
   */
  const final = await ev(`({
    iw: innerWidth, ih: innerHeight, ow: outerWidth, oh: outerHeight,
    bad: (() => {
      const out = [];
      for (const el of document.querySelectorAll('[data-mystudio-overlay]')) {
        const ov = el.getAttribute('data-mystudio-overlay');
        if (ov === 'shield' || ov === 'surface' || ov === 'sprite') continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        if (r.right > innerWidth + 1 || r.bottom > innerHeight + 1 || r.left < -1 || r.top < -1) out.push(ov);
      }
      return out;
    })(),
  })`).catch(() => null);
  const finalWindow = compositorWindowSize();
  if (final && !pageMatchesWindow(final, finalWindow)) {
    check("the window was restored", false, JSON.stringify({ ...final, finalWindow }));
  }
  console.log(`\nresult: ${pass} passed, ${fail} failed`);
  ws.close();
  process.exit(fail === 0 ? 0 : 1);
}
