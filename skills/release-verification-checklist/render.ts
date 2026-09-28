#!/usr/bin/env bun
/**
 * Reusable staging/prod verification-checklist generator.
 *
 * A checklist is DATA (title, release, roles[] → items[]). The CSS/JS shell
 * below is the reusable, theme-aware, self-contained render layer — you never
 * touch it. Supply a data file, get a self-contained HTML page. Upload it to the
 * review worker's R2 bucket and serve it from `GET /c/:release` — do NOT publish
 * it as a claude.ai Artifact, whose CSP blocks the page's write-through fetches.
 *
 *   bun run render.ts <data.json> [out.html]      # writes out.html (default: ./checklist.out.html)
 *   import { renderChecklist } from "./render.ts" # or use the function directly
 *
 * DATA SHAPE (see checklist.schema below / the sample data file):
 *   {
 *     title:    string,                 // <title> + H1
 *     release:  string,                 // shown in the mono release chip; also the localStorage key suffix
 *     subtitle: string,                 // one-line intro (HTML ok)
 *     password: string,                 // shared login pw shown in the info banner (default "test1234")
 *     clientNote?: string,              // optional extra line in the info banner (HTML ok)
 *     stats?:  {k:string,v:string,ok?:boolean}[],   // summary tiles (Checks-total auto-added)
 *     banners?: {kind?:"info"|"warn"|"good", icon?:string, html:string}[],
 *     roles:   Role[]                   // Role = {email, name, items:Item[]}
 *   }                                   // Item = {pr, status, lab, where, steps:string[], verdict?:{k,t}}
 *   status ∈ ready|eye|blocked|clean|done|dark ; verdict.k ∈ clean|eye|blocked|dark
 *   A role with email NOT starting "editux" renders a plain note instead of copy-cred buttons.
 */

