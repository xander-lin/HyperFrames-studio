const targets=await(await fetch("http://127.0.0.1:9222/json/list")).json();
const ws=new WebSocket(targets.find(t=>t.type==="page").webSocketDebuggerUrl);
let n=0;const pend=new Map();
function send(m,x={}){const id=++n;ws.send(JSON.stringify({id,method:m,params:x}));return new Promise((r,j)=>pend.set(id,{r,j}));}
ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&pend.has(m.id)){const{r,j}=pend.get(m.id);pend.delete(m.id);m.error?j(new Error(JSON.stringify(m.error))):r(m.result);}};
await new Promise(r=>ws.onopen=r);
const ev=async x=>{const r=await send("Runtime.evaluate",{expression:x,returnByValue:true,awaitPromise:true});return r.exceptionDetails?{error:r.exceptionDetails.exception?.description}:r.result.value;};
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const key=async(code,k,vk,mods)=>{await send("Input.dispatchKeyEvent",{type:"keyDown",code,key:k,windowsVirtualKeyCode:vk,modifiers:mods});await send("Input.dispatchKeyEvent",{type:"keyUp",code,key:k,windowsVirtualKeyCode:vk,modifiers:mods});await pause(700);};
let pass=0,fail=0;
const check=(name,ok,extra="")=>{ if(ok){pass++;console.log("  ok  "+name);} else {fail++;console.log("  FAIL "+name+" "+extra);} };

/*
 * Start from a known state: annotating, and showing the **video** — section [2] asserts that
 * the page panel is absent there, which only means something if the video is what is up.
 */
for(let i=0;i<3;i++){
  if(await ev(`!!document.querySelector('[data-mystudio-overlay="dock-page-panel"]')`)) await key("KeyB","b",66,2);
}
if(await ev(`document.querySelector('[data-mystudio-overlay="surface"]')?.getAttribute('data-capturing')`)!=="true") await key("KeyA","a",65,2);
if(await ev(`!!document.querySelector('[data-mystudio-overlay="dock-page-panel"]')`)) await key("KeyB","b",66,2);

console.log("\n[1] project directory is shown");
/* The project block lives inside the sprite's Interface tab, which starts collapsed. */
await ev(`document.querySelector('[data-mystudio-overlay="sprite"] button')?.click()`);
await pause(400);
const proj = await ev(`(()=>{const el=document.querySelector('[data-mystudio-overlay="sprite-project"]');return el?el.textContent:null})()`);
check("sprite shows the open project", proj!==null && proj.length>0, JSON.stringify(proj));
check("it names the project", String(proj).includes("deck-avl"), JSON.stringify(proj));
check("it shows the full path", String(proj).includes("/home/work/Documents/DataStruct"), JSON.stringify(proj));
console.log("    text:", JSON.stringify(proj));
/* Close it again so the rest of the run is not clicking through a panel. */
await ev(`document.querySelector('[data-mystudio-overlay="sprite"] button')?.click()`);
await pause(300);

console.log("\n[2] the pager appears only on the board");
check("no page panel on the video", (await ev(`!!document.querySelector('[data-mystudio-overlay="dock-page-panel"]')`))===false);
await key("KeyB","b",66,2);
await pause(700);
check("the page panel is open on the board without any click", (await ev(`!!document.querySelector('[data-mystudio-overlay="dock-page-panel"]')`))===true);

console.log("\n[3] previous / position / next, not one button per page");
const shape = await ev(`(()=>{
  const panel=document.querySelector('[data-mystudio-overlay="dock-page-panel"]');
  if(!panel) return null;
  const steps=[...panel.querySelectorAll('[data-mystudio-overlay="dock-page-step"]')].map(b=>b.getAttribute('aria-label'));
  const num=panel.querySelector('[data-mystudio-overlay="dock-page-number"]');
  return {steps, number: num?num.textContent.trim():null};
})()`);
check("it has exactly two arrows", shape && shape.steps.length===2, JSON.stringify(shape));
check("one goes back, one goes forward", !!shape && shape.steps.includes("Previous page") && shape.steps.includes("Next page"), JSON.stringify(shape?.steps));
check("it shows the position out of the total", !!shape && /^\d+\s*\/\s*\d+$/.test(shape.number ?? ""), JSON.stringify(shape?.number));
console.log("    pager:", JSON.stringify(shape));

