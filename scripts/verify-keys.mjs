/**
 * Runtime check: **who owns a keystroke**.
 *
 * This is the check the earlier suite was missing. Every assertion is about one of three
 * things the user reported:
 *
 * 1. bare `A` reached the preview while the layer was supposedly in charge;
 * 2. `Ctrl+Z` reached the prompt box when the layer was talkative about it;
 * 3. `Ctrl+A` did not toggle because a text field owns "select all".
 *
 * They were all the same defect — "not one of my keys" was treated as "not my business" —
 * so they are checked together, from the outside, against a running app.
 *
 * Requires the app running with `--remote-debugging-port=9222`.
 */

const CDP = "http://127.0.0.1:9222/json/list";

const targets = await (await fetch(CDP)).json();
const page = targets.find((t) => t.type === "page");
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
  await pause(450);
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

/*
 * Two listeners: capture (did the event arrive, and was it already handled?) and bubble
 * (did propagation survive?). Together they distinguish "Studio acted on it" from "the
 * layer swallowed it" — which is the whole question.
 */
await ev(`(() => {
  window.__keys = { capture: [], bubble: [] };
  if (window.__keysHooked) return "already";
  window.__keysHooked = true;
  window.addEventListener("keydown", (e) => {
    window.__keys.capture.push({ code: e.code, ctrl: e.ctrlKey, prevented: e.defaultPrevented });
  }, true);
  window.addEventListener("keydown", (e) => {
    window.__keys.bubble.push({ code: e.code, ctrl: e.ctrlKey });
  }, false);
  return "hooked";
})()`);

const resetKeys = () => ev(`window.__keys = { capture: [], bubble: [] }; true`);
const readKeys = () => ev(`window.__keys`);

/*
 * Bring the app to a known state rather than assuming the previous script left it clean.
 *
 * These scripts run in one process against one running app, so state leaks between them:
 * a hidden window or a stray focus turns "the field gets Ctrl+Z" into "nobody does", and the
 * failure looks like a product bug. Making the precondition explicit keeps a failure here
 * meaningful.
 */
const surfaceVisible = () =>
  ev(`!!document.querySelector('[data-mystudio-overlay="surface"]')`);
const hasComposer = () =>
  ev(`!!document.querySelector('[data-mystudio-overlay="compose-input"]')`);
const blur = () => ev(`document.activeElement?.blur?.(); document.body.focus?.(); true`);
const clickAt = async (x, y) => {
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  await pause(600);
};
const focusedOverlay = () => ev(`document.activeElement?.getAttribute?.('data-mystudio-overlay') ?? ''`);

console.log("\n[0] bring the app to a known state");
await blur();
if (!(await surfaceVisible())) await press("KeyH", "h", 72, 2);
check("the annotation window is visible", await surfaceVisible());
if ((await capturing()) === "true") await press("KeyA", "a", 65, 2);
check("the layer starts inactive", (await capturing()) === "false");

console.log("\n[1] inactive: Studio keeps its keys");
await resetKeys();
await press("KeyA", "a", 65, 0);
let keys = await readKeys();
check(
  "inactive: bare A reaches Studio (it is the in-point key)",
  keys.capture.some((k) => k.code === "KeyA" && (k.prevented || keys.bubble.some((b) => b.code === "KeyA"))),
  JSON.stringify(keys),
);
check(
  "inactive: the event is not swallowed by this layer",
  keys.bubble.some((k) => k.code === "KeyA"),
  JSON.stringify(keys.bubble),
);

console.log("\n[1b] inactive: Ctrl+Z belongs to nobody in this layer");
/*
 * The rule the user stated: while inactive, `Ctrl+Z` is **not** this layer's business even
 * if nothing else wants it. So it must behave exactly like an unclaimed key: it arrives,
 * it bubbles, and this layer neither prevents nor consumes it.
 *
 * Checked against a focused text field, which is the case where a wrong answer is visible:
 * if the layer claimed the chord, the field's own undo would never run.
 */