// ─────────────────────────────────────────────────────────────────────────────
// SHELL (reusable — do not edit per-checklist)
// ─────────────────────────────────────────────────────────────────────────────
const SHELL_CSS = `
  :root{
    --bg:#f4f6fa; --surface:#fff; --surface-2:#eef1f7; --inset:#f0f3f8;
    --ink:#15202f; --ink-2:#54637b; --ink-3:#7c8aa1; --line:#dce2ec; --line-2:#c8d1de;
    --accent:#2560c8; --accent-ink:#1a4694; --accent-bg:#e7eefb;
    --good:#0f7a50; --good-bg:#e2f2ea; --good-line:#a9d8c1;
    --warn:#946008; --warn-bg:#faefd8; --warn-line:#e6cf9a;
    --crit:#b12a3d; --crit-bg:#fbe5e9; --crit-line:#eeb6c0;
    --mono:ui-monospace,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;
    --sans:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
    --shadow:0 1px 2px rgba(20,32,50,.04),0 2px 8px rgba(20,32,50,.05);
  }
  @media (prefers-color-scheme:dark){:root{
    --bg:#0d121a; --surface:#151d28; --surface-2:#1b2531; --inset:#111823;
    --ink:#e5ebf3; --ink-2:#93a2b8; --ink-3:#6b7c93; --line:#28333f; --line-2:#334252;
    --accent:#5c9bff; --accent-ink:#93bdff; --accent-bg:#16233a;
    --good:#45c08a; --good-bg:#11291f; --good-line:#1f4a37;
    --warn:#e0a63a; --warn-bg:#2c220e; --warn-line:#4d3d17;
    --crit:#f0788a; --crit-bg:#2f1820; --crit-line:#542932;
    --shadow:0 1px 2px rgba(0,0,0,.3),0 2px 10px rgba(0,0,0,.28);
  }}
  :root[data-theme="light"]{
    --bg:#f4f6fa; --surface:#fff; --surface-2:#eef1f7; --inset:#f0f3f8;
    --ink:#15202f; --ink-2:#54637b; --ink-3:#7c8aa1; --line:#dce2ec; --line-2:#c8d1de;
    --accent:#2560c8; --accent-ink:#1a4694; --accent-bg:#e7eefb;
    --good:#0f7a50; --good-bg:#e2f2ea; --good-line:#a9d8c1;
    --warn:#946008; --warn-bg:#faefd8; --warn-line:#e6cf9a;
    --crit:#b12a3d; --crit-bg:#fbe5e9; --crit-line:#eeb6c0;
    --shadow:0 1px 2px rgba(20,32,50,.04),0 2px 8px rgba(20,32,50,.05);
  }
  :root[data-theme="dark"]{
    --bg:#0d121a; --surface:#151d28; --surface-2:#1b2531; --inset:#111823;
    --ink:#e5ebf3; --ink-2:#93a2b8; --ink-3:#6b7c93; --line:#28333f; --line-2:#334252;
    --accent:#5c9bff; --accent-ink:#93bdff; --accent-bg:#16233a;
    --good:#45c08a; --good-bg:#11291f; --good-line:#1f4a37;
    --warn:#e0a63a; --warn-bg:#2c220e; --warn-line:#4d3d17;
    --crit:#f0788a; --crit-bg:#2f1820; --crit-line:#542932;
    --shadow:0 1px 2px rgba(0,0,0,.3),0 2px 10px rgba(0,0,0,.28);
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--sans);line-height:1.55;-webkit-font-smoothing:antialiased;font-size:15px}
  .wrap{max-width:900px;margin:0 auto;padding:32px 20px 96px}
  code,.mono{font-family:var(--mono);font-variant-ligatures:none}
  h1{font-size:26px;line-height:1.15;margin:0 0 4px;letter-spacing:-.01em;text-wrap:balance}
  .sub{color:var(--ink-2);font-size:14px;margin:0}
  header{border-bottom:1px solid var(--line);padding-bottom:20px;margin-bottom:22px}
  .rel{display:inline-flex;align-items:center;gap:7px;font-family:var(--mono);font-size:12px;background:var(--accent-bg);color:var(--accent-ink);padding:3px 9px;border-radius:6px;border:1px solid var(--line);margin-top:10px}
  .summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:18px 0 8px}
  .stat{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:12px 14px;box-shadow:var(--shadow)}
  .stat .k{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--ink-3);font-weight:600}
  .stat .v{font-family:var(--mono);font-size:17px;margin-top:3px;font-variant-numeric:tabular-nums}
  .stat .v.ok{color:var(--good)}
  .banner{display:flex;gap:11px;align-items:flex-start;background:var(--good-bg);border:1px solid var(--good-line);border-radius:10px;padding:13px 15px;margin:14px 0;font-size:13.5px}
  .banner.warn{background:var(--warn-bg);border-color:var(--warn-line)} .banner.info{background:var(--accent-bg);border-color:var(--line)}
  .banner .ic{flex:none;font-family:var(--mono);font-weight:700;color:var(--good)}
  .banner.warn .ic{color:var(--warn)} .banner.info .ic{color:var(--accent-ink)}
  .legend{display:flex;flex-wrap:wrap;gap:8px;margin:16px 0 8px}
  .pill{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:600;padding:3px 10px;border-radius:999px;border:1px solid var(--line)}
  .pill.ready,.pill.done,.pill.clean{background:var(--good-bg);color:var(--good);border-color:var(--good-line)}
  .pill.blocked{background:var(--crit-bg);color:var(--crit);border-color:var(--crit-line)}
  .pill.dark{background:var(--warn-bg);color:var(--warn);border-color:var(--warn-line)}
  .pill.eye{background:var(--accent-bg);color:var(--accent-ink);border-color:var(--line)}
  .dot{width:7px;height:7px;border-radius:50%;background:currentColor}
  .toolbar{position:sticky;top:0;z-index:5;background:color-mix(in srgb,var(--bg) 88%,transparent);backdrop-filter:blur(8px);border-bottom:1px solid var(--line);margin:8px -20px 20px;padding:10px 20px;display:flex;align-items:center;gap:12px;font-size:13px}
  .toolbar .prog{font-family:var(--mono);color:var(--ink-2);font-variant-numeric:tabular-nums;white-space:nowrap}
  .toolbar .bar{flex:1;height:6px;background:var(--surface-2);border-radius:99px;overflow:hidden;border:1px solid var(--line)}
  .toolbar .bar>i{display:block;height:100%;background:var(--good);width:0;transition:width .2s}
  .tbtn{font:inherit;font-size:12px;padding:5px 11px;border-radius:7px;border:1px solid var(--line-2);background:var(--surface);color:var(--ink-2);cursor:pointer} .tbtn:hover{color:var(--ink)}
  .role{background:var(--surface);border:1px solid var(--line);border-radius:12px;margin:16px 0;box-shadow:var(--shadow)}
  .role>summary{list-style:none;cursor:pointer;padding:15px 18px;display:flex;gap:12px;align-items:center;flex-wrap:wrap;position:sticky;top:44px;z-index:4;background:var(--surface);border-radius:12px}
  .role[open]>summary{border-radius:12px 12px 0 0;border-bottom:1px solid var(--line);box-shadow:0 4px 10px -8px rgba(20,32,50,.25)}
  .role>summary::-webkit-details-marker{display:none}
  .role>summary::after{content:"›";margin-left:auto;color:var(--ink-3);font-size:20px;transform:rotate(90deg);transition:transform .15s;align-self:center}
  .role[open]>summary::after{transform:rotate(-90deg)}
  .rolename{font-weight:700;font-size:16px}
  .rolecount{font-family:var(--mono);font-size:12px;color:var(--ink-3);font-variant-numeric:tabular-nums}
  .cred{display:flex;align-items:center;gap:8px;flex-basis:100%;margin-top:2px}
  .credbox{display:inline-flex;align-items:center;gap:0;border:1px solid var(--line-2);border-radius:8px;overflow:hidden;background:var(--inset);font-family:var(--mono);font-size:13px}
  .credbox .email{padding:5px 10px;color:var(--accent-ink)} .credbox .pw{padding:5px 10px;border-left:1px solid var(--line);color:var(--ink-2)}
  .copybtn{font:inherit;font-family:var(--sans);font-size:11px;font-weight:600;border:none;cursor:pointer;background:var(--accent-bg);color:var(--accent-ink);padding:5px 10px;border-left:1px solid var(--line);display:inline-flex;align-items:center;gap:5px;transition:background .12s}
  .copybtn:hover{background:var(--accent);color:#fff} .copybtn.copied{background:var(--good);color:#fff} .copybtn svg{width:12px;height:12px}
  .rbody{padding:2px 18px 18px;border-top:1px solid var(--line);border-radius:0 0 12px 12px}
  .item{border:1px solid var(--line);border-left-width:3px;border-radius:9px;margin:11px 0;background:var(--surface)}
  .item.rev-approved{border-left-color:var(--good)} .item.rev-issues{border-left-color:var(--warn)}
  .item.rev-rejected{border-left-color:var(--crit)} .item.rev-na{border-left-color:var(--ink-3)}
  .item .itxt{display:block;padding:12px 14px 2px;min-width:0}
  .item .ihead{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap;margin-bottom:3px}
  .prtag{font-family:var(--mono);font-size:11px;font-weight:600;color:var(--accent-ink);background:var(--accent-bg);padding:1px 7px;border-radius:5px;flex:none}
  .ilab{font-weight:600;font-size:13.5px}
  .where{font-family:var(--mono);font-size:11.5px;color:var(--ink-3)}
  ol.steps{margin:6px 0 0;padding-left:20px;font-size:13.5px;color:var(--ink-2)} ol.steps li{margin:4px 0}
  ol.steps code,.verdict code,.where code{background:var(--surface-2);padding:1px 5px;border-radius:4px;font-size:12px;border:1px solid var(--line)}
  :root[data-theme="dark"] ol.steps code{background:var(--inset)}
  .expect{color:var(--good);font-weight:600} .nb{color:var(--warn);font-weight:600}
  .verdict{display:flex;gap:8px;font-size:12.5px;border-radius:7px;padding:8px 11px;margin:8px 0 2px;border:1px solid}
  .verdict.clean{background:var(--good-bg);border-color:var(--good-line);color:var(--good)}
  .verdict.eye{background:var(--accent-bg);border-color:var(--line);color:var(--accent-ink)}
  .verdict.blocked{background:var(--crit-bg);border-color:var(--crit-line);color:var(--crit)}
  .verdict.dark{background:var(--warn-bg);border-color:var(--warn-line);color:var(--warn)}
  .toolbar .brk{font-family:var(--mono);font-size:12px;color:var(--ink-3);white-space:nowrap}
  .review{display:flex;flex-wrap:wrap;gap:6px;padding:2px 14px 10px}
  .revbtn{font:inherit;font-size:12px;font-weight:600;padding:5px 11px;border-radius:7px;border:1px solid var(--line-2);background:var(--surface);color:var(--ink-2);cursor:pointer;transition:background .12s,color .12s,border-color .12s}
  .revbtn:hover{color:var(--ink);border-color:var(--ink-3)}
  .revbtn.on.rb-approved{background:var(--good-bg);border-color:var(--good-line);color:var(--good)}
  .revbtn.on.rb-issues{background:var(--warn-bg);border-color:var(--warn-line);color:var(--warn)}
  .revbtn.on.rb-rejected{background:var(--crit-bg);border-color:var(--crit-line);color:var(--crit)}
  .revbtn.on.rb-na{background:var(--surface-2);border-color:var(--line-2);color:var(--ink)}
  .notes{margin:0 14px 12px}
  .notes .nl{display:block;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--ink-3);font-weight:600;margin-bottom:5px}
  .notes textarea.ntext{width:100%;font-family:var(--sans);font-size:13px;padding:8px 10px;border:1px solid var(--line-2);border-radius:7px;background:var(--inset);color:var(--ink);resize:vertical;min-height:40px}
  .notes.drop{outline:2px dashed var(--accent);outline-offset:3px;border-radius:8px}
  .media{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}
  .mfig{position:relative;margin:0;border:1px solid var(--line);border-radius:8px;overflow:hidden;background:var(--surface-2);line-height:0}
  .mfig img,.mfig video{display:block;max-width:220px;max-height:170px;width:auto;height:auto}
  .mdel{position:absolute;top:4px;right:4px;width:20px;height:20px;border-radius:50%;border:none;background:rgba(0,0,0,.55);color:#fff;font-size:15px;line-height:1;cursor:pointer}
  .mdel:hover{background:var(--crit)}
  .nact{display:flex;align-items:center;gap:10px;margin-top:8px;flex-wrap:wrap}
  .attach{font-size:12px;font-weight:600;color:var(--accent-ink);background:var(--accent-bg);border:1px solid var(--line);padding:4px 10px;border-radius:7px;cursor:pointer}
  .attach:hover{background:var(--accent);color:#fff}
  .nhint{font-size:11px;color:var(--ink-3)}
  .item-user{border-left-color:var(--accent)}
  .prtag-add{background:var(--warn-bg)!important;color:var(--warn)!important}
  .idel{margin-left:auto;font:inherit;font-size:11px;font-weight:600;color:var(--crit);background:transparent;border:1px solid var(--crit-line);border-radius:6px;padding:1px 8px;cursor:pointer}
  .idel:hover{background:var(--crit-bg)}
  .additem-wrap{padding:5px 0 2px}
  .additem{font:inherit;font-size:12.5px;font-weight:600;color:var(--accent-ink);background:transparent;border:1px dashed var(--line-2);border-radius:8px;padding:8px 12px;cursor:pointer;width:100%;text-align:left}
  .additem:hover{background:var(--accent-bg);border-color:var(--accent)}
  .role-user{border-style:dashed}
  .role-user>summary .rdel{font:inherit;font-size:11px;font-weight:600;color:var(--crit);background:var(--surface);border:1px solid var(--crit-line);border-radius:6px;padding:3px 9px;cursor:pointer}
  .role-user>summary .rdel:hover{background:var(--crit-bg)}
  .addrole-wrap{margin:14px 0 6px}
  .addrole{font:inherit;font-size:13px;font-weight:600;color:var(--accent-ink);background:var(--accent-bg);border:1px dashed var(--accent);border-radius:10px;padding:11px 14px;cursor:pointer;width:100%;text-align:center}
  .addrole:hover{background:var(--accent);color:#fff}
  .modal-ov{position:fixed;inset:0;background:rgba(10,16,26,.55);display:flex;align-items:center;justify-content:center;z-index:50;padding:20px}
  .modal-ov[hidden]{display:none}
  .modal{background:var(--surface);border:1px solid var(--line);border-radius:14px;box-shadow:0 24px 70px -22px rgba(0,0,0,.55);width:100%;max-width:780px;max-height:86vh;display:flex;flex-direction:column;padding:18px}
  .modal-h{font-weight:700;font-size:16px} .modal-h #modalcount{font-weight:400;font-size:12px;color:var(--ink-3)}
  .modal-sub{font-size:12.5px;color:var(--ink-2);margin:4px 0 10px}
  .modal-ta{flex:1;min-height:340px;width:100%;font-family:var(--mono);font-size:12.5px;line-height:1.5;padding:12px;border:1px solid var(--line-2);border-radius:9px;background:var(--inset);color:var(--ink);resize:none;white-space:pre;overflow:auto}
  .modal-act{display:flex;align-items:center;gap:10px;margin-top:12px}
  .tbtn-p{background:var(--accent);color:#fff;border-color:var(--accent);font-weight:600} .tbtn-p:hover{color:#fff;filter:brightness(1.06)}
  .modal-msg{font-size:12.5px;color:var(--good);font-weight:600}
  .foot{color:var(--ink-3);font-size:12.5px;margin-top:30px;border-top:1px solid var(--line);padding-top:16px}
  :focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:4px}
  @media (max-width:560px){.credbox{font-size:12px}}
`;

