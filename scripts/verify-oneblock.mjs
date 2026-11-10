/**
 * Runtime check: **one press adds exactly one block**, and the block matches the last action.
 *
 * ## The defect this guards
 *
 * Selecting an element and pressing the add key produced `Element 1` **and** `Capture 2` — the
 * same picture delivered twice, from one press. The cause was structural: the "what did the user
 * just do" decision lived in three places, and one press reached two of them
 * (found.md F-122).
 *
 * The unit tests pin the decision (`nextAction.test.ts`), but only a running application can show
 * that the wiring calls it **once**. So this check drives each action and counts blocks.
 *
 * Requires the app running with `--remote-debugging-port=9222`.
 */

const targets = await (await fetch("http://127.0.0.1:9222/json/list")).json();
const page = targets.find((target) => target.type === "page");
if (!page) {
  console.error("No page target; start the app with --remote-debugging-port=9222");
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();

function send(method, params = {}) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (!message.id || !pending.has(message.id)) return;
  const { resolve, reject } = pending.get(message.id);
  pending.delete(message.id);
  if (message.error) reject(new Error(JSON.stringify(message.error)));
  else resolve(message.result);
};

await new Promise((resolve) => (ws.onopen = resolve));

const ev = async (expression) => {
  const result = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  return result.exceptionDetails
    ? { error: result.exceptionDetails.exception?.description }
    : result.result.value;
};

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const press = async (code, key, vk, modifiers) => {
  await send("Input.dispatchKeyEvent", { type: "keyDown", code, key, windowsVirtualKeyCode: vk, modifiers });
  await send("Input.dispatchKeyEvent", { type: "keyUp", code, key, windowsVirtualKeyCode: vk, modifiers });
  await pause(900);
};

/**
 * Poll until `probe` is truthy, or the deadline passes.
 *
 * A capture is not instantaneous: the picture is composed at the native resolution and written to
 * disk before the block joins the request, so a fixed sleep either flakes or slows everything
 * down. Polling states the actual expectation — "the block appears" — instead of guessing a
 * duration (the same reason `verify-prompt` polls for chips).
 */
const until = async (probe, timeoutMs = 8000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) return value;
    await pause(200);
  }
};

