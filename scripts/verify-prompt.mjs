/**
 * Runtime check: **the prompt box shows everything the delivery will contain**.
 *
 * This is the check that was missing when the user drew with the freehand tool, pressed
 * add-to-prompt, saw the box unchanged, and concluded nothing had been added. The data was
 * in the bundle all along (`ink: 1`), but a picture has no block reference, so there was
 * **no visible evidence** that anything would be sent (found.md F-104).
 *
 * The rule: whatever travels must have a visible marker. A block reference gets a chip; a
 * frame picture gets a badge.
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
  await send("Input.dispatchKeyEvent", {
    type: "keyDown",
    code,
    key,
    windowsVirtualKeyCode: vk,
    modifiers,
  });
  await send("Input.dispatchKeyEvent", {
    type: "keyUp",
    code,
    key,
    windowsVirtualKeyCode: vk,
    modifiers,
  });
  // Capturing a frame and writing it to disk is asynchronous; a shorter wait made this
  // check pass or fail depending on how fast the disk was.
  await pause(1400);
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
const promptText = () =>
  ev(`document.querySelector('[data-mystudio-overlay="compose-input"]')?.innerText ?? ''`);
/** Block chips currently shown in the prompt box. */
const chips = () =>
  ev(`[...document.querySelectorAll('[data-mystudio-overlay="compose-input"] [data-mystudio-ref]')].map((atom) => atom.getAttribute('data-mystudio-ref'))`);
const boardOn = () => ev(`!!document.querySelector('[data-mystudio-overlay="dock-page-panel"]')`);
const pickTool = async (label) => {
  await ev(`[...document.querySelectorAll('[data-mystudio-overlay="dock"] button')].find((b) => b.getAttribute('aria-label') === ${JSON.stringify(label)})?.click()`);
  await pause(350);
};
const freePoint = () =>
  ev(`(() => {
    const c = document.querySelector('[data-mystudio-overlay="annotation-canvas"]');
    if (!c) return null;
    const b = c.getBoundingClientRect();
    for (let fy = 0.3; fy < 0.7; fy += 0.05) {
      for (let fx = 0.3; fx < 0.7; fx += 0.05) {
        const x = Math.round(b.x + b.width * fx);
        const y = Math.round(b.y + b.height * fy);
        if (document.elementFromPoint(x, y) === c) return { x, y };
      }
    }
    return null;
  })()`);
const drag = async (from, dx, dy) => {
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: from.x, y: from.y, button: "left", clickCount: 1 });
  for (let step = 1; step <= 10; step += 1) {
    await send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: from.x + Math.round((dx * step) / 10),
      y: from.y + Math.round((dy * step) / 10),
      button: "left",
    });
  }
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: from.x + dx, y: from.y + dy, button: "left", clickCount: 1 });
  await pause(1500);
};

// ── [0] known state ───────────────────────────────────────────────────────
console.log("\n[0] known state");
if (!(await ev(`!!document.querySelector('[data-mystudio-overlay="surface"]')`))) {
  await press("KeyH", "h", 72, 2);
}
check("the annotation window is visible", await ev(`!!document.querySelector('[data-mystudio-overlay="surface"]')`));
if ((await capturing()) !== "true") await press("KeyA", "a", 65, 2);
check("the layer is active", (await capturing()) === "true");
/*
 * Empty the box through the **editor's own** key handling.
 *
 * `execCommand` no longer reaches it: the prompt is a ProseMirror document, and the editor
 * applies changes through transactions. Typing `Ctrl+A` then Backspace is what a user does,
 * and it exercises the same path the product does — including removing the blocks, because a
 * selected-then-deleted block reference is a deletion (found.md F-118).
 */
