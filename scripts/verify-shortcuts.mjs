/**
 * Runtime verification through the Chrome DevTools Protocol.
 *
 * No screenshots and no reading of pixels: every assertion is a **state** query, so this
 * runs unattended and fails loudly instead of needing someone to look at a picture. It is
 * the automated counterpart to the unit tests — those pin the logic, this pins the wiring
 * in a real Electron window.
 *
 * Prerequisites:
 *   1. the app is running with `--remote-debugging-port=9222`
 *   2. nothing else has claimed the page target
 *
 * Exits non-zero when any check fails, so it can gate a release.
 */
// Headless-ish verification through CDP: no screenshots, only state assertions.
const targets=await(await fetch("http://127.0.0.1:9222/json/list")).json();
const ws=new WebSocket(targets.find(t=>t.type==="page").webSocketDebuggerUrl);
let n=0;const pend=new Map();
function send(m,x={}){const id=++n;ws.send(JSON.stringify({id,method:m,params:x}));return new Promise((r,j)=>pend.set(id,{r,j}));}
ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&pend.has(m.id)){const{r,j}=pend.get(m.id);pend.delete(m.id);m.error?j(new Error(JSON.stringify(m.error))):r(m.result);}};
await new Promise(r=>ws.onopen=r);
const ev=async x=>{const r=await send("Runtime.evaluate",{expression:x,returnByValue:true,awaitPromise:true});return r.exceptionDetails?{error:r.exceptionDetails.exception?.description}:r.result.value;};
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const key=async(code,k,vk,mods)=>{await send("Input.dispatchKeyEvent",{type:"keyDown",code,key:k,windowsVirtualKeyCode:vk,modifiers:mods});await send("Input.dispatchKeyEvent",{type:"keyUp",code,key:k,windowsVirtualKeyCode:vk,modifiers:mods});await pause(650);};

let pass=0,fail=0;
const check=(name,ok,extra="")=>{ if(ok){pass++;console.log("  ok  "+name);} else {fail++;console.log("  FAIL "+name+" "+extra);} };

const tabs=()=>ev(`[...document.querySelectorAll('[role="tab"][aria-selected="true"]')].map(x=>x.textContent)`);
const tools=()=>ev(`(()=>{const d=document.querySelector('[data-mystudio-overlay="dock"]');return [...d.querySelectorAll('button[aria-pressed="true"]')].map(b=>b.getAttribute('aria-label'))})()`);
const capturing=()=>ev(`document.querySelector('[data-mystudio-overlay="surface"]')?.getAttribute('data-capturing')`);
const boardOn=()=>ev(`!!document.querySelector('[data-mystudio-overlay="dock-board-clear"]')`);
const labels=()=>ev(`(()=>{const d=document.querySelector('[data-mystudio-overlay="dock"]');return [...d.querySelectorAll('button')].map(b=>b.getAttribute('aria-label'))})()`);

/**
 * Bring the app to a known state before asserting anything.
 *
 * Every check below is of the form "pressing X *changes* Y", so the starting state must
 * be established rather than assumed: a previous run may have left the board open or the
 * annotation mode active, and then "does Ctrl+B open the board" is answered by the wrong
 * reason.
 *
 * Written as explicit set-and-verify rather than as toggles, because a toggle-based reset
 * that guesses wrong flips the state it was meant to normalise.
 */
async function setAnnotating(wanted) {
  /*
   * Take the caret out of any text field first.
   *
   * A focused field owns `Ctrl+A` as "select all" (a deliberate rule), so a leftover caret
   * from a previous script makes activation impossible — and the failure reads like a broken
   * shortcut rather than a dirty starting state.
   */
  await ev(`document.activeElement?.blur?.(); document.body.focus?.(); true`);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const now = await ev(`document.querySelector('[data-mystudio-overlay="surface"]')?.getAttribute('data-capturing')`);
    if ((now === "true") === wanted) return;
    await key("KeyA", "a", 65, 2);
  }
  throw new Error(`could not set annotating=${wanted}`);
}

async function setBoard(wanted) {
  await setAnnotating(true);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const now = await ev(`!!document.querySelector('[data-mystudio-overlay="dock-board-clear"]')`);
    if (now === wanted) return;
    await key("KeyB", "b", 66, 2);
  }
  throw new Error(`could not set board=${wanted}`);
}