// Runs in the browser. Reads window.__CHECKLIST (roles, pw, key) and builds the DOM.
const SHELL_JS = `
var D = window.__CHECKLIST, ROLES = D.roles, PW = D.password || "test1234";
var root = document.getElementById("roles");
var COPY_SVG='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
var PILL={ready:"verify",eye:"eyeball",blocked:"blocked/manual",clean:"no action",done:"auto-verified",dark:"dark launch"};
var REV=[["approved","✓ Approve"],["issues","⚠ Pass w/ issues"],["rejected","✗ Reject"],["na","N/A"]];
var KEY="releaseVerify_"+D.key, store=JSON.parse(localStorage.getItem(KEY)||"{}");
if(!store.userRoles) store.userRoles=[]; if(!store.userItems) store.userItems=[];

// Write-through to the review Worker (Durable Object). Off unless __REVIEW is configured.
var RV = window.__REVIEW || {base:"",writeToken:"",release:""};
var RVON = !!(RV.base && RV.writeToken && RV.release);
// Backstop only. The honest sentence is already baked into the served HTML at render
// time (see footStore in render.ts) precisely so this script is not what a privacy claim
// depends on. This covers the mismatch case — a page rendered without a worker target but
// served with one — and never downgrades the claim, only raises it to "uploaded".
(function(){ var fs=document.getElementById("footstore"); if(fs && RVON) fs.innerHTML="Your review states, notes and any screenshot or video you paste are <b>uploaded</b> to the review worker as you go (a copy also stays in this browser, so you can close the tab and return)."; })();
function rvUrl(p){ return RV.base + "/r/" + encodeURIComponent(RV.release) + p; }
function rvHeaders(json){ var h={authorization:"Bearer "+RV.writeToken}; if(json) h["content-type"]="application/json"; return h; }
var rvTimers={};
function rvPutItem(id){ if(!RVON) return; var body=JSON.stringify({status:store["rev_"+id]||"",note:store["note_"+id]||""}); fetch(rvUrl("/item/"+encodeURIComponent(id)),{method:"PUT",headers:rvHeaders(true),body:body}).catch(function(){}); }
function rvSyncItem(id){ if(!RVON) return; if(rvTimers[id]) clearTimeout(rvTimers[id]); rvTimers[id]=setTimeout(function(){ rvPutItem(id); },600); }
function rvPutMeta(){ if(!RVON) return; var body=JSON.stringify({addedRoles:store.userRoles||[],addedItems:store.userItems||[]}); fetch(rvUrl("/meta"),{method:"PUT",headers:rvHeaders(true),body:body}).catch(function(){}); }
function rvUploadMedia(id,file){ if(!RVON) return; var fd=new FormData(); fd.append("file",file); fetch(RV.base+"/r/"+encodeURIComponent(RV.release)+"/media?id="+encodeURIComponent(id),{method:"POST",headers:{authorization:"Bearer "+RV.writeToken},body:fd}).then(function(r){return r.json();}).then(function(){ rvPutItem(id); }).catch(function(){}); }

// IndexedDB store for pasted/dropped images + videos (blobs — big videos would blow the localStorage quota).
var _db=null;
function db(){ if(_db) return Promise.resolve(_db); return new Promise(function(res,rej){ var rq=indexedDB.open("releaseVerifyMedia",1); rq.onupgradeneeded=function(){ var dd=rq.result; if(!dd.objectStoreNames.contains("m")){ var s=dd.createObjectStore("m",{keyPath:"id"}); s.createIndex("item","item"); } }; rq.onsuccess=function(){ _db=rq.result; res(_db); }; rq.onerror=function(){ rej(rq.error); }; }); }
function mstore(mode){ return db().then(function(dd){ return dd.transaction("m",mode).objectStore("m"); }); }
function mediaAdd(item,file){ var id=D.key+"_"+Date.now()+"_"+Math.random().toString(36).slice(2,9); var rec={id:id,item:item,type:file.type||"",name:file.name||"",blob:file}; return mstore("readwrite").then(function(s){ return new Promise(function(res,rej){ var rq=s.add(rec); rq.onsuccess=function(){res(rec);}; rq.onerror=function(){rej(rq.error);}; }); }); }
function mediaFor(item){ return mstore("readonly").then(function(s){ return new Promise(function(res){ var rq=s.index("item").getAll(item); rq.onsuccess=function(){res(rq.result||[]);}; rq.onerror=function(){res([]);}; }); }); }
function mediaDel(id){ return mstore("readwrite").then(function(s){ s.delete(id); }); }
function mediaAll(){ return mstore("readonly").then(function(s){ return new Promise(function(res){ var rq=s.getAll(); rq.onsuccess=function(){res(rq.result||[]);}; rq.onerror=function(){res([]);}; }); }); }
function mkPreview(rec){
  var fig=document.createElement("figure"); fig.className="mfig";
  var el; if((rec.type||"").indexOf("video")===0){ el=document.createElement("video"); el.controls=true; el.setAttribute("playsinline",""); } else { el=document.createElement("img"); }
  el.src=URL.createObjectURL(rec.blob);
  var x=document.createElement("button"); x.type="button"; x.className="mdel"; x.textContent="×"; x.title="remove";
  x.addEventListener("click",function(){ mediaDel(rec.id).then(function(){ try{URL.revokeObjectURL(el.src);}catch(e){} fig.remove(); }); });
  fig.appendChild(el); fig.appendChild(x); return fig;
}
function loadMedia(box,item){ box.innerHTML=""; mediaFor(item).then(function(list){ for(var i=0;i<list.length;i++) box.appendChild(mkPreview(list[i])); }); }
function addFiles(box,item,files){ for(var i=0;i<files.length;i++){ (function(f){ var t=f.type||""; if(t.indexOf("image")===0||t.indexOf("video")===0){ mediaAdd(item,f).then(function(rec){ box.appendChild(mkPreview(rec)); }); rvUploadMedia((""+item).split("::")[1]||(""+item), f); } })(files[i]); } }
function applyRev(item,val){ item.classList.remove("rev-approved","rev-issues","rev-rejected","rev-na"); if(val) item.classList.add("rev-"+val); }

// Shared builders (used by data items AND user-added items) --------------------
function mkReview(item,id){
  var rev=document.createElement("div"); rev.className="review";
  for(var j=0;j<REV.length;j++){
    (function(val,label){
      var b=document.createElement("button"); b.type="button"; b.className="revbtn rb-"+val; b.textContent=label; b.setAttribute("data-rev",val);
      if((store["rev_"+id]||"")===val) b.classList.add("on");
      b.addEventListener("click",function(){ var nv=((store["rev_"+id]||"")===val)?"":val; if(nv) store["rev_"+id]=nv; else delete store["rev_"+id]; applyRev(item,nv); var bs=rev.querySelectorAll(".revbtn"); for(var q=0;q<bs.length;q++) bs[q].classList.toggle("on",bs[q].getAttribute("data-rev")===nv); save(); rvSyncItem(id); });
      rev.appendChild(b);
    })(REV[j][0],REV[j][1]);
  }
  return rev;
}
function mkNotes(id,mkey){
  var notes=document.createElement("div"); notes.className="notes";
  var nl=document.createElement("div"); nl.className="nl"; nl.textContent="Notes & evidence";
  var ta=document.createElement("textarea"); ta.className="ntext"; ta.rows=2; ta.setAttribute("placeholder","what you saw — paste a screenshot, or drop / attach a video");
  if(store["note_"+id]) ta.value=store["note_"+id];
  var mbox=document.createElement("div"); mbox.className="media";
  ta.addEventListener("input",function(){ store["note_"+id]=ta.value; save(); rvSyncItem(id); });
  ta.addEventListener("paste",function(ev){ var items=(ev.clipboardData&&ev.clipboardData.items)||[]; var got=false; for(var k=0;k<items.length;k++){ if(items[k].kind==="file"){ var f=items[k].getAsFile(); if(f&&((f.type||"").indexOf("image")===0||(f.type||"").indexOf("video")===0)){ got=true; addFiles(mbox,mkey,[f]); } } } if(got) ev.preventDefault(); });
  notes.addEventListener("dragover",function(ev){ ev.preventDefault(); notes.classList.add("drop"); });
  notes.addEventListener("dragleave",function(){ notes.classList.remove("drop"); });
  notes.addEventListener("drop",function(ev){ ev.preventDefault(); notes.classList.remove("drop"); if(ev.dataTransfer&&ev.dataTransfer.files) addFiles(mbox,mkey,ev.dataTransfer.files); });
  var act=document.createElement("div"); act.className="nact";
  var lab=document.createElement("label"); lab.className="attach"; lab.textContent="📎 attach image / video";
  var fi=document.createElement("input"); fi.type="file"; fi.accept="image/*,video/*"; fi.multiple=true; fi.style.display="none";
  fi.addEventListener("change",function(){ addFiles(mbox,mkey,fi.files); fi.value=""; });
  lab.appendChild(fi); act.appendChild(lab);
  var hint=document.createElement("span"); hint.className="nhint"; hint.textContent="paste directly into the box, or drop / attach"; act.appendChild(hint);
  notes.appendChild(nl); notes.appendChild(ta); notes.appendChild(mbox); notes.appendChild(act);
  loadMedia(mbox,mkey);
  return notes;
}
// User-added item (a check/issue the reviewer types in) ------------------------
function buildUserItem(u){
  var id=u.id, mkey=D.key+"::"+id;
  var item=document.createElement("div"); item.className="item item-user"; item.setAttribute("data-uid",id);
  var txt=document.createElement("div"); txt.className="itxt";
  txt.innerHTML='<div class="ihead"><span class="prtag prtag-add">added</span><span class="pill eye" style="padding:1px 8px"><span class="dot"></span>your issue</span><button class="idel" type="button" title="remove this item">remove</button></div><div class="ilab"></div>';
  txt.querySelector(".ilab").textContent=u.label;
  item.appendChild(txt);
  item.appendChild(mkReview(item,id));
  applyRev(item, store["rev_"+id]||"");
  item.appendChild(mkNotes(id,mkey));
  txt.querySelector(".idel").addEventListener("click",function(){ if(!confirm("Remove this added item?")) return; store.userItems=store.userItems.filter(function(x){return x.id!==id;}); delete store["rev_"+id]; delete store["note_"+id]; mediaFor(mkey).then(function(list){ for(var i=0;i<list.length;i++) mediaDel(list[i].id); }); item.remove(); save(); rvPutMeta(); });
  return item;
}
function addCheckBtn(body,roleKey){
  var wrap=document.createElement("div"); wrap.className="additem-wrap";
  var btn=document.createElement("button"); btn.type="button"; btn.className="additem"; btn.textContent="+ Add a check / issue to this section";
  btn.addEventListener("click",function(){ var label=prompt("Describe the check or issue to add here:"); if(!label||!label.trim()) return; var u={id:"u"+Date.now()+Math.random().toString(36).slice(2,6), role:roleKey, label:label.trim()}; store.userItems.push(u); save(); rvPutMeta(); body.insertBefore(buildUserItem(u), wrap); });
  wrap.appendChild(btn); body.appendChild(wrap); return wrap;
}
function buildUserRole(ur){
  var d=document.createElement("details"); d.className="role role-user"; d.open=true;
  var body=document.createElement("div"); body.className="rbody";
  var summary=document.createElement("summary");
  summary.innerHTML='<span class="rolename"></span><span class="rolecount">added section</span><span class="cred"><button class="rdel" type="button">remove section</button></span>';
  summary.querySelector(".rolename").textContent=ur.name;
  for(var k=0;k<store.userItems.length;k++){ if(store.userItems[k].role===ur.id) body.appendChild(buildUserItem(store.userItems[k])); }
  addCheckBtn(body,ur.id);
  summary.querySelector(".rdel").addEventListener("click",function(e){ e.preventDefault(); e.stopPropagation(); if(!confirm("Remove this section and its added items?")) return; var ids=store.userItems.filter(function(x){return x.role===ur.id;}).map(function(x){return x.id;}); store.userItems=store.userItems.filter(function(x){return x.role!==ur.id;}); store.userRoles=store.userRoles.filter(function(x){return x.id!==ur.id;}); for(var i=0;i<ids.length;i++){ delete store["rev_"+ids[i]]; delete store["note_"+ids[i]]; } d.remove(); save(); rvPutMeta(); });
  d.appendChild(summary); d.appendChild(body);
  return d;
}

var total=0;
for(var ri=0; ri<ROLES.length; ri++){
  var r=ROLES[ri];
  var roleKey=(r.email||("role"+ri)).replace(/[^a-z0-9_]/gi,"")||("role"+ri);
  var d=document.createElement("details"); d.className="role";
  var real=(r.email||"").indexOf("editux")===0;
  var body=document.createElement("div"); body.className="rbody";
  for(var i=0;i<r.items.length;i++){
    var it=r.items[i]; total++;
    var id=(r.email+"_"+it.pr+"_"+i).replace(/[^a-z0-9_]/gi,"");
    var mkey=D.key+"::"+id;
    var cls=PILL[it.status]?it.status:"ready";
    var v=it.verdict?('<div class="verdict '+it.verdict.k+'"><b>Note:</b>&nbsp;'+it.verdict.t+'</div>'):"";
    var item=document.createElement("div"); item.className="item";
    var txt=document.createElement("div"); txt.className="itxt";
    txt.innerHTML='<div class="ihead"><span class="prtag">#'+it.pr+'</span><span class="pill '+cls+'" style="padding:1px 8px"><span class="dot"></span>'+(PILL[it.status]||"verify")+'</span></div>'
      +'<div class="ilab">'+it.lab+'</div><div class="where">'+it.where+'</div>'
      +'<ol class="steps">'+it.steps.map(function(s){return "<li>"+s+"</li>";}).join("")+'</ol>'+v;
    item.appendChild(txt);
    item.appendChild(mkReview(item,id));
    applyRev(item, store["rev_"+id]||"");
    item.appendChild(mkNotes(id,mkey));
    body.appendChild(item);
  }
  (function(bodyEl,rk){ for(var k=0;k<store.userItems.length;k++){ if(store.userItems[k].role===rk) bodyEl.appendChild(buildUserItem(store.userItems[k])); } addCheckBtn(bodyEl,rk); })(body,roleKey);
  var cred = real
    ? '<div class="cred"><span class="credbox"><span class="email">'+r.email+'</span><button class="copybtn" type="button" data-copy="'+r.email+'">'+COPY_SVG+'email</button><span class="pw">'+PW+'</span><button class="copybtn" type="button" data-copy="'+PW+'">'+COPY_SVG+'pw</button></span></div>'
    : '<div class="cred"><span class="rolecount">'+(r.email||"no login")+'</span></div>';
  var summary=document.createElement("summary");
  summary.innerHTML='<span class="rolename">'+r.name+'</span><span class="rolecount">'+r.items.length+' check'+(r.items.length>1?"s":"")+'</span>'+cred;
  d.appendChild(summary); d.appendChild(body);
  root.appendChild(d);
}
for(var uk=0; uk<store.userRoles.length; uk++){ root.appendChild(buildUserRole(store.userRoles[uk])); }
var addRoleWrap=document.createElement("div"); addRoleWrap.className="addrole-wrap";
var addRoleBtn=document.createElement("button"); addRoleBtn.type="button"; addRoleBtn.className="addrole"; addRoleBtn.textContent="+ Add a new section (for issues unrelated to the checks above)";
addRoleBtn.addEventListener("click",function(){ var name=prompt("Name this section (e.g. 'Unrelated issues found'):"); if(!name||!name.trim()) return; var urr={id:"ur"+Date.now()+Math.random().toString(36).slice(2,6), name:name.trim()}; store.userRoles.push(urr); save(); root.insertBefore(buildUserRole(urr), addRoleWrap); });
addRoleWrap.appendChild(addRoleBtn); root.appendChild(addRoleWrap);
var ts=document.getElementById("totstat"); if(ts) ts.textContent=total;
function buildDigest(){
  var NL=String.fromCharCode(10);
  var out=["CHECKLIST REVIEW — "+D.key, "(every item with a note, or marked Pass-w-issues / Reject / N-A — with its context)", ""];
  var flagged=0;
  var roles=document.querySelectorAll("details.role");
  for(var i=0;i<roles.length;i++){
    var rnEl=roles[i].querySelector(".rolename"); var rn=rnEl?rnEl.textContent.trim():"(section)";
    var its=roles[i].querySelectorAll(".item"); var section=[];
    for(var j=0;j<its.length;j++){
      var el=its[j];
      var prEl=el.querySelector(".prtag"); var pr=prEl?prEl.textContent.trim():"";
      var labEl=el.querySelector(".ilab"); var lab=labEl?labEl.textContent.trim():"";
      var whEl=el.querySelector(".where"); var wh=whEl?whEl.textContent.trim():"";
      var rev="(unreviewed)"; if(el.classList.contains("rev-approved"))rev="APPROVED"; else if(el.classList.contains("rev-issues"))rev="PASS-W-ISSUES"; else if(el.classList.contains("rev-rejected"))rev="REJECTED"; else if(el.classList.contains("rev-na"))rev="N/A";
      var taEl=el.querySelector("textarea.ntext"); var note=taEl?taEl.value.trim():"";
      var mb=el.querySelector(".media"); var mn=mb?mb.querySelectorAll(".mfig").length:0;
      if(!(note || rev==="PASS-W-ISSUES" || rev==="REJECTED" || rev==="N/A")) continue;
      flagged++;
      section.push("- "+(pr?pr+"  ":"")+lab);
      if(wh) section.push("    where: "+wh);
      section.push("    status: "+rev+(mn?("   attachments: "+mn):""));
      if(note) section.push("    note: "+note.split(NL).join(NL+"          "));
      section.push("");
    }
    if(section.length){ out.push("========== "+rn+" =========="); out=out.concat(section); }
  }
  if(!flagged) out.push("(nothing flagged — no notes and nothing marked Pass-w-issues / Reject / N-A)");
  return { text: out.join(NL), flagged: flagged };
}
function openReviewModal(){
  var r=buildDigest(); var m=document.getElementById("revmodal");
  var ta=m.querySelector(".modal-ta"); ta.value=r.text;
  var mc=m.querySelector("#modalcount"); if(mc) mc.textContent="· "+r.flagged+" item(s) flagged";
  m.hidden=false; setTimeout(function(){ ta.focus(); ta.select(); },30);
}
document.getElementById("copyrev").addEventListener("click",openReviewModal);
(function(){
  var m=document.getElementById("revmodal"); if(!m) return;
  function msg(t){ var e=m.querySelector("#modalmsg"); if(e){ e.textContent=t; setTimeout(function(){ e.textContent=""; },2500); } }
  m.addEventListener("click",function(e){ if(e.target===m) m.hidden=true; });
  m.querySelector("#modalclose").addEventListener("click",function(){ m.hidden=true; });
  document.addEventListener("keydown",function(e){ if(e.key==="Escape" && !m.hidden) m.hidden=true; });
  m.querySelector("#modalcopy").addEventListener("click",function(){
    var ta=m.querySelector(".modal-ta"); ta.focus(); ta.select(); try{ ta.setSelectionRange(0,ta.value.length); }catch(e){}
    var done=false; try{ done=document.execCommand("copy"); }catch(e){}
    if(done){ msg("Copied ✓"); return; }
    if(navigator.clipboard && navigator.clipboard.writeText){ navigator.clipboard.writeText(ta.value).then(function(){ msg("Copied ✓"); },function(){ msg("Select all + ⌘/Ctrl+C"); }); }
    else { msg("Select all + ⌘/Ctrl+C"); }
  });
})();
function copyText(val){ val=String(val); var t=document.createElement("textarea"); t.value=val; t.setAttribute("readonly",""); t.style.position="fixed"; t.style.top="-1000px"; t.style.opacity="0"; document.body.appendChild(t); t.focus(); t.select(); try{ t.setSelectionRange(0,val.length); }catch(e){} var ok=false; try{ ok=document.execCommand("copy"); }catch(e){} t.remove(); if(!ok && navigator.clipboard && navigator.clipboard.writeText){ navigator.clipboard.writeText(val).then(function(){},function(){}); } return ok; }
var cbs=document.querySelectorAll(".copybtn");
for(var c=0;c<cbs.length;c++){ (function(b){ b.addEventListener("click",function(e){ e.preventDefault(); e.stopPropagation(); copyText(b.getAttribute("data-copy")); var o=b.innerHTML; b.classList.add("copied"); b.textContent="Copied!"; setTimeout(function(){ b.classList.remove("copied"); b.innerHTML=o; },1200); }); })(cbs[c]); }
var creds=document.querySelectorAll(".cred");
for(var cc=0;cc<creds.length;cc++){ creds[cc].addEventListener("click",function(e){ if(e.target.closest(".credbox")) e.preventDefault(); }); }
function prog(){ var items=document.querySelectorAll(".item"); var n=items.length, dec=0, ca=0,ci=0,cr=0,cn=0; for(var i=0;i<n;i++){ var el=items[i]; if(el.classList.contains("rev-approved")){dec++;ca++;} else if(el.classList.contains("rev-issues")){dec++;ci++;} else if(el.classList.contains("rev-rejected")){dec++;cr++;} else if(el.classList.contains("rev-na")){dec++;cn++;} } document.getElementById("prog").textContent=dec+" / "+n+" reviewed"; document.getElementById("barfill").style.width=(n?dec/n*100:0)+"%"; var bd=document.getElementById("brk"); if(bd) bd.textContent=ca+" ✓   "+ci+" ⚠   "+cr+" ✗   "+cn+" N/A"; }
function save(){ localStorage.setItem(KEY,JSON.stringify(store)); prog(); }
document.getElementById("reset").addEventListener("click",function(){ if(confirm("Clear all review states, notes and pasted media for this checklist?")){ localStorage.removeItem(KEY); mediaAll().then(function(list){ var dels=[]; for(var i=0;i<list.length;i++){ if(String(list[i].item).indexOf(D.key+"::")===0) dels.push(mediaDel(list[i].id)); } return Promise.all(dels); }).then(function(){ location.reload(); },function(){ location.reload(); }); } });
prog();
`;