console.log("\n[4] the arrows turn the board's own pages");
const pageCount=()=>ev(`(()=>{const n=document.querySelector('[data-mystudio-overlay="dock-page-number"]');return n?Number(n.textContent.trim().split("/")[1]):0})()`);
/** The number before the slash: "3 / 30" is position 3. */
const pageNumber=()=>ev(`(()=>{const n=document.querySelector('[data-mystudio-overlay="dock-page-number"]');return n?n.textContent.trim().split("/")[0].trim():null})()`);
const step=async(label)=>{
  const c=await ev(`(()=>{const b=[...document.querySelectorAll('[data-mystudio-overlay="dock-page-step"]')].find(x=>x.getAttribute('aria-label')===${JSON.stringify(label)});if(!b||b.disabled)return null;const r=b.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
  if(!c) return false;
  await send("Input.dispatchMouseEvent",{type:"mousePressed",x:c.x,y:c.y,button:"left",clickCount:1});
  await send("Input.dispatchMouseEvent",{type:"mouseReleased",x:c.x,y:c.y,button:"left",clickCount:1});
  await pause(1500);
  return true;
};
const videoTime=()=>ev(`(()=>{const all=[...document.querySelectorAll('body *')].filter(e=>e.children.length===0 && /^\\d\\d:\\d\\d$/.test((e.textContent||'').trim()));return all.length?all[0].textContent.trim():null})()`);
/* Rewind first: "previous" is disabled on page 1, so a fresh run must start elsewhere. */
for (let i=0;i<12;i+=1) { if(!(await step("Previous page"))) break; }
const atStart = await pageNumber();
check("previous is disabled on the first page", (await ev(`(()=>{const b=[...document.querySelectorAll('[data-mystudio-overlay="dock-page-step"]')].find(x=>x.getAttribute('aria-label')==='Previous page');return b?b.disabled:null})()`))===true);
check("it lands on page 1", atStart==="1", JSON.stringify(atStart));

/*
 * Adding pages is how the deck grows, and it has no limit: the count is the board's own,
 * not the timeline's scene count.
 */
const addPage = async () => {
  const c = await ev(`(() => {
    const b = document.querySelector('[data-mystudio-overlay="dock-page-add"]');
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  if (!c) return false;
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: c.x, y: c.y, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: c.x, y: c.y, button: "left", clickCount: 1 });
  await pause(450);
  return true;
};
const countBefore = await pageCount();
const pageBefore = await pageNumber();
check("there is a way to add a page", await addPage());
check("adding a page grows the deck", (await pageCount()) === countBefore + 1, `${countBefore} -> ${await pageCount()}`);
/*
 * A new page goes **after the current one**, not at the end of the deck: "new page"
 * continues where the user is. We rewound to page 1 above, so the fresh sheet is page 2.
 */
check("and turns to the new page", (await pageNumber()) === String(Number(pageBefore) + 1), `${pageBefore} -> ${await pageNumber()}`);

check("back returns one page", (await step("Previous page")) && (await pageNumber()) === pageBefore, JSON.stringify(await pageNumber()));

/*
 * Ink count, ignoring a 3px border: the canvas has a dark edge row that is not ink.
 */
const inkCount=()=>ev(`(()=>{
  const c=document.querySelector('[data-mystudio-overlay="annotation-canvas"]');
  const x=c.getContext('2d');
  const m=3;
  const d=x.getImageData(m,m,Math.max(1,c.width-2*m),Math.max(1,c.height-2*m)).data;
  let n=0;
  for(let i=0;i<d.length;i+=4){if(Math.abs(d[i]-246)>20||Math.abs(d[i+1]-244)>20||Math.abs(d[i+2]-239)>20)n++;}
  return n;
})()`);
console.log("\n[5] ink stays on its own page after stepping away");
/*
 * A **new** page is used, not page 3.
 *
 * The board store lives as long as the app does, so earlier runs leave ink on whatever
 * pages they touched; "the last page is blank" was measuring that residue and calling it a
 * leak. A page created here is empty by construction, which is the only way this check can
 * mean anything.
 */
check("a fresh page can be added", await addPage());
const drawnPage = await pageNumber();
const countOn = async () => Number(await inkCount());
check("the fresh page starts empty", (await countOn()) === 0, `pixels ${await countOn()}`);

await ev(`[...document.querySelectorAll('[data-mystudio-overlay="dock"] button')].find(b=>b.getAttribute('aria-label')==='Freehand')?.click()`);
await pause(300);
/*
 * Pick a spot the canvas **actually receives**. The floating panels move with the layout,
 * so a hard-coded corner drifts under the prompt box and the stroke lands in the text field
 * instead of on the page — which looks exactly like "the ink was lost".
 */
const b = await ev(`(() => {
  const c = document.querySelector('[data-mystudio-overlay="annotation-canvas"]');
  const r = c.getBoundingClientRect();
  for (let fy = 0.05; fy < 0.9; fy += 0.05) {
    for (let fx = 0.05; fx < 0.9; fx += 0.05) {
      const x = r.x + r.width * fx, y = r.y + r.height * fy;
      if (document.elementFromPoint(x, y) === c) {
        return { x: r.x, y: r.y, w: r.width, h: r.height, x1: x, y1: y };
      }
    }
  }
  return null;
})()`);
check("the canvas is reachable", !!b, "no free spot");
const x1 = b ? b.x1 : 0;
const y1 = b ? b.y1 : 0;
const x2 = x1 + 40;
const y2 = y1 + 30;
await send("Input.dispatchMouseEvent",{type:"mousePressed",x:Math.round(x1),y:Math.round(y1),button:"left",clickCount:1,pointerType:"pen",force:0.3});
for(let i=1;i<=10;i++) await send("Input.dispatchMouseEvent",{type:"mouseMoved",x:Math.round(x1+(x2-x1)*i/10),y:Math.round(y1+(y2-y1)*i/10),button:"left",pointerType:"pen",force:0.4+0.4*i/10});
await send("Input.dispatchMouseEvent",{type:"mouseReleased",x:Math.round(x2),y:Math.round(y2),button:"left",clickCount:1,pointerType:"pen",force:0.3});
await pause(900);

const afterDrawing = Number(await inkCount());
check("ink is visible on the new page", afterDrawing > 200, `pixels ${afterDrawing}`);

/* Step away and note what the neighbour holds; then come back. */
check("can step to the previous page", await step("Previous page"), JSON.stringify(await pageNumber()));
const neighbourInk = Number(await inkCount());
check(
  "the neighbour did not receive the stroke",
  neighbourInk < afterDrawing,
  `neighbour=${neighbourInk} drawn=${afterDrawing}`,
);
check("can step back to the drawn page", await step("Next page"), JSON.stringify(await pageNumber()));
check("the page number is the one that was drawn on", (await pageNumber()) === drawnPage, JSON.stringify(await pageNumber()));
check("the ink is still there", Number(await inkCount()) === afterDrawing, `pixels ${await inkCount()}`);

console.log("\n[6] a compact panel that grows out of the toolbar's side");
const panelShape = await ev(`(() => {
  const p = document.querySelector('[data-mystudio-overlay="dock-page-panel"]');
  const d = document.querySelector('[data-mystudio-overlay="dock"]');
  if (!p || !d) return null;
  const pr = p.getBoundingClientRect();
  const dr = d.getBoundingClientRect();
  const style = getComputedStyle(p);
  return {
    panelW: Math.round(pr.width),
    panelH: Math.round(pr.height),
    dockW: Math.round(dr.width),
    dockH: Math.round(dr.height),
    /* Beside the strip, not on top of it, and part of its subtree (same offset parent). */
    beside: pr.right <= dr.x + 1 || pr.x >= dr.right - 1,
    inside: pr.right <= innerWidth + 1 && pr.bottom <= innerHeight + 1 && pr.left >= -1 && pr.top >= -1,
    /* The panel is a child of the toolbar, so it cannot be a separate floating layer. */
    childOfDock: d.contains(p),
    tinted: style.backgroundColor !== "rgba(0, 0, 0, 0)",
    steps: p.querySelectorAll('[data-mystudio-overlay="dock-page-step"]').length,
    hasAdd: !!p.querySelector('[data-mystudio-overlay="dock-page-add"]'),
  };
})()`);
check("the panel is beside the strip, wider than it", !!panelShape && panelShape.beside && panelShape.panelW > 0, JSON.stringify(panelShape));
check("it is a child of the toolbar, not a separate layer", !!panelShape && panelShape.childOfDock === true, JSON.stringify(panelShape?.childOfDock));
check("it is compact", !!panelShape && panelShape.panelH <= 40, `height=${panelShape?.panelH}`);
check("it is tinted with the accent", !!panelShape && panelShape.tinted === true, JSON.stringify(panelShape?.tinted));
check("it stays inside the window", !!panelShape && panelShape.inside === true, JSON.stringify(panelShape));
check("it holds two arrows and an add button", !!panelShape && panelShape.steps === 2 && panelShape.hasAdd, JSON.stringify(panelShape));

console.log("\n[6b] the panel follows the toolbar");
{
  /*
   * The reported bug: the panel was a body-level portal placed by measuring rectangles, so
   * dragging the toolbar left it behind. Being a child of the toolbar is what fixes it, so
   * what is checked is that the *offset between them* survives a drag.
   */
  const offset = () => ev(`(() => {
    const d = document.querySelector('[data-mystudio-overlay="dock"]').getBoundingClientRect();
    const p = document.querySelector('[data-mystudio-overlay="dock-page-panel"]');
    if (!p) return null;
    const pr = p.getBoundingClientRect();
    return { dx: Math.round(pr.x - d.x), dy: Math.round(pr.y - d.y) };
  })()`);
  const handle = await ev(`(() => {
    const h = document.querySelector('[data-mystudio-overlay="dock"] [data-mystudio-dock-handle]');
    if (!h) return null;
    const r = h.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  const before = await offset();
  if (handle && before) {
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: handle.x, y: handle.y, button: "left", clickCount: 1 });
    for (let i = 1; i <= 10; i += 1) {
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: handle.x, y: handle.y + Math.round(110 * i / 10), button: "left" });
    }
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: handle.x, y: handle.y + 110, button: "left", clickCount: 1 });
    await pause(600);
    const after = await offset();
    check(
      "it keeps its place relative to the toolbar",
      !!after && Math.abs(after.dx - before.dx) <= 1 && Math.abs(after.dy - before.dy) <= 1,
      `${JSON.stringify(before)} -> ${JSON.stringify(after)}`,
    );
  } else {
    check("the panel can be measured", false, "no panel or handle");
  }
}

console.log("\n[7] colour and thickness are two separate controls");
const clickAt = async (selector) => {
  const c = await ev(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  if (!c) return false;
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: c.x, y: c.y, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: c.x, y: c.y, button: "left", clickCount: 1 });
  await pause(500);
  return true;
};

check("there is a colour button", await ev(`!!document.querySelector('[data-mystudio-overlay="pen-colour-trigger"]')`));
check("there is a thickness button", await ev(`!!document.querySelector('[data-mystudio-overlay="pen-width-trigger"]')`));

check("the colour panel opens from its own button", await clickAt('[data-mystudio-overlay="pen-colour-trigger"]'));
const palette = await ev(`(() => {
  const p = document.querySelector('[data-mystudio-overlay="pen-palette"]');
  if (!p) return null;
  const r = p.getBoundingClientRect();
  return {
    h: Math.round(r.height),
    inside: r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1 && r.left >= -1 && r.top >= -1,
    childOfDock: document.querySelector('[data-mystudio-overlay="dock"]').contains(p),
    swatches: p.querySelectorAll('[aria-label]').length,
    /* Colour must not carry the weight control any more. */
    hasWidthSteps: p.querySelectorAll('[data-mystudio-overlay="pen-width-step"]').length,
  };
})()`);
check("the colour panel opens", !!palette, "null");
check("it is not clipped by the toolbar", !!palette && palette.inside === true, JSON.stringify(palette));
check("it is part of the toolbar", !!palette && palette.childOfDock === true, JSON.stringify(palette?.childOfDock));
check("it is one row of swatches", !!palette && palette.swatches >= 6 && palette.h <= 34, JSON.stringify(palette));
check("it does not contain the thickness control", !!palette && palette.hasWidthSteps === 0, JSON.stringify(palette?.hasWidthSteps));

check("a colour can be chosen", await clickAt('[data-mystudio-overlay="pen-palette"] [aria-label="Blue"]'));
const penState = await ev(`(() => {
  const t = document.querySelector('[data-mystudio-overlay="pen-colour-trigger"]');
  const dot = t ? t.querySelector('span') : null;
  return { title: t ? t.title : null, background: dot ? getComputedStyle(dot).backgroundColor : null };
})()`);
check("the pen actually changed colour", String(penState.title).includes("Blue"), JSON.stringify(penState));

console.log("\n[8] thickness opens its own panel");
check("the thickness panel opens from its own button", await clickAt('[data-mystudio-overlay="pen-width-trigger"]'));
const widthPanel = await ev(`(() => {
  const p = document.querySelector('[data-mystudio-overlay="pen-width-panel"]');
  if (!p) return null;
  const r = p.getBoundingClientRect();
  return {
    h: Math.round(r.height),
    label: (p.querySelector('[data-mystudio-overlay="pen-width-label"]') || {}).textContent ?? null,
    steps: p.querySelectorAll('[data-mystudio-overlay="pen-width-step"]').length,
    inside: r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1 && r.left >= -1 && r.top >= -1,
  };
})()`);
check("it opens", !!widthPanel, "null");
check("it is one compact row", !!widthPanel && widthPanel.h <= 34, JSON.stringify(widthPanel));
check("it has two step arrows", !!widthPanel && widthPanel.steps === 2, JSON.stringify(widthPanel?.steps));
check("it stays inside the window", !!widthPanel && widthPanel.inside === true, JSON.stringify(widthPanel));

const widthBefore = widthPanel ? widthPanel.label : null;
const direction = (await ev(`(() => {
  const b = document.querySelector('[data-mystudio-overlay="pen-width-panel"] [aria-label="Thicker"]');
  return b && !b.disabled ? "Thicker" : "Thinner";
})()`)) ?? "Thinner";
check("a thickness can be chosen", await clickAt(`[data-mystudio-overlay="pen-width-panel"] [aria-label="${direction}"]`));
const widthAfter = await ev(`document.querySelector('[data-mystudio-overlay="pen-width-label"]')?.textContent ?? null`);
check("the thickness changed", !!widthBefore && !!widthAfter && widthBefore !== widthAfter, `${widthBefore} -> ${widthAfter}`);

console.log("\n[9] the pen is available on the video too");
await key("KeyB", "b", 66, 2);
await pause(600);
const videoPen = await ev(`({
  colour: !!document.querySelector('[data-mystudio-overlay="pen-colour-trigger"]'),
  width: !!document.querySelector('[data-mystudio-overlay="pen-width-trigger"]'),
  pages: !!document.querySelector('[data-mystudio-overlay="dock-page-panel"]'),
})`);
check("the colour button is on the video toolbar", videoPen.colour === true, JSON.stringify(videoPen));
check("the thickness button is on the video toolbar", videoPen.width === true, JSON.stringify(videoPen));
check("the page panel is not", videoPen.pages === false, JSON.stringify(videoPen));

console.log(`\nresult: ${pass} passed, ${fail} failed`);
ws.close();
process.exit(fail===0?0:1);