/* End **inactive, on the video**: check [1] exists to prove Ctrl+A activates, which is
 * only a real test from the inactive state. */
await setBoard(false);
await setAnnotating(false);

console.log("\n[1] activation");
await key("KeyA","a",65,2);
check("Ctrl+A activates", await capturing()==="true");

console.log("\n[2] the tool keys are ours alone");
/*
 * `Ctrl+1` / `Ctrl+2` belong to Studio (its tab shortcuts); this layer's tools live on
 * `Ctrl+Shift+1..5`, which Studio's grammar cannot even express. So while the layer is
 * active, pressing `Ctrl+1` must do **nothing at all** — no tool change — and Studio must not
 * see it either (it is blocked while active).
 *
 * The earlier version of this check asserted "the Studio tab does not change", which was a
 * statement about Studio's own key map. That map is no longer reshuffled — this layer blocks
 * by state instead of stealing keys — so the meaningful assertion is about our own tools.
 */
const activeBefore=await tools();
await key("Digit1","1",49,2);
check("active: Ctrl+1 does not pick a tool", JSON.stringify(await tools())===JSON.stringify(activeBefore));
await key("Digit2","2",50,2);
check("active: Ctrl+2 does not pick a tool", JSON.stringify(await tools())===JSON.stringify(activeBefore));

console.log("\n[3] tools on their own chords");
await key("Digit1","!",49,10);
check("Ctrl+Shift+1 -> Region", (await tools()).includes("Region"));
await key("Digit2","@",50,10);
check("Ctrl+Shift+2 -> Arrow", (await tools()).includes("Arrow"));
await key("Digit3","#",51,10);
check("Ctrl+Shift+3 -> Freehand", (await tools()).includes("Freehand"));

console.log("\n[4] board toggle and separation");
const boardWas=await boardOn();
await key("KeyB","b",66,2);
check("Ctrl+B toggles the board", (await boardOn())!==boardWas);
await key("KeyB","b",66,2);
check("Ctrl+B toggles back", (await boardOn())===boardWas);
check("no page buttons exist", !(await labels()).some(l=>l==="Previous board page"||l==="Next board page"));
/*
 * Close anything a previous step (or a previous run) left open, so "not always-open" is
 * about the design rather than about how this script happened to start.
 */
await ev(`document.querySelector('[data-mystudio-overlay="pen-colour-trigger"][aria-expanded="true"]')?.click()`);
await pause(250);
check("pen palette is not always-open", await ev(`document.querySelector('[data-mystudio-overlay="pen-palette"]')===null`));

console.log("\n[5] the pen is two controls: colour and thickness");
await key("KeyB","b",66,2); // on board
/* Normalise: the panel must be closed before the check that it opens. */
if (await ev(`!!document.querySelector('[data-mystudio-overlay="pen-palette"]')`)) {
  await ev(`document.querySelector('[data-mystudio-overlay="pen-colour-trigger"]')?.click()`);
  await pause(250);
}
await ev(`document.querySelector('[data-mystudio-overlay="pen-colour-trigger"]')?.click()`);
await pause(350);
check("colour panel opens from its own trigger", await ev(`!!document.querySelector('[data-mystudio-overlay="pen-palette"]')`));
const swatches=await ev(`[...document.querySelectorAll('[data-mystudio-overlay="pen-palette"] button')].map(b=>b.getAttribute('aria-label'))`);
check(
  "it holds the colours",
  swatches.includes("Green") && swatches.includes("Black"),
  JSON.stringify(swatches),
);
/*
 * Thickness is **not** in here. It has its own button: keeping the two together made the
 * more frequently used control the hidden one.
 */
check(
  "it does not hold the thickness control",
  (await ev(`!!document.querySelector('[data-mystudio-overlay="pen-palette"] [data-mystudio-overlay="pen-width-step"]')`))===false,
);
await ev(`[...document.querySelectorAll('[data-mystudio-overlay="pen-palette"] button')].find(b=>b.getAttribute('aria-label')==='Blue')?.click()`);
await pause(350);
check("picking a colour closes it", await ev(`document.querySelector('[data-mystudio-overlay="pen-palette"]')===null`));
const triggerTitle = await ev(`document.querySelector('[data-mystudio-overlay="pen-colour-trigger"]')?.title ?? ""`);
check("the colour trigger reports the pen", String(triggerTitle).includes("Blue"), `got ${JSON.stringify(triggerTitle)}`);