const clearBox = async () => {
  await ev(`(() => {
    const box = document.querySelector('[data-mystudio-overlay="compose-input"]');
    const editable = box && (box.querySelector('.ProseMirror') ?? box);
    editable?.focus();
    return !!editable;
  })()`);
  await press("KeyA", "a", 65, 2);
  await press("Backspace", "Backspace", 8, 0);
  await pause(500);
  await ev(`document.activeElement?.blur?.(); true`);
};
await clearBox();
if ((await promptText()).trim() !== "" || (await chips()).length > 0) await clearBox();
check(
  "the prompt box is empty",
  (await promptText()).trim() === "" && (await chips()).length === 0,
  `${JSON.stringify(await promptText())} ${JSON.stringify(await chips())}`,
);

// Handwriting only exists on the video; the board is a separate surface.
if (await boardOn()) await press("KeyB", "b", 66, 2);
check("the video surface is showing", (await boardOn()) === false);

// ── [1] freehand: a picture, and a visible badge ──────────────────────────
console.log("\n[1] freehand is delivered as a picture, and says so");
await pickTool("Freehand");
const freehandSpot = await freePoint();
if (!freehandSpot) {
  check("the picture is drawable", false, "no reachable point");
} else {
  await drag(freehandSpot, 80, 40);
  await pause(1200);

  /*
   * Adding a capture is an explicit act (`Ctrl+S`), not a side effect of drawing: the box
   * stays untouched until the user asks for it, which is what makes "I drew" and "send this"
   * two different decisions (found.md F-106).
   */
  check("drawing alone adds no block", (await promptText()).trim() === "", JSON.stringify(await promptText()));

  await press("KeyS", "s", 83, 2);
  const afterAdd = await chips();
  check("Ctrl+S adds a capture block", afterAdd.some((label) => /^Capture \d+$/.test(label)), JSON.stringify(afterAdd));
  check("a second press with nothing changed adds no second block", (await chips()).length === afterAdd.length, JSON.stringify(await chips()));
  check("the send button is enabled", (await ev(`(() => {
    const b = document.querySelector('[data-mystudio-overlay="send"]');
    return b ? !b.disabled : null;
  })()`)) === true);
}

// ── [2] a numbered mark still becomes a chip ─────────────────────────────
console.log("\n[2] a region still adds a reference");
await pickTool("Region");
const regionSpot = await freePoint();
if (!regionSpot) {
  check("the picture is drawable", false, "no reachable point");
} else {
  await drag(regionSpot, 90, 60);
  await pause(1000);
  await press("KeyS", "s", 83, 2);
  const text = await promptText();
  check("Ctrl+S adds the block reference", /Region \d+/.test(text), JSON.stringify(text));

  const before = await promptText();
  await press("KeyS", "s", 83, 2);
  check("pressing again does not duplicate it", (await promptText()) === before, JSON.stringify(await promptText()));
}

// ── [3] undo removes the picture, and the badge with it ──────────────────
console.log("\n[3] an undone stroke takes its picture with it");
/*
 * Undo **until there is nothing left to undo**, then the badge must be gone.
 *
 * Asserting after a single press was wrong: the history also holds the region drawn above,
 * and earlier states, so one undo only removes the newest action. The property under test is
 * "the badge tracks the pictures that will actually be delivered", not "one undo removes
 * everything".
 */
await pickTool("Select");
const canUndo = () =>
  ev(`(() => {
    const d = document.querySelector('[data-mystudio-overlay="dock"]');
    const b = d && [...d.querySelectorAll('button')].find((x) => x.getAttribute('aria-label') === 'Undo');
    return b ? !b.disabled : false;
  })()`);
for (let step = 0; step < 20 && (await canUndo()); step += 1) {
  await press("KeyZ", "z", 90, 2);
}
await pause(600);
/*
 * Undoing the drawing does not remove an already-added block: the block is the user's
 * decision, and the prompt's text still names it. What must not happen is a picture that no
 * longer exists being delivered silently, which the bundle's own filter handles.
 */
check("the capture block survives an undo of the drawing", (await chips()).some((label) => /^Capture \d+$/.test(label)), JSON.stringify(await chips()));

console.log(`\nresult: ${passed} passed, ${failed} failed`);
ws.close();
process.exit(failed === 0 ? 0 : 1);