// ─────────────────────────────────────────────────────────────────────────────
// RENDER
// ─────────────────────────────────────────────────────────────────────────────
function esc(s: string) { return String(s); } // data is trusted (author-written HTML allowed in labels/steps)

export function renderChecklist(data: any): string {
  const key = String(data.release || "checklist").replace(/[^a-z0-9]/gi, "").slice(0, 24);
  const stats = [
    ...(data.stats || []),
    { k: "Checks to run", v: '<span id="totstat">—</span>', raw: true },
  ];
  const statHtml = stats.map((s: any) =>
    `<div class="stat"><div class="k">${s.k}</div><div class="v${s.ok ? " ok" : ""}">${s.raw ? s.v : esc(s.v)}</div></div>`).join("");
  const infoBanner = `<div class="banner info"><span class="ic">i</span><div><b>Password for every account: <code>${data.password || "test1234"}</code></b>.${data.clientNote ? " " + data.clientNote : ""} Each account's <b>Copy</b> button copies its email.</div></div>`;
  const banners = (data.banners || []).map((b: any) =>
    `<div class="banner${b.kind && b.kind !== "good" ? " " + b.kind : ""}"><span class="ic">${b.icon || "&check;"}</span><div>${b.html}</div></div>`).join("");
  const legend = (data.legend || [
    { cls: "ready", label: "Verify now" }, { cls: "eye", label: "Eyeball / regression" },
    { cls: "blocked", label: "Blocked / needs setup" }, { cls: "clean", label: "No action" },
  ]).map((l: any) => `<span class="pill ${l.cls}"><span class="dot"></span>${l.label}</span>`).join("");

  // Data goes to the browser as JSON on window.__CHECKLIST; the shell JS renders it.
  const payload = JSON.stringify({ roles: data.roles, password: data.password || "test1234", key });
  // Write-through config for the review Worker. Empty base ⇒ page stays pure-local.
  const review = JSON.stringify({ base: process.env.REVIEW_BASE || "", writeToken: process.env.REVIEW_WRITE_TOKEN || "", release: data.release || "" });

  // Which storage promise the footer ships with, decided HERE rather than only at
  // runtime. A page built with a worker target uploads, so the honest sentence must be
  // in the served HTML itself — if it were only swapped in by script, a blocked or
  // failed script would leave the reviewer reading "nothing is uploaded" while the page
  // uploads, i.e. failing open on a privacy claim. It also makes the artefact greppable:
  // `grep -c "nothing is uploaded"` on a worker-bound page must be 0.
  const rvConfigured = !!(process.env.REVIEW_BASE && process.env.REVIEW_WRITE_TOKEN && data.release);
  const footStore = rvConfigured
    ? `Your review states, notes and any screenshot or video you paste are <b>uploaded</b> to the review worker as you go (a copy also stays in this browser, so you can close the tab and return).`
    : `Everything saves in <b>your browser only</b> (review states + notes in localStorage, pasted media in IndexedDB); nothing is uploaded.`;

  return `<meta charset="utf-8">
<title>${esc(data.title)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${SHELL_CSS}</style>
<div class="wrap">
<header>
  <h1>${esc(data.title)}</h1>
  <p class="sub">${data.subtitle || ""}</p>
  <span class="rel">${esc(data.release || "")}</span>
</header>
<div class="summary">${statHtml}</div>
${infoBanner}${banners}
<div class="legend">${legend}</div>
<div class="toolbar"><span class="prog" id="prog">0 / 0 reviewed</span><span class="bar"><i id="barfill"></i></span><span class="brk" id="brk"></span><button class="tbtn" id="copyrev" type="button">Copy review</button><button class="tbtn" id="reset" type="button">Reset</button></div>
<div id="roles"></div>
<div class="modal-ov" id="revmodal" hidden><div class="modal">
  <div class="modal-h">Review summary <span id="modalcount"></span></div>
  <div class="modal-sub">Everything you flagged or noted, with its context. Copy it and paste it back so the fixes can be dispatched.</div>
  <textarea class="modal-ta" readonly spellcheck="false"></textarea>
  <div class="modal-act"><button class="tbtn tbtn-p" id="modalcopy" type="button">Copy to clipboard</button><span class="modal-msg" id="modalmsg"></span><span style="flex:1"></span><button class="tbtn" id="modalclose" type="button">Close</button></div>
</div></div>
<div class="foot">${data.footer || ""}<p>Per item, set a <b>review state</b> (Approve / Pass&nbsp;w/&nbsp;issues / Reject / N/A) and add <b>notes</b> — paste a screenshot straight into the box, or drop / attach a video. <span id="footstore">${footStore}</span></p></div>
</div>
<script>window.__CHECKLIST=${payload};window.__REVIEW=${review};</script>
<script>${SHELL_JS}</script>`;
}

// CLI
if (import.meta.main) {
  const [dataPath, outPath = "checklist.out.html"] = process.argv.slice(2);
  if (!dataPath) { console.error("usage: bun run render.ts <data.json> [out.html]"); process.exit(1); }
  const data = JSON.parse(await Bun.file(dataPath).text());
  await Bun.write(outPath, renderChecklist(data));
  console.log("wrote", outPath, "—", data.roles.reduce((n: number, r: any) => n + r.items.length, 0), "checks across", data.roles.length, "roles");
}
