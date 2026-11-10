/**
 * Runtime check: **Studio is unreachable while this layer is active**.
 *
 * ## The requirement
 *
 * The two states must be two applications that cannot affect each other — "not that the key
 * looks harmless over there". The user's words: "不是说看起来没影响，它就没影响。是设计上必须把它
 * 设计成完全不可能互相影响"(found.md F-125).
 *
 * ## Why this needs a runtime check
 *
 * The isolation is a DOM fact (`inert` on Studio's root), not a pure decision, so no unit test can
 * see it. And the failure it guards against is silent: a leaked key changes nothing visible in
 * most cases, which is exactly how "it seems fine" gets mistaken for "it is isolated".
 *
 * Checks:
 *   1. Studio's root is inert while active, and this layer's own box is not;
 *   2. nothing inside Studio can take focus;
 *   3. typing still works — the point of `inert` is to remove Studio from the chain, not the
 *      editor;
 *   4. keys pressed outside the box are consumed;
 *   5. deactivating restores Studio and leaves no marker behind.
 *
 * Requires the app running with `--remote-debugging-port=9222`.
 */

const targets=await(await fetch("http://127.0.0.1:9222/json/list")).json();
const page=targets.find(t=>t.type==="page");
const ws=new WebSocket(page.webSocketDebuggerUrl);let seq=0;const pending=new Map();
ws.onmessage=(e)=>{const m=JSON.parse(e.data);if(!m.id||!pending.has(m.id))return;const{resolve,reject}=pending.get(m.id);pending.delete(m.id);m.error?reject(new Error(JSON.stringify(m.error))):resolve(m.result);};
function send(m,p={}){const id=++seq;ws.send(JSON.stringify({id,method:m,params:p}));return new Promise((res,rej)=>pending.set(id,{resolve:res,reject:rej}));}
await new Promise(r=>(ws.onopen=r));
const ev=async(e)=>{const r=await send("Runtime.evaluate",{expression:e,returnByValue:true,awaitPromise:true});return r.exceptionDetails?{error:r.exceptionDetails.exception?.description}:r.result.value;};
const pause=ms=>new Promise(r=>setTimeout(r,ms));
let pass=0,fail=0;
const check=(n,ok,d="")=>{ok?(pass++,console.log("  ok   "+n)):(fail++,console.log("  FAIL "+n+" "+d));};
const capturing=()=>ev("document.querySelector('[data-mystudio-overlay=\"surface\"]')?.getAttribute('data-capturing')");
const keyboard=async(code,key,vk,text,mods=0)=>{await send("Input.dispatchKeyEvent",{type:"keyDown",code,key,windowsVirtualKeyCode:vk,modifiers:mods,...(text?{text,unmodifiedText:text}:{})});await send("Input.dispatchKeyEvent",{type:"keyUp",code,key,windowsVirtualKeyCode:vk,modifiers:mods});await pause(250);};

await ev("document.activeElement?.blur?.(); true");
if ((await capturing())!=="true") await keyboard("KeyA","a",65,"a",2);

console.log("\n[1] Studio is made non-interactive while active");
check("Studio root is inert", (await ev("document.getElementById('root').inert"))===true, String(await ev("document.getElementById('root').inert")));
check("the layer's own box is NOT inert", (await ev("!!document.querySelector('[data-mystudio-overlay=\"compose-input\"]')?.closest('[inert]')"))===false);

console.log("\n[2] nothing inside Studio can take focus");
check("a Studio button refuses focus", (await ev("(() => { const b=document.querySelector('#root button'); if(!b) return 'no-button'; b.focus(); return document.activeElement===b; })()"))===false);

console.log("\n[3] typing still works, and Studio stays untouched");
await ev("document.querySelector('[data-mystudio-overlay=\"compose-input\"]')?.focus(); true");
await pause(200);
/*
 * The caret has no fixed position here — an earlier script may have left it anywhere — so the
 * assertion is that the typed character **became part of the document**, not that it was
 * appended. Comparing trimmed text avoids counting the newline an empty paragraph reads back as.
 */
const before=(await ev("document.querySelector('[data-mystudio-overlay=\"compose-input\"]').innerText")).trim();
await keyboard("KeyB","b",66,"b");
const after=(await ev("document.querySelector('[data-mystudio-overlay=\"compose-input\"]').innerText")).trim();
check(
  "the character is typed into the box",
  after.length===before.length+1 && after.includes("b"),
  JSON.stringify({before,after}),
);
check("Studio root is still inert after typing", (await ev("document.getElementById('root').inert"))===true);

console.log("\n[4] keys outside the box are consumed");
await ev("document.activeElement?.blur?.(); true");
await pause(200);
await ev("window.__leak=[]; window.addEventListener('keydown',e=>window.__leak.push(e.code),false); true");
for (const [c,k,v] of [["KeyQ","q",81],["F5","F5",116],["ArrowDown","ArrowDown",40]]) await keyboard(c,k,v);
check("no key reaches the page", (await ev("window.__leak")).length===0, JSON.stringify(await ev("window.__leak")));

console.log("\n[5] deactivating restores Studio");
await ev("document.activeElement?.blur?.(); true");
await keyboard("KeyA","a",65,"a",2);
await pause(400);
check("the layer is inactive", (await capturing())==="false", String(await capturing()));
check("Studio root is interactive again", (await ev("document.getElementById('root').inert"))===false);
check("no marker left behind", (await ev("document.getElementById('root').hasAttribute('data-studio-inert')"))===false);

console.log(`\nresult: ${pass} passed, ${fail} failed`);
ws.close(); process.exit(fail===0?0:1);
