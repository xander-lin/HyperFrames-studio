/**
 * Runtime check: the pointer says what the next press will do.
 *
 * The reported defect: **every** tool showed a crosshair, everywhere — including over the
 * empty margins and the panel gaps. Two causes:
 *
 * 1. the canvas returned one cursor for four different gestures;
 * 2. the input shield (a transparent, full-viewport layer) also declared `crosshair`, and
 *    since it covers the whole window, that is the cursor the user mostly saw.
 *
 * What must be true:
 *
 * 1. the shield is not a crosshair;
 * 2. each drawing tool has its own pointer, and `select` looks unarmed
 *    (`default`), because it draws nothing;
 * 3. the custom cursors are real `data:` URLs with a hotspot, so the nib and the ring
 *    land where the gesture starts rather than at the icon's centre.
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

const capturing = () =>
  ev(`document.querySelector('[data-mystudio-overlay="surface"]')?.getAttribute('data-capturing')`);
if ((await capturing()) !== "true") await key("KeyA", "a", 65, 2);
await pause(500);

const shieldCursor = () =>
  ev(`getComputedStyle(document.querySelector('[data-mystudio-overlay="shield"]')).cursor`);
const canvasCursor = () =>
  ev(`(() => {
    const c = document.querySelector('[data-mystudio-overlay="annotation-canvas"]');
    return c ? getComputedStyle(c).cursor : null;
  })()`);
const pickTool = async (label) => {
  await ev(`[...document.querySelectorAll('[data-mystudio-overlay="dock"] button')].find((b) => b.getAttribute('aria-label') === ${JSON.stringify(label)})?.click()`);
  await pause(400);
};

console.log("\n[1] the input shield is not a crosshair");
const shield = await shieldCursor();
check("the shield uses the platform cursor", shield === "default", JSON.stringify(shield));

console.log("\n[2] each tool has its own pointer");
const cursors = {};
for (const label of ["Region", "Arrow", "Freehand", "Eraser", "Select"]) {
  await pickTool(label);
  cursors[label] = String(await canvasCursor());
}
for (const [label, value] of Object.entries(cursors)) {
  console.log(`    ${label}: ${value.slice(0, 46)}`);
}
check("Region is a crosshair, which is what a box means", cursors.Region === "crosshair", cursors.Region.slice(0, 40));
check("Freehand is not a crosshair", cursors.Freehand !== "crosshair", cursors.Freehand.slice(0, 40));
check("Arrow is not a crosshair", cursors.Arrow !== "crosshair", cursors.Arrow.slice(0, 40));
check("Eraser is not a crosshair", cursors.Eraser !== "crosshair", cursors.Eraser.slice(0, 40));
check(
  "the four drawing tools are distinguishable",
  new Set([cursors.Region, cursors.Arrow, cursors.Freehand, cursors.Eraser]).size === 4,
  JSON.stringify(Object.fromEntries(Object.entries(cursors).map(([k, v]) => [k, v.slice(0, 20)]))),
);
check("Select looks unarmed, because it draws nothing", cursors.Select === "default", cursors.Select.slice(0, 40));

console.log("\n[3] the custom cursors are real, with a hotspot");
for (const label of ["Arrow", "Freehand", "Eraser"]) {
  const value = cursors[label];
  /*
   * A malformed cursor string is silently ignored by the browser and replaced with an
   * arrow — no error anywhere — so the shape of the value is worth asserting.
   */
  check(`${label} is a data URL`, value.startsWith("url(\"data:image/svg+xml"), value.slice(0, 40));
  check(`${label} declares a hotspot and a fallback`, /\)\s*\d+\s+\d+\s*,\s*[a-z-]+$/.test(value), value.slice(-32));
}

// Leave the tool where it was found: freehand is the layer's default in practice.
await pickTool("Freehand");

console.log(`\nresult: ${pass} passed, ${fail} failed`);
ws.close();
process.exit(fail === 0 ? 0 : 1);
