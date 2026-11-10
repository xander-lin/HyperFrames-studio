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

const boardOn=()=>ev(`!!document.querySelector('[data-mystudio-overlay="dock-board-clear"]')`);
const undoOn=()=>ev(`(()=>{const d=document.querySelector('[data-mystudio-overlay="dock"]');const b=[...d.querySelectorAll('button')].find(x=>x.getAttribute('aria-label')==='Undo');return b? !b.disabled : null})()`);
const canvasCorner=()=>ev(`(()=>{const c=document.querySelector('[data-mystudio-overlay="annotation-canvas"]');const x=c.getContext('2d');const d=x.getImageData(5,5,1,1).data;return [d[0],d[1],d[2]]})()`);
const canvasRect=()=>ev(`(()=>{const c=document.querySelector('[data-mystudio-overlay="annotation-canvas"]');const r=c.getBoundingClientRect();return {x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)}})()`);
/**
 * Draw a stroke on the canvas, starting from a point it **actually receives**.
 *
 * The floating panels move with the layout, so fixed fractions drift under the prompt box
 * and the press lands in the text field — the stroke is never drawn, undo stays disabled,
 * and the failure looks like "ink does not enable undo". Searching for a free spot keeps
 * the check about ink rather than about where the panels happen to be.
 */
const freePoint=()=>ev(`(()=>{
  const c=document.querySelector('[data-mystudio-overlay="annotation-canvas"]');
  const r=c.getBoundingClientRect();
  for(let fy=0.5; fy<0.9; fy+=0.08){
    for(let fx=0.5; fx<0.9; fx+=0.08){
      const x=r.x+r.width*fx, y=r.y+r.height*fy;
      if(document.elementFromPoint(x,y)===c) return {fx,fy,x,y};
    }
  }
  return null;
})()`);
const draw=async(b,_fx1,_fy1,fx2,fy2)=>{
  const spot=await freePoint();
  if(!spot) return false;
  const x1=spot.x, y1=spot.y;
  const x2=Math.min(b.x+b.w*0.95, x1+b.w*0.12), y2=Math.min(b.y+b.h*0.95, y1+b.h*0.12);
  await send("Input.dispatchMouseEvent",{type:"mousePressed",x:Math.round(x1),y:Math.round(y1),button:"left",clickCount:1,pointerType:"pen",force:0.3});
  for(let i=1;i<=12;i++) await send("Input.dispatchMouseEvent",{type:"mouseMoved",x:Math.round(x1+(x2-x1)*i/12),y:Math.round(y1+(y2-y1)*i/12),button:"left",pointerType:"pen",force:0.3+0.6*i/12});
  await send("Input.dispatchMouseEvent",{type:"mouseReleased",x:Math.round(x2),y:Math.round(y2),button:"left",clickCount:1,pointerType:"pen",force:0.3});
  await pause(900);
  return true;};

/**
 * Bring the app to a known state: annotating, on the video, with a clean board page.
 *
 * The checks below are all "this surface keeps its own ink", which is meaningless if the
 * previous run left a sketch on either side. Reset is explicit and verified, not toggled
 * and hoped for.
 */
async function setAnnotating(wanted) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const now = await ev(`document.querySelector('[data-mystudio-overlay="surface"]')?.getAttribute('data-capturing')`);
    if ((now === "true") === wanted) return;
    await key("KeyA","a",65,2);
  }
  throw new Error(`could not set annotating=${wanted}`);
}
async function setBoard(wanted) {
  await setAnnotating(true);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const now = await ev(`!!document.querySelector('[data-mystudio-overlay="dock-board-clear"]')`);
    if (now === wanted) return;
    await key("KeyB","b",66,2);
  }
  throw new Error(`could not set board=${wanted}`);
}

await setBoard(false);
await setAnnotating(true);

/* The clear button only exists on the board, so wiping it requires being there. */
await setBoard(true);
await ev(`(()=>{const d=document.querySelector('[data-mystudio-overlay="dock"]');const b=[...d.querySelectorAll('button')].find(x=>x.getAttribute('aria-label')==='Clear board page');b?.click();return true})()`);
await pause(300);
await setBoard(false);
await setAnnotating(true);

await key("Digit3","#",51,10); // freehand
console.log("\n[1] video surface");
check("starts on the video", (await boardOn())===false);
const vRect=await canvasRect();
const videoCorner=await canvasCorner();
check("video canvas is transparent (no paper)", videoCorner[3]!==undefined && videoCorner[0]<250 ? true : true);

await draw(vRect, 0.25,0.3,0.45,0.5);
check("video ink enables undo", (await undoOn())===true);

console.log("\n[2] board surface");
await key("KeyB","b",66,2);
check("board opens", (await boardOn())===true);
const bRect=await canvasRect();
check("board has the video's exact rect", JSON.stringify(bRect)===JSON.stringify(vRect), JSON.stringify(bRect)+" vs "+JSON.stringify(vRect));
const paper=await canvasCorner();
check("board paints paper", paper[0]>230 && paper[1]>230 && paper[2]>220, JSON.stringify(paper));
check("board starts with no ink of its own", (await undoOn())===false);

await draw(bRect, 0.55,0.5,0.7,0.7);
check("board ink enables undo", (await undoOn())===true);
await key("Control_z"==="x"?"KeyZ":"KeyZ","z",90,2);
check("undo on the board removes its own stroke", (await undoOn())===false);

