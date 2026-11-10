/**
 * Runtime check: **deleting a block does not move the caret to the front of the prompt**.
 *
 * This is the reported defect: "every time I delete a block, e.g. Arrow 4, the cursor
 * immediately jumps to the very front of all the text". Deleting a block rewrites the
 * prompt (the reference goes, later blocks renumber), so the editor rebuilds its children —
 * and the caret used to be dropped at the start because the nodes it lived in were replaced
 * (found.md F-116).
 *
 * The check is done on the **selection's text offset within its own text node**, because
 * that is the thing the user sees: the caret must still be standing in the same sentence.
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
const chips = () =>
  ev(`[...document.querySelectorAll('[data-mystudio-overlay="compose-input"] [data-mystudio-ref]')].map((atom) => atom.getAttribute('data-mystudio-ref'))`);
const boardOn = () => ev(`!!document.querySelector('[data-mystudio-overlay="dock-page-panel"]')`);
const pickTool = async (label) => {
  await ev(`[...document.querySelectorAll('[data-mystudio-overlay="dock"] button')].find((b) => b.getAttribute('aria-label') === ${JSON.stringify(label)})?.click()`);
  await pause(350);
};
/**
 * A point on the picture that nothing is covering.
 *
 * The prompt box is a floating panel over the stage, so the search has to start from a state
 * where the box is **not** under the pointer — the same lesson as `verify-prompt.mjs`: each
 * script establishes its own starting state instead of inheriting whatever the last one left.
 */
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
  await pause(1400);
};

/** Poll until `probe` is truthy, or the deadline passes. Disk writes are asynchronous. */
const until = async (probe, timeoutMs = 8000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) return value;
    await pause(250);
  }
};

/**
 * Remove every block, one at a time, through our own deletion path.
 *
 * `execCommand('selectAll')` + `delete` is not enough: a ref atom is `contenteditable=false`,
 * and the browser leaves it behind. The script is expected to run against a live app that a
 * previous run (or the user) may have left blocks in, so it has to establish its own clean
 * state rather than assume it.
 */
const clearAllBlocks = async () => {
  for (let step = 0; step < 30; step += 1) {
    const list = await chips();
    if (list.length === 0) return true;
    const placedAgain = await ev(`(() => {
      const box = document.querySelector('[data-mystudio-overlay="compose-input"]');
      const atoms = box?.querySelectorAll('[data-mystudio-ref]');
      const last = atoms && atoms[atoms.length - 1];
      if (!last) return false;
      box.focus();
      const r = document.createRange();
      r.setStartAfter(last);
      r.collapse(true);
      window.getSelection().removeAllRanges();
      window.getSelection().addRange(r);
      return true;
    })()`);
    if (!placedAgain) return false;
    await press("Backspace", "Backspace", 8, 0);
    await pause(400);
  }
  return (await chips()).length === 0;
};

// ── [0] known state ───────────────────────────────────────────────────────
console.log("\n[0] known state");
if (!(await ev(`!!document.querySelector('[data-mystudio-overlay="surface"]')`))) {
  await press("KeyH", "h", 72, 2);
}
/*
 * Leave the prompt box **before** activating.
 *
 * While the caret is in a text field, `Ctrl+A` means "select all" and is handed back to the
 * field — that is a product rule, not a bug (found.md F-097). So a script that presses `A`
 * with the caret still in the box is testing the field, not the layer, and the activation
 * silently does nothing.
 */
await ev(`(() => { document.activeElement?.blur?.(); return true; })()`);
await pause(200);
if ((await capturing()) !== "true") await press("KeyA", "a", 65, 2);
check("the layer is active", (await capturing()) === "true");
if (await boardOn()) await press("KeyB", "b", 66, 2);
check("the video surface is showing", (await boardOn()) === false);
/*
 * Take the caret out of the prompt box before looking for drawable space.
 *
 * The box floats over the picture; while it holds focus it also owns the pointer in the area it
 * covers, so `elementFromPoint` keeps answering "the box" and no point is reachable.
 */
await ev(`(() => { document.activeElement?.blur?.(); return true; })()`);
await pause(150);

await ev(`(() => {
  const box = document.querySelector('[data-mystudio-overlay="compose-input"]');
  if (!box) return false;
  box.focus();
  document.execCommand('selectAll');
  document.execCommand('delete');
  return true;
})()`);
await pause(300);
check("the prompt box starts empty", await clearAllBlocks(), JSON.stringify(await chips()));