await ev(`document.querySelector('[data-mystudio-overlay="pen-width-trigger"]')?.click()`);
await pause(350);
check("thickness opens its own panel", await ev(`!!document.querySelector('[data-mystudio-overlay="pen-width-panel"]')`));
check(
  "it has two step arrows",
  (await ev(`document.querySelectorAll('[data-mystudio-overlay="pen-width-panel"] [data-mystudio-overlay="pen-width-step"]').length`))===2,
);
await ev(`document.querySelector('[data-mystudio-overlay="pen-width-trigger"]')?.click()`);
await pause(250);

console.log("\n[6] selection policy");
check("root is not selectable", (await ev(`getComputedStyle(document.getElementById('root')).userSelect`))==="none");
check("prompt box is selectable", (await ev(`getComputedStyle(document.querySelector('[data-mystudio-overlay="compose-input"]')).userSelect`))==="text");

console.log("\n[7] deactivate");
/*
 * Start with nothing selected. A leftover selection is not part of the scene: an earlier
 * check may have selected the prompt text, and `Ctrl+A` on a stale selection is a different
 * situation from "the user clicks empty space and presses the chord".
 */
await ev(`window.getSelection()?.removeAllRanges()`);
await key("KeyA","a",65,2);
check("Ctrl+A deactivates", await capturing()==="false");
check("Ctrl+A selected nothing", (await ev(`String(window.getSelection())`))==="");

console.log("\n[N] Ctrl+A belongs to the text field while typing");
/*
 * The reported defect: with the caret in the prompt box, `Ctrl+A` ran this layer's
 * activation toggle. The prompt box closed mid-sentence and nothing could be selected —
 * one chord, two meanings, and the wrong one won.
 */
{
  const capNow = () => ev(`document.querySelector('[data-mystudio-overlay="surface"]')?.getAttribute('data-capturing')`);
  const pressCtrlA = async () => {
    await send("Input.dispatchKeyEvent", { type: "keyDown", code: "KeyA", key: "a", windowsVirtualKeyCode: 65, modifiers: 2 });
    await send("Input.dispatchKeyEvent", { type: "keyUp", code: "KeyA", key: "a", windowsVirtualKeyCode: 65, modifiers: 2 });
    await pause(800);
  };

  // Known starting state: annotating.
  if ((await capNow()) !== "true") await pressCtrlA();
  await pause(500);
  check("annotation mode is on to begin with", (await capNow()) === "true", await capNow());

  // Put the caret in the prompt box and give it text to select.
  const boxRect = await ev(`(() => {
    const ed = document.querySelector('[data-mystudio-overlay="compose-input"]');
    if (!ed) return null;
    const r = ed.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  if (boxRect) {
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: boxRect.x, y: boxRect.y, button: "left", clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: boxRect.x, y: boxRect.y, button: "left", clickCount: 1 });
    await pause(400);
    await ev(`(() => {
      const ed = document.querySelector('[data-mystudio-overlay="compose-input"]');
      ed.textContent = 'hello world';
      ed.focus();
      const s = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(ed);
      s.removeAllRanges();
      s.addRange(range);
      s.collapseToEnd();
    })()`);
    await pause(300);
    const focused = await ev(`(() => { const a = document.activeElement; return { ce: a.isContentEditable, tag: a.tagName }; })()`);
    check("the caret is in the prompt box", focused.ce === true, JSON.stringify(focused));

    await pressCtrlA();
    check("Ctrl+A does not leave annotation mode", (await capNow()) === "true", await capNow());
    const selected = await ev(`window.getSelection()?.toString() ?? null`);
    check("Ctrl+A selects the text instead", selected === "hello world", JSON.stringify(selected));

    // Outside a text field the chord must still toggle.
    await ev(`document.activeElement.blur?.()`);
    await pause(300);
    await pressCtrlA();
    check("Ctrl+A outside text still toggles annotate", (await capNow()) === "false", await capNow());
    // Leave it annotating again for whatever runs next.
    await pressCtrlA();
  } else {
    check("the prompt box exists", false, "no compose-input");
  }
}

console.log(`\nresult: ${pass} passed, ${fail} failed`);
ws.close();
process.exit(fail===0?0:1);