await ev(`document.querySelector('[data-mystudio-overlay="compose-input"]')?.focus(); true`);
await resetKeys();
await press("KeyZ", "z", 90, 2);
keys = await readKeys();
check(
  "inactive: Ctrl+Z in a field bubbles freely (not claimed by this layer)",
  keys.bubble.some((k) => k.code === "KeyZ" && k.ctrl),
  JSON.stringify(keys.bubble),
);
check(
  "inactive: this layer did not preventDefault on Ctrl+Z",
  !keys.capture.some((k) => k.code === "KeyZ" && k.prevented),
  JSON.stringify(keys.capture),
);
check("inactive: Ctrl+Z did not activate the layer", (await capturing()) === "false");
await ev(`document.activeElement?.blur?.(); document.body.focus?.(); true`);

console.log("\n[1c] inactive: Studio's own effects work");
/*
 * Effects, not just events. A key can be "not seen by any listener" and still do something,
 * because the **browser** acts on it (a focused button, a scroll, a checkbox). Checking only
 * listeners is how "Space pierced through while active" stayed hidden (found.md F-094).
 */
const playLabel = () =>
  ev(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /^(play|pause)$/i.test(x.getAttribute('aria-label') || ''));
    return b ? b.getAttribute('aria-label') : null;
  })()`);

await blur();
const playBefore = await playLabel();
await press("Space", " ", 32, 0);
await pause(600);
check("inactive: Space toggles playback (Studio receives it)", (await playLabel()) !== playBefore,
  `${playBefore} -> ${await playLabel()}`);
await press("Space", " ", 32, 0);
await pause(400);

console.log("\n[2] Ctrl+A activates");
await press("KeyA", "a", 65, 2);
check("Ctrl+A activates the layer", (await capturing()) === "true");

console.log("\n[3] active: the layer owns every key");
await resetKeys();
await press("KeyA", "a", 65, 0);
keys = await readKeys();
check(
  "active: bare A does not reach Studio",
  !keys.bubble.some((k) => k.code === "KeyA"),
  JSON.stringify(keys.bubble),
);
check(
  "active: Studio did not act on bare A",
  !keys.capture.some((k) => k.code === "KeyA" && k.prevented),
  JSON.stringify(keys.capture),
);

console.log("\n[3b] active: no effect at all, including the browser's own");
/*
 * `Space` while a toolbar button has focus is the case that exposed this: no listener of
 * Studio's ran, yet playback toggled, because the browser pressed the focused button.
 */
await ev(`document.querySelector('[data-mystudio-overlay="dock-board"]')?.focus(); true`);
const activeBefore = await playLabel();
await press("Space", " ", 32, 0);
await pause(600);
check("active: Space does nothing, even on a focused toolbar button",
  (await playLabel()) === activeBefore, `${activeBefore} -> ${await playLabel()}`);
check("active: the layer is still active", (await capturing()) === "true");
await blur();

console.log("\n[3c] active: Ctrl+Z is the layer's, not the browser's");
/*
 * `Ctrl+Z` with nothing to undo used to fall through to the browser, so it reached Studio
 * and — inside the prompt box — the browser's text undo. Active means the key stops here.
 */
await blur();
await resetKeys();
await press("KeyZ", "z", 90, 2);
keys = await readKeys();
check(
  "active: Ctrl+Z is consumed even when there is nothing to undo",
  !keys.bubble.some((k) => k.code === "KeyZ"),
  JSON.stringify(keys.bubble),
);

console.log("\n[4] active, caret in the prompt box");
check("the prompt box exists while active", await hasComposer());
await ev(`document.querySelector('[data-mystudio-overlay="compose-input"]')?.focus(); true`);
check(
  "the caret is in the prompt box",
  (await ev(`document.activeElement?.getAttribute?.('data-mystudio-overlay')`)) === "compose-input",
);

/*
 * `Ctrl+Z` here is **drawing** undo, not text undo — that is the design, and it is why the
 * chord carries a modifier. But it must never be silently lost: either the layer had a
 * drawing to undo (and consumed the key), or it had nothing and the field's own undo ran.
 * Both outcomes are correct; "swallowed and nothing happened" is not.
 */
const undoEnabled = () =>
  ev(`(() => {
    const d = document.querySelector('[data-mystudio-overlay="dock"]');
    const b = d && [...d.querySelectorAll('button')].find((x) => x.getAttribute('aria-label') === 'Undo');
    return b ? !b.disabled : null;
  })()`);

await resetKeys();
await press("KeyZ", "z", 90, 2);
keys = await readKeys();
check(
  "active+typing: Ctrl+Z reaches the field (a text box undoes its own typing)",
  keys.bubble.some((k) => k.code === "KeyZ"),
  JSON.stringify(keys.bubble),
);

await resetKeys();
await press("KeyA", "a", 65, 2);
keys = await readKeys();
check(
  "active+typing: Ctrl+A is select-all, not a mode toggle",
  keys.bubble.some((k) => k.code === "KeyA" && k.ctrl),
  JSON.stringify(keys.bubble),
);
check("active+typing: the layer stayed active", (await capturing()) === "true");

console.log("\n[4a] drawing on the picture releases the caret");
/*
 * The reported defect: after drawing, the caret stayed in the prompt box, so `Ctrl+Z` still
 * addressed the text and the box kept looking active while the pointer was on the canvas
 * (found.md F-102). The canvas deliberately calls `preventDefault`, which also suppresses
 * the browser's focus change — so the layer has to drop the caret itself.
 */
await blur();
if ((await capturing()) !== "true") await press("KeyA", "a", 65, 2);
await ev(`document.querySelector('[data-mystudio-overlay="compose-input"]')?.focus(); true`);
check("the caret starts in the prompt box", (await focusedOverlay()) === "compose-input");

const picture = await ev(`(() => {
  const c = document.querySelector('[data-mystudio-overlay="annotation-canvas"]');
  if (!c) return null;
  const b = c.getBoundingClientRect();
  return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
})()`);
if (picture) {
  await clickAt(picture.x, picture.y);
  check("drawing on the picture releases the caret", (await focusedOverlay()) !== "compose-input");
  check("and leaves the layer active", (await capturing()) === "true");
} else {
  check("the picture is measurable", false, "no canvas");
}

console.log("\n[4b] clicking empty space moves the caret, not the state");
/*
 * Two different things, and conflating them was the defect (found.md F-093):
 * - **activation** is whether this layer takes the input; it changes by shortcut only;
 * - **focus** is which element receives the next keystroke.
 *
 * Clicking empty space is about focus: the caret leaves the prompt box. If that were also a
 * state change, then "click somewhere else to stop typing here" would silently switch the
 * layer off — and with the caret in a field, the state could never be switched back,
 * because the field owns `Ctrl+A` as "select all".
 */

await ev(`document.querySelector('[data-mystudio-overlay="compose-input"]')?.focus(); true`);
check("the caret starts in the prompt box", (await focusedOverlay()) === "compose-input");

await clickAt(6, 600);
check("clicking empty space takes the caret out of the prompt box", (await focusedOverlay()) !== "compose-input");
check("and does not change activation", (await capturing()) === "true");

console.log("\n[4c] inactive, caret in the prompt box: the field undoes its own typing");
/*
 * Studio binds undo to `Ctrl+Z` too. A focused text box has the stronger claim there, so the
 * field gets it — and this is why Studio's own `Ctrl+Z` must **not** have been relocated
 * (found.md F-096): outside a field the same chord has to reach Studio's undo.
 */
await blur();
if ((await capturing()) === "true") await press("KeyA", "a", 65, 2);
check("inactive again", (await capturing()) === "false");
await ev(`document.querySelector('[data-mystudio-overlay="compose-input"]')?.focus(); true`);
await resetKeys();
await press("KeyZ", "z", 90, 2);
keys = await readKeys();
check(
  "inactive+typing: Ctrl+Z reaches the field",
  keys.bubble.some((k) => k.code === "KeyZ"),
  JSON.stringify(keys.bubble),
);
await blur();

console.log("\n[5] the shortcut switches state once the caret is out");
/*
 * Drive to a known state first. Each earlier section deliberately leaves a different
 * activation and sometimes a focused field, so asserting "this press deactivates" without
 * establishing the start is a test bug, not a product one.
 */
await blur();
if ((await capturing()) !== "true") await press("KeyA", "a", 65, 2);
check("the layer is active and unfocused", (await capturing()) === "true");

await press("KeyA", "a", 65, 2);
check("Ctrl+A deactivates", (await capturing()) === "false");
await press("KeyA", "a", 65, 2);
check("Ctrl+A activates again", (await capturing()) === "true");
await press("KeyA", "a", 65, 2);
check("and it ends inactive", (await capturing()) === "false");

console.log(`\nresult: ${passed} passed, ${failed} failed`);
ws.close();
process.exit(failed === 0 ? 0 : 1);
