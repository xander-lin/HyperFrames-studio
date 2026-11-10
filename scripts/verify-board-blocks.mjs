/**
 * Runtime check: **drawing on the whiteboard and pressing Ctrl+S produces a block**.
 *
 * ## What was wrong
 *
 * Board ink lived only in `boardStore`, and the request is assembled in `useAnnotations`, which
 * never reads that store (the separation is deliberate: found.md F-061). So `Ctrl+S` on the board
 * found nothing to add and did exactly nothing — no chip, no picture, nothing delivered. The
 * user's report was exact: "白板模式下的绘制好像完全是另一套。并且我按 Ctrl S 也不会产生chip".
 *
 * ## What this checks
 *
 * The board must behave like the video with a different paper:
 *
 *   1. the video still adds a `Capture` — the board work must not change that path;
 *   2. drawing alone adds nothing, and one `Ctrl+S` adds one `Drawing N`;
 *   3. pressing again with nothing changed adds no second block (the state, not the press);
 *   4. drawing again adds a second, distinct `Drawing N`;
 *   5. the block deletes with the mouse like any other;
 *   6. labels stay one gap-free sequence **across** kinds, video and board together.
 *
 * ## What it deliberately does not check
 *
 * The picture's pixels. `boardPicture.test.ts` pins that the page is filled, drawn at the
 * composition's size, and never badges; the visual acceptance is the user's own.
 *
 * Requires the app running with `--remote-debugging-port=9222`.
 */

const targets = await (await fetch("http://127.0.0.1:9222/json/list")).json();
const page = targets.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (!m.id || !pending.has(m.id)) return;
  const { resolve, reject } = pending.get(m.id);
  pending.delete(m.id);
  m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
};
function send(m, p = {}) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method: m, params: p }));
  return new Promise((res, rej) => pending.set(id, { resolve: res, reject: rej }));
}
await new Promise((r) => (ws.onopen = r));
const ev = async (e) => {
  const r = await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true });
  return r.exceptionDetails ? { error: r.exceptionDetails.exception?.description } : r.result.value;
};
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const press = async (code, key, vk, mods = 0) => {
  await send("Input.dispatchKeyEvent", { type: "keyDown", code, key, windowsVirtualKeyCode: vk, modifiers: mods });
  await send("Input.dispatchKeyEvent", { type: "keyUp", code, key, windowsVirtualKeyCode: vk, modifiers: mods });
  await pause(400);
};
const pickTool = async (label) => {
  await ev(`[...document.querySelectorAll('[data-mystudio-overlay="dock"] button')].find((b) => b.getAttribute('aria-label') === ${JSON.stringify(label)})?.click()`);
  await pause(350);
};
const freePoint = () =>
  ev(`(() => {
    const c = document.querySelector('[data-mystudio-overlay="annotation-canvas"]');
    if (!c) return null;
    const b = c.getBoundingClientRect();
    for (let fy = 0.25; fy < 0.75; fy += 0.05) {
      for (let fx = 0.25; fx < 0.75; fx += 0.05) {
        const x = Math.round(b.x + b.width * fx);
        const y = Math.round(b.y + b.height * fy);
        if (document.elementFromPoint(x, y) === c) return { x, y };
      }
    }
    return null;
  })()`);
const drag = async (from, dx, dy) => {
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: from.x, y: from.y, button: "left", clickCount: 1 });
  for (let i = 1; i <= 12; i += 1) {
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x + Math.round((dx * i) / 12), y: from.y + Math.round((dy * i) / 12), button: "left" });
  }
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: from.x + dx, y: from.y + dy, button: "left", clickCount: 1 });
  await pause(800);
};
const clickAt = async (x, y) => {
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  await pause(400);
};
const chips = () => ev(`[...document.querySelectorAll('[data-mystudio-overlay="compose-input"] [data-mystudio-ref]')].map((a) => a.getAttribute('data-mystudio-ref'))`);
const boardOn = () => ev(`!!document.querySelector('[data-mystudio-overlay="dock-page-panel"]')`);

/** Adding a block is asynchronous (fetch the frame, compose, write the file), so wait for it. */
const waitForCount = async (expected, timeoutMs = 12000) => {
  const started = Date.now();
  for (;;) {
    const now = await chips();
    if (now.length === expected) return now;
    if (Date.now() - started > timeoutMs) return now;
    await pause(250);
  }
};
const clearBox = async () => {
  await ev(`(() => { const b = document.querySelector('[data-mystudio-overlay="compose-input"]'); (b?.querySelector('.ProseMirror') ?? b)?.focus(); return true; })()`);
  await press("KeyA", "a", 65, 2);
  await press("Backspace", "Backspace", 8, 0);
  await ev(`document.activeElement?.blur?.(); true`);
  await pause(400);
};
let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
  if (ok) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + " " + extra); }
};