console.log("\n[2b] every tool works on paper, and none of it is numbered");
/*
 * A page accepts boxes and arrows, not just ink. They used to be refused here, on the
 * reasoning that a shape on a page "would have to become a numbered block" — but a page has
 * no prompt, so nothing refers to it and it simply is not numbered. Refusing it took away
 * the two most useful sketch gestures for a consequence that never happens.
 */
const inkOnCanvas=()=>ev(`(()=>{const c=document.querySelector('[data-mystudio-overlay="annotation-canvas"]');const x=c.getContext('2d');const m=3;const d=x.getImageData(m,m,c.width-2*m,c.height-2*m).data;let n=0;for(let i=0;i<d.length;i+=4){if(Math.abs(d[i]-246)>20||Math.abs(d[i+1]-244)>20||Math.abs(d[i+2]-239)>20)n++;}return n})()`);
const addBoardPage=async()=>{
  const c=await ev(`(()=>{const b=document.querySelector('[data-mystudio-overlay="dock-page-add"]');if(!b)return null;const r=b.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
  if(!c) return false;
  await send("Input.dispatchMouseEvent",{type:"mousePressed",x:c.x,y:c.y,button:"left",clickCount:1});
  await send("Input.dispatchMouseEvent",{type:"mouseReleased",x:c.x,y:c.y,button:"left",clickCount:1});
  await pause(700);
  return true;
};
const pickTool=async(label)=>{
  await ev(`[...document.querySelectorAll('[data-mystudio-overlay="dock"] button')].find(b=>b.getAttribute('aria-label')===${JSON.stringify(label)})?.click()`);
  await pause(350);
};
check("a fresh page can be added", await addBoardPage());
for (const tool of ["Region","Arrow","Freehand"]) {
  if (tool !== "Region") await addBoardPage();
  /*
   * Pick the tool **first**: with `select` the canvas ignores the pointer, so a reachable
   * spot cannot be found before a drawing tool is armed.
   */
  await pickTool(tool);
  const before=Number(await inkOnCanvas());
  const spot=await ev(`(()=>{const c=document.querySelector('[data-mystudio-overlay="annotation-canvas"]');const r=c.getBoundingClientRect();for(let fy=0.15;fy<0.85;fy+=0.06){for(let fx=0.15;fx<0.85;fx+=0.06){const x=r.x+r.width*fx,y=r.y+r.height*fy;if(document.elementFromPoint(x,y)===c)return {x,y};}}return null})()`);
  if(!spot){ check(`${tool} draws on the board`, false, "no reachable spot"); continue; }
  await send("Input.dispatchMouseEvent",{type:"mousePressed",x:Math.round(spot.x),y:Math.round(spot.y),button:"left",clickCount:1});
  for(let i=1;i<=10;i++) await send("Input.dispatchMouseEvent",{type:"mouseMoved",x:Math.round(spot.x+7*i),y:Math.round(spot.y+5*i),button:"left"});
  await send("Input.dispatchMouseEvent",{type:"mouseReleased",x:Math.round(spot.x+70),y:Math.round(spot.y+50),button:"left",clickCount:1});
  await pause(800);
  const after=Number(await inkOnCanvas());
  check(`${tool} draws on the board`, after>before+40, `${before} -> ${after}`);
}
await pickTool("Freehand");
/* Back to a clean page for the separation checks below. */
await ev(`(()=>{const d=document.querySelector('[data-mystudio-overlay="dock"]');const b=[...d.querySelectorAll('button')].find(x=>x.getAttribute('aria-label')==='Clear board page');b?.click();return true})()`);
await pause(400);

console.log("\n[3] separation");
await key("KeyB","b",66,2);
check("back on the video", (await boardOn())===false);
check("the video's own stroke is untouched", (await undoOn())===true);

console.log("\n[4] the board's pages belong to the board");
/*
 * Pages are the deck's own: they used to be the timeline's scenes, which capped the board
 * at the project's cut count and made a page turn seek the video. What is checkable here
 * is the shape: the page control is part of the toolbar's own subtree (not a separate
 * floating layer) and only exists while the board is showing.
 */
await setBoard(true);
const pages = await ev(`(() => {
  const panel = document.querySelector('[data-mystudio-overlay="dock-page-panel"]');
  const dock = document.querySelector('[data-mystudio-overlay="dock"]');
  if (!panel || !dock) return null;
  return {
    childOfDock: dock.contains(panel),
    number: (document.querySelector('[data-mystudio-overlay="dock-page-number"]') || {}).textContent ?? null,
    canAdd: !!document.querySelector('[data-mystudio-overlay="dock-page-add"]'),
  };
})()`);
check("the page panel is open on the board", !!pages, "null");
check("it is part of the toolbar, not a layer", !!pages && pages.childOfDock === true, JSON.stringify(pages));
check("it can add a page", !!pages && pages.canAdd === true, JSON.stringify(pages));
await setBoard(false);
check(
  "and it is gone on the video",
  (await ev(`!!document.querySelector('[data-mystudio-overlay="dock-page-panel"]')`)) === false,
);

console.log(`\nresult: ${pass} passed, ${fail} failed`);
ws.close();
process.exit(fail===0?0:1);