let passed = 0;
let failed = 0;
const check = (name, ok, detail = "") => {
  if (ok) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name} ${detail}`);
  }
};

const capturing = () =>
  ev(`document.querySelector('[data-mystudio-overlay="surface"]')?.getAttribute('data-capturing')`);
/** Every block in the box, with the kind it would be delivered as. */
const blocks = () =>
  ev(`[...document.querySelectorAll('[data-mystudio-overlay="compose-input"] [data-mystudio-ref]')].map((atom) => ({
    kind: atom.getAttribute('data-mystudio-block'),
    label: atom.textContent,
  }))`);
const boardOn = () => ev(`!!document.querySelector('[data-mystudio-overlay="dock-page-panel"]')`);

const pickTool = async (label) => {
  await ev(`[...document.querySelectorAll('[data-mystudio-overlay="dock"] button')].find((b) => b.getAttribute('aria-label') === ${JSON.stringify(label)})?.click()`);
  await pause(350);
};

/** A point on the picture nothing is covering. */
const freePoint = () =>
  ev(`(() => {
    const c = document.querySelector('[data-mystudio-overlay="annotation-canvas"]');
    if (!c) return null;
    const b = c.getBoundingClientRect();
    for (let fy = 0.15; fy < 0.85; fy += 0.05) {
      for (let fx = 0.15; fx < 0.85; fx += 0.05) {
        const x = Math.round(b.x + b.width * fx);
        const y = Math.round(b.y + b.height * fy);
        if (document.elementFromPoint(x, y) === c) return { x, y };
      }
    }
    return null;
  })()`);

const drag = async (from, dx, dy) => {
  if (!from) return false;
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: from.x, y: from.y, button: "left", clickCount: 1 });
  for (let step = 1; step <= 8; step += 1) {
    await send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: from.x + Math.round((dx * step) / 8),
      y: from.y + Math.round((dy * step) / 8),
      button: "left",
    });
  }
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: from.x + dx, y: from.y + dy, button: "left", clickCount: 1 });
  await pause(1400);
  return true;
};

/**
 * Empty the box, then let go of it.
 *
 * Removing a block is a real deletion through the editor, so a stale `Capture` cannot survive
 * into the next case and be mistaken for a duplicate. Blurring afterwards matters for a
 * different reason: the box floats over the picture, and while it holds the pointer no draw
 * point is reachable.
 */
const clearBox = async () => {
  for (let step = 0; step < 10; step += 1) {
    const list = await blocks();
    if (list.length === 0) break;
    await ev(`document.querySelector('[data-mystudio-overlay="compose-input"]')?.focus()`);
    await press("KeyA", "a", 65, 2);
    await press("Backspace", "Backspace", 8, 0);
  }
  /*
   * Wait for the box to be **actually** empty before the next case draws.
   *
   * A capture is composed and written asynchronously, so a press that was still in flight can
   * land after the clear and be mistaken for a duplicate in the next case. Waiting for the
   * observed state, rather than a duration, is what makes this check deterministic — the earlier
   * version reported a `Capture` in the region case that came from the handwriting case.
   */
  await until(async () => (await blocks()).length === 0, 5000);
  await ev(`document.activeElement?.blur?.(); true`);
  await pause(250);
};

// ── [0] known state ───────────────────────────────────────────────────────
console.log("\n[0] known state");
if (!(await ev(`!!document.querySelector('[data-mystudio-overlay="surface"]')`))) {
  await press("KeyH", "h", 72, 2);
}
await ev(`document.activeElement?.blur?.(); true`);
if ((await capturing()) !== "true") await press("KeyA", "a", 65, 2);
check("the layer is active", (await capturing()) === "true");
if (await boardOn()) await press("KeyB", "b", 66, 2);
check("the video surface is showing", (await boardOn()) === false);

/*
 * Wait until the picture is **actually drawable** before the first case.
 *
 * A surface switch repaints the canvas asynchronously. Asking for a reachable point in the same
 * breath as switching back returns `null`, and that reads as "the picture is not drawable" —
 * a failure that has nothing to do with what this script checks. Waiting for the observed
 * condition is what keeps the first case from being a race with the previous script's last
 * action (found.md F-119).
 */
const drawable = async () => {
  const started = Date.now();
  for (;;) {
    if ((await freePoint()) !== null) return true;
    if (Date.now() - started > 5000) return false;
    await pause(200);
  }
};
check("the picture becomes drawable", await drawable());

// ── [1] handwriting: one press, one Capture ───────────────────────────────
console.log("\n[1] handwriting is one Capture and nothing else");
await clearBox();
await pickTool("Freehand");
if (!(await drag(await freePoint(), 100, 60))) {
  check("the picture is drawable", false, "no reachable point");
} else {
  await press("KeyS", "s", 83, 2);
  const list = (await until(async () => {
    const current = await blocks();
    return current.length > 0 ? current : null;
  }, 8000)) ?? [];
  check("exactly one block", list.length === 1, JSON.stringify(list));
  check("it is a Capture", list[0]?.kind === "capture", JSON.stringify(list));
}

// ── [2] a region: one Region, no Capture beside it ────────────────────────
console.log("\n[2] a region is one Region block");
await clearBox();
await pickTool("Region");
if (!(await drag(await freePoint(), 120, 80))) {
  check("the picture is drawable", false, "no reachable point");
} else {
  await press("KeyS", "s", 83, 2);
  const list = (await until(async () => {
    const current = await blocks();
    return current.length > 0 ? current : null;
  }, 8000)) ?? [];
  check("exactly one block", list.length === 1, JSON.stringify(list));
  check("it is not a Capture", !list.some((block) => block.kind === "capture"), JSON.stringify(list));
}

// ── [3] an arrow: one Arrow, no Capture beside it ─────────────────────────
console.log("\n[3] an arrow is one Arrow block");
await clearBox();
await pickTool("Arrow");
if (!(await drag(await freePoint(), 110, 70))) {
  check("the picture is drawable", false, "no reachable point");
} else {
  await press("KeyS", "s", 83, 2);
  const list = (await until(async () => {
    const current = await blocks();
    return current.length > 0 ? current : null;
  }, 8000)) ?? [];
  check("exactly one block", list.length === 1, JSON.stringify(list));
  check("it is not a Capture", !list.some((block) => block.kind === "capture"), JSON.stringify(list));
}

// ── [4] pressing again settles instead of piling up ───────────────────────
console.log("\n[4] a second press does not duplicate");
const before = (await blocks()).length;
await press("KeyS", "s", 83, 2);
const after = (await blocks()).length;
check("the block count is unchanged", after === before, `${before} -> ${after}`);

/*
 * ## What this script cannot reach
 *
 * The reported case was **an element selection**: `Element 1` plus `Capture 2` from one press.
 * An element comes from Studio's own DOM selection, which this script has no reliable way to
 * drive — clicking inside the preview needs Studio's internal state, and faking it would test
 * the fake rather than the product.
 *
 * So the element path is covered where it can be covered honestly:
 *
 * - `nextAction.test.ts` asserts a selected element decides **one** kind and never a capture;
 * - `elementDuplicate.test.ts` asserts the identity rule that makes a second press a no-op.
 *
 * The structural guarantee is that `decideNextAction` returns a **single** value: no caller can
 * turn one press into two blocks without adding one itself, and `useAnnotations` has exactly one
 * call per kind. Adding a "check" here that passes whenever the box is empty would look like
 * coverage without being any.
 */
console.log("\n[5] element selection: covered by nextAction.test.ts (not drivable here)");

// ── [6] every line is the same height, chip or text ───────────────────────
console.log("\n[6] a line of chips is not taller than a line of text");
/*
 * The reported defect: with no text between them the blocks were **double-spaced**, and adding
 * text made them tight again. The cause was ProseMirror's trailing `<br>` — a rendering aid, not
 * document content — which occupies a line box whenever a paragraph ends in an atom. Two blocks
 * then measured 41.8px against a 20.9px line (found.md F-123).
 */
const lineHeights = await ev(`(() => {
  const ed = document.querySelector('[data-mystudio-overlay="compose-input"]');
  if (!ed) return null;
  return [...ed.children].map((p) => Math.round(p.getBoundingClientRect().height));
})()`);
check(
  "every paragraph is one line tall",
  Array.isArray(lineHeights) && lineHeights.every((h) => h > 0 && h <= 24),
  JSON.stringify(lineHeights),
);
check(
  "a block-only line is the same height as the others",
  Array.isArray(lineHeights) && new Set(lineHeights).size <= 1,
  JSON.stringify(lineHeights),
);

console.log(`\nresult: ${passed} passed, ${failed} failed`);
ws.close();
process.exit(failed === 0 ? 0 : 1);