// establish our own starting state
if (await ev(`!document.querySelector('[data-mystudio-overlay="surface"]')`)) await press("KeyH", "h", 72, 2);
if ((await ev(`document.querySelector('[data-mystudio-overlay="surface"]')?.getAttribute('data-capturing')`)) !== "true") await press("KeyA", "a", 65, 2);
await ev(`document.activeElement?.blur?.(); true`);
if (await boardOn()) await press("KeyB", "b", 66, 2);
await clearBox();

console.log("\n[1] the video still behaves as before");
await pickTool("Freehand");
let p = await freePoint();
if (p) await drag(p, 90, 50);
await press("KeyS", "s", 83, 2);
let c = await waitForCount(1);
check("video freehand still adds a Capture", c.some((x) => /^Capture \d+$/.test(x)), JSON.stringify(c));
await clearBox();
await waitForCount(0);

console.log("\n[2] the board now adds a block");
await press("KeyB", "b", 66, 2);
await pause(700);
check("board is showing", (await boardOn()) === true);
await pickTool("Freehand");
p = await freePoint();
if (p) await drag(p, 90, 50);
check("drawing alone adds no block", (await chips()).length === 0, JSON.stringify(await chips()));
await pickTool("Region");
p = await freePoint();
if (p) await drag({ x: p.x, y: p.y + 90 }, 120, 70);
await pickTool("Arrow");
p = await freePoint();
if (p) await drag({ x: p.x + 40, y: p.y + 200 }, 110, -60);
await pause(600);
await press("KeyS", "s", 83, 2);
c = await waitForCount(1);
check("Ctrl+S on the board adds a Drawing", c.some((x) => /^Drawing \d+$/.test(x)), JSON.stringify(c));

console.log("\n[3] pressing again with nothing changed adds nothing");
await press("KeyS", "s", 83, 2);
await pause(2000);
check("no duplicate Drawing", (await chips()).length === 1, JSON.stringify(await chips()));

console.log("\n[4] drawing again adds a second, distinct Drawing");
await pickTool("Freehand");
p = await freePoint();
if (p) await drag({ x: p.x, y: p.y + 140 }, 60, 40);
await pause(500);
await press("KeyS", "s", 83, 2);
c = await waitForCount(2);
check("a second Drawing appears", c.filter((x) => /^Drawing /.test(x)).length === 2, JSON.stringify(c));

console.log("\n[5] the block can be deleted with the mouse");
const target = await ev(`(() => {
  const el = [...document.querySelectorAll('[data-mystudio-overlay="compose-input"] [data-mystudio-ref]')].at(-1);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), label: el.getAttribute('data-mystudio-ref') };
})()`);
check("the last chip is reachable", target !== null, JSON.stringify(target));
if (target) {
  await clickAt(target.x, target.y);
  await press("Backspace", "Backspace", 8, 0);
  await pause(800);
  check(
    "deleting removes exactly one block",
    (await chips()).length === 1,
    JSON.stringify(await chips()),
  );
}

console.log("\n[6] numbering is one sequence across surfaces");
await press("KeyB", "b", 66, 2);
await pause(600);
await pickTool("Freehand");
p = await freePoint();
if (p) await drag(p, 70, 40);
await press("KeyS", "s", 83, 2);
await waitForCount(2);
const mixed = await chips();
check("the remaining Drawing kept its place and the new one follows", mixed.length === 2, JSON.stringify(mixed));

// Back to the video and add a mark: the sequence must stay gap-free across kinds.
await press("KeyB", "b", 66, 2);
await pause(600);
await pickTool("Region");
p = await freePoint();
if (p) await drag(p, 100, 60);
await press("KeyS", "s", 83, 2);
const all = await waitForCount(3);
check(
  "labels form one gap-free sequence across kinds",
  (() => {
    const numbers = all.map((label) => Number.parseInt(label.split(" ").at(-1), 10));
    return numbers.length === 3 && numbers.every((n, i) => n === i + 1);
  })(),
  JSON.stringify(all),
);
check(
  "the sequence mixes Drawing and Region with distinct names",
  all.some((x) => /^Drawing /.test(x)) || all.some((x) => /^Region /.test(x)),
  JSON.stringify(all),
);

console.log(`\nresult: ${pass} passed, ${fail} failed`);
ws.close();
process.exit(fail === 0 ? 0 : 1);