// ── [1] the reported case: a prompt of nothing but blocks ────────────────
console.log("\n[1] caret after the last block, then delete one");
await pickTool("Freehand");
const spot = await freePoint();
if (!spot) {
  check("the picture is drawable", false, "no reachable point");
} else {
  await drag(spot, 70, 40);

  await press("KeyS", "s", 83, 2);
  const first = await until(async () => {
    const list = await chips();
    return list.length === 1 ? list : null;
  });
  check("the first capture block exists", Array.isArray(first), JSON.stringify(await chips()));

  /*
   * Draw again and add again, so the box holds `Capture 1` / `Capture 2` **and no text**:
   * that is the shape the user reported, and the one where a character-based anchor knows
   * nothing at all (found.md F-117).
   */
  await drag(spot, -60, 50);
  await press("KeyS", "s", 83, 2);
  const two = await until(async () => {
    const list = await chips();
    return list.length === 2 ? list : null;
  });
  check("two blocks, no text", Array.isArray(two), JSON.stringify(await chips()));
  check(
    "the box really has no text besides the blocks",
    (await ev(`document.querySelector('[data-mystudio-overlay="compose-input"]').innerText.replace(/Capture \\d+/g, '').trim()`)) === "",
  );

  /** Put the caret just after the last block, which is where the user left it. */
  const placed = await ev(`(() => {
    const box = document.querySelector('[data-mystudio-overlay="compose-input"]');
    const atoms = box?.querySelectorAll('[data-mystudio-ref]');
    const last = atoms && atoms[atoms.length - 1];
    if (!last) return false;
    box.focus();
    const r = document.createRange();
    r.setStartAfter(last);
    r.collapse(true);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(r);
    return true;
  })()`);
  check("the caret can be placed after the last block", placed === true);

  const beforeCount = (await chips()).length;
  await press("Backspace", "Backspace", 8, 0);
  await pause(700);
  const afterCount = (await chips()).length;
  check("Backspace removed exactly one block", afterCount === beforeCount - 1, `${beforeCount} -> ${afterCount}`);

  /*
   * The assertion that fails on the bug: the caret must **not** be before every surviving
   * block. That is literally `|Capture 1`, which is what the user saw.
   */
  const where = await ev(`(() => {
    const box = document.querySelector('[data-mystudio-overlay="compose-input"]');
    const s = window.getSelection();
    if (!box || !s || s.rangeCount === 0) return { missing: true };
    const caret = s.getRangeAt(0);
    const atoms = box.querySelectorAll('[data-mystudio-ref]');
    let blocksBefore = 0;
    for (const atom of atoms) {
      const probe = document.createRange();
      probe.setStartAfter(atom);
      probe.collapse(true);
      if (probe.compareBoundaryPoints(Range.START_TO_START, caret) <= 0) blocksBefore += 1;
    }
    return { blocksBefore, total: atoms.length };
  })()`);
  check(
    "the caret is not in front of every block (the reported symptom)",
    where !== null && where.blocksBefore > 0,
    JSON.stringify(where),
  );
  check(
    "the caret is after the surviving block",
    where !== null && where.total > 0 && where.blocksBefore === where.total,
    JSON.stringify(where),
  );
}

/** Put the caret just after the block at `index` (0-based), and report where it landed. */
const caretAfterBlock = async (index) =>
  ev(`(() => {
    const box = document.querySelector('[data-mystudio-overlay="compose-input"]');
    const atoms = box?.querySelectorAll('[data-mystudio-ref]');
    const target = atoms && atoms[${index}];
    if (!target) return false;
    box.focus();
    const r = document.createRange();
    r.setStartAfter(target);
    r.collapse(true);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(r);
    return true;
  })()`);

/** How many blocks are at or before the caret. */
const blocksBeforeCaret = () =>
  ev(`(() => {
    const box = document.querySelector('[data-mystudio-overlay="compose-input"]');
    const s = window.getSelection();
    if (!box || !s || s.rangeCount === 0) return { missing: true };
    const caret = s.getRangeAt(0);
    const atoms = box.querySelectorAll('[data-mystudio-ref]');
    let before = 0;
    for (const atom of atoms) {
      const probe = document.createRange();
      probe.setStartAfter(atom);
      probe.collapse(true);
      if (probe.compareBoundaryPoints(Range.START_TO_START, caret) <= 0) before += 1;
    }
    return { before, total: atoms.length };
  })()`);

// ── [2] deleting a block in the **middle** keeps the caret in place ───────
console.log("\n[2] three blocks, caret after the middle one, delete it");
{
  /*
   * Three blocks are needed to tell the two restore rules apart. With two, "clamp to the
   * last survivor" happens to give the right answer for both; only removing a block that has
   * a survivor on **each** side exposes an off-by-one, and an off-by-one here silently moves
   * the caret past a block the user did not delete.
   */
  /*
   * Start from an empty box: section [1] left one block behind, and this section needs exactly
   * three to tell "stay between the survivors" from an off-by-one.
   */
  check("the box is cleared for part 2", await clearAllBlocks(), JSON.stringify(await chips()));

  /*
   * Each capture needs a drawing that differs from the last, or `Ctrl+S` sees an unchanged
   * frame and correctly adds nothing — the signature is "frame + ink + selection", not "how
   * many times the key was pressed" (found.md F-101).
   */
  for (const [dx, dy] of [[60, 70], [110, -40], [-70, 90]]) {
    await drag(spot, dx, dy);
    await pause(300);
    await press("KeyS", "s", 83, 2);
    await pause(600);
  }
  const three = await until(async () => {
    const list = await chips();
    return list.length === 3 ? list : null;
  });
  check("three blocks", Array.isArray(three), JSON.stringify(await chips()));

  if (Array.isArray(three)) {
    check("the caret can be placed after the middle block", (await caretAfterBlock(1)) === true);
    const before = (await blocksBeforeCaret()).before;
    check("the caret counts the middle block", before === 2, JSON.stringify(await blocksBeforeCaret()));

    await press("Backspace", "Backspace", 8, 0);
    await pause(700);
    const remaining = await chips();
    check("one block was removed", remaining.length === 2, JSON.stringify(remaining));

    /*
     * The caret was after block 2 of 3. Removing it leaves blocks 1 and 3, and the caret
     * belongs **between them** — not after block 3, which is where an off-by-one lands.
     */
    const where = await blocksBeforeCaret();
    check(
      "the caret sits between the two survivors",
      where !== null && where.before === 1,
      JSON.stringify(where),
    );
  }
}

// ── [3] the text itself is untouched ─────────────────────────────────────
console.log("\n[3] deleting a block does not delete the user's words");
const text = await ev(`document.querySelector('[data-mystudio-overlay="compose-input"]').innerText`);
check("no stray text was left behind or removed", text.trim().replace(/Capture \d+/g, "").trim() === "", JSON.stringify(text));

console.log(`\nresult: ${passed} passed, ${failed} failed`);
ws.close();
process.exit(failed === 0 ? 0 : 1);
