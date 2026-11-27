const IDB = "ClipboardV2";
let ongoing = JSON.parse(localStorage.getItem("clip_ongoing") || "[]");
let queue = JSON.parse(localStorage.getItem("clip_queue") || "[]");
let undoStack = [];
let ordersDir = null, dockDir = null, pdfDir = null;
let pdfMap = new Map(); // lower name -> fileHandle
let shipIdx = null, scrapIdx = null, scrapBuf = [];

function today() {
  const d = new Date(); const p = n => String(n).padStart(2,"0");
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`;
}
function toast(m) {
  const el = document.getElementById("toast");
  el.textContent = m; el.classList.remove("hidden");
  clearTimeout(toast._t); toast._t = setTimeout(() => el.classList.add("hidden"), 4000);
}
function uid(){ return "id_"+Date.now()+"_"+Math.random().toString(36).slice(2,8); }
function openIdb(){ return new Promise((res,rej)=>{ const r=indexedDB.open(IDB,1); r.onupgradeneeded=()=>r.result.createObjectStore("h"); r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error); }); }
async function idbSet(k,v){ const db=await openIdb(); return new Promise((res,rej)=>{ const t=db.transaction("h","readwrite"); t.objectStore("h").put(v,k); t.oncomplete=()=>res(); t.onerror=()=>rej(t.error); }); }
async function idbGet(k){ const db=await openIdb(); return new Promise((res,rej)=>{ const q=db.transaction("h","readonly").objectStore("h").get(k); q.onsuccess=()=>res(q.result); q.onerror=()=>rej(q.error); }); }

function persist(){
  localStorage.setItem("clip_ongoing", JSON.stringify(ongoing));
  localStorage.setItem("clip_queue", JSON.stringify(queue));
}
function saveState(){
  undoStack.push(JSON.stringify({ ongoing, queue }));
  if (undoStack.length > 40) undoStack.shift();
  updateUndo();
}
function undo(){
  if (!undoStack.length) return;
  const p = JSON.parse(undoStack.pop());
  ongoing = p.ongoing || []; queue = p.queue || [];
  persist(); updateUndo(); render(); toast("Undone");
}
function updateUndo(){
  const b = document.getElementById("undoBtn");
  if (b) b.disabled = !undoStack.length;
}
function status(){
  const p=[];
  if (ordersDir) p.push("Orders folder");
  if (dockDir) p.push("Dock folder");
  if (pdfDir) p.push(pdfMap.size+" PDFs");
  document.getElementById("status").textContent = p.join(" · ") || "Link folders";
}
function scrapTotal(o){ return Object.values(o.scrap||{}).reduce((a,n)=>a+n,0); }
function remaining(o){ return Math.max(0, (o.originalQty||0) - scrapTotal(o) - (o.shippedOut||0)); }

function parseCsv(row){
  const out=[]; let cur="",q=false;
  for (const ch of row){ if(ch==='"')q=!q; else if(ch===','&&!q){out.push(cur);cur="";} else cur+=ch; }
  out.push(cur); return out.map(x=>x.replace(/^"|"$/g,"").trim());
}

async function setOrdersFolder(){
  if (!window.showDirectoryPicker) return alert("Use Chrome/Edge");
  try { ordersDir = await window.showDirectoryPicker({mode:"read"}); await idbSet("ordersDir", ordersDir); status(); toast("Orders folder linked"); }
  catch(e){ if(e.name!=="AbortError") console.error(e); }
}
async function setDockFolder(){
  if (!window.showDirectoryPicker) return alert("Use Chrome/Edge");
  try { dockDir = await window.showDirectoryPicker({mode:"readwrite"}); await idbSet("dockDir", dockDir); status(); toast("Dock folder linked"); }
  catch(e){ if(e.name!=="AbortError") console.error(e); }
}
async function setPdfFolder(){
  if (!window.showDirectoryPicker) return alert("Use Chrome/Edge");
  try {
    pdfDir = await window.showDirectoryPicker({mode:"read"});
    await idbSet("pdfDir", pdfDir);
    await scanPdfs(); status(); toast(pdfMap.size+" PDFs indexed");
  } catch(e){ if(e.name!=="AbortError") console.error(e); }
}
async function scanPdfs(){
  pdfMap.clear();
  if (!pdfDir) return;
  async function walk(dir){
    for await (const e of dir.values()){
      if (e.kind==="file" && e.name.toLowerCase().endsWith(".pdf")){
        const base = e.name.replace(/\.pdf$/i,"");
        const key = base.toLowerCase();
        if (!pdfMap.has(key)) pdfMap.set(key, e);
      } else if (e.kind==="directory"){ try{ await walk(e); }catch(_){ } }
    }
  }
  await walk(pdfDir);
  const dl = document.getElementById("pdfList");
  if (dl) dl.innerHTML = [...pdfMap.keys()].map(k => {
    const name = [...pdfMap.entries()].find(([kk])=>kk===k)?.[1]?.name?.replace(/\.pdf$/i,"") || k;
    return `<option value="${String(name).replace(/"/g,"&quot;")}"></option>`;
  }).join("");
}
function hasPdf(part){ return pdfMap.has(String(part||"").trim().toLowerCase()); }
async function openPDF(part){
  const key = String(part||"").trim().toLowerCase();
  const h = pdfMap.get(key);
  if (!h){ alert("No PDF for "+part); return; }
  try { const f = await h.getFile(); window.open(URL.createObjectURL(f), "_blank"); }
  catch(e){ alert("Could not open PDF"); }
}
window.openPDF = openPDF;
window.getTodoData = () => ongoing.filter(o => remaining(o)>0 && !o.qc).map(o=>({...o, rem: remaining(o)}));

async function loadNewOrders(){
  if (!ordersDir) return alert("Link Orders Folder first");
  const files = [];
  for await (const e of ordersDir.values()){
    if (e.kind==="file" && e.name.toLowerCase().endsWith(".csv")) files.push(e);
  }
  if (!files.length) return alert("No CSV in orders folder");
  // load newest by name sort
  files.sort((a,b)=> b.name.localeCompare(a.name));
  const pick = prompt("Load which file?\n" + files.map(f=>f.name).join("\n") + "\n\nLeave blank for newest: "+files[0].name);
  const name = (pick||"").trim() || files[0].name;
  const match = files.find(f=>f.name===name);
  if (!match) return alert("Not found");
  const file = await match.getFile();
  let text = await file.text();
  if (text.charCodeAt(0)===0xfeff) text = text.slice(1);
  const lines = text.trim().split(/\r?\n/);
  saveState();
  const existing = new Set(ongoing.map(o=>o.po.toLowerCase()));
  let added=0, skipped=0;
  const addedList=[], skippedList=[];
  for (let i=1;i<lines.length;i++){
    if (!lines[i].trim()) continue;
    const v = parseCsv(lines[i]);
    // DateAdded,DueDate,Qty,Part,Designation,PO
    const po = v[5]||"";
    const partNo = v[3]||"";
    if (!po || !partNo) continue;
    if (existing.has(po.toLowerCase())){ skipped++; skippedList.push(po); continue; }
    const qty = parseInt(v[2],10)||1;
    ongoing.push({
      id: uid(), orderDate: v[0]||today(), dueDate: v[1]||"", originalQty: qty,
      shippedOut: 0, partNo, designation: v[4]||"Wolfsteel", po,
      scrap: {}, priority: false, qc: false
    });
    existing.add(po.toLowerCase());
    added++; addedList.push(`${qty}× ${partNo} PO ${po}`);
  }
  persist(); render();
  let msg = `Added ${added}`;
  if (addedList.length) msg += "\n"+addedList.slice(0,8).join("\n")+(addedList.length>8?"\n…":"");
  if (skipped) msg += `\n\nSkipped ${skipped} duplicate PO`+(skippedList.length?": "+skippedList.slice(0,5).join(", "):"");
  toast(msg);
}

function prioritize(i){
  saveState();
  ongoing[i].priority = !ongoing[i].priority;
  // move prioritized to top among peers
  ongoing.sort((a,b)=>{
    if (a.priority!==b.priority) return a.priority?-1:1;
    return String(a.dueDate).localeCompare(String(b.dueDate));
  });
  persist(); render();
}
function toggleQc(i){
  saveState();
  ongoing[i].qc = !ongoing[i].qc;
  persist(); render();
}

function openShip(i){
  shipIdx = i;
  const o = ongoing[i];
  const rem = remaining(o);
  if (rem<=0) return alert("Nothing left to ship");
  document.getElementById("shipTitle").textContent = `Ship ${o.partNo}`;
  document.getElementById("shipSub").textContent = `PO ${o.po} · remaining ${rem} / total ${o.originalQty}`;
  document.getElementById("shipQty").value = rem;
  document.getElementById("shipModal").classList.remove("hidden");
}
function closeShip(){ shipIdx=null; document.getElementById("shipModal").classList.add("hidden"); }
function confirmShip(){
  const o = ongoing[shipIdx];
  const qty = parseInt(document.getElementById("shipQty").value,10);
  const rem = remaining(o);
  if (!qty||qty<=0||qty>rem) return alert("Invalid qty");
  saveState();
  queue.push({ id: o.id, dueDate: o.dueDate, designation: o.designation, partNo: o.partNo, qty, po: o.po, originalQty: o.originalQty });
  o.shippedOut = (o.shippedOut||0) + qty;
  closeShip();
  // remove from ongoing if fully consumed (scrap+shipped)
  if (remaining(o)<=0 && scrapTotal(o)+ (o.shippedOut||0) >= o.originalQty) {
    // keep if scrap history useful? User said if 0 cleared off list
    ongoing.splice(shipIdx, 1);
  }
  persist(); render();
  toast(`Moved ${qty} to queue`);
}

function openScrap(i){
  scrapIdx=i; scrapBuf=[];
  const o=ongoing[i];
  document.getElementById("scrapTitle").textContent = `Scrap · PO ${o.po}`;
  document.getElementById("scrapSub").textContent = `${o.partNo} · remaining ${remaining(o)}`;
  document.getElementById("scrapQty").value=1;
  renderScrapBuf();
  document.getElementById("scrapModal").classList.remove("hidden");
}
function closeScrap(){ scrapIdx=null; document.getElementById("scrapModal").classList.add("hidden"); }
function renderScrapBuf(){
  const el=document.getElementById("scrapLines");
  el.innerHTML = scrapBuf.length
    ? scrapBuf.map((x,i)=>`<div class="flex justify-between px-3 py-1.5 rounded-xl bg-cream-100"><span>${x.qty} × ${x.type}</span><button class="text-rose-600 text-xs font-bold" onclick="scrapBuf.splice(${i},1);renderScrapBuf()">remove</button></div>`).join("")
    : `<div class="text-slate-400 text-xs">Add scrap lines</div>`;
}
function addScrapLine(){
  const qty=parseInt(document.getElementById("scrapQty").value,10);
  const type=document.getElementById("scrapType").value;
  if(!qty||qty<=0) return;
  const o=ongoing[scrapIdx];
  const used=scrapBuf.reduce((a,x)=>a+x.qty,0);
  if (used+qty > remaining(o)) return alert("Exceeds remaining");
  scrapBuf.push({type,qty}); renderScrapBuf();
}
function applyScrap(){
  if (scrapIdx==null||!scrapBuf.length) return;
  saveState();
  const o=ongoing[scrapIdx];
  if (!o.scrap) o.scrap={};
  scrapBuf.forEach(({type,qty})=>{ o.scrap[type]=(o.scrap[type]||0)+qty; });
  closeScrap();
  if (remaining(o)<=0) ongoing.splice(scrapIdx,1);
  persist(); render();
  toast("Scrap recorded");
}

function returnFromQueue(i){
  saveState();
  const item = queue[i];
  let o = ongoing.find(x=>x.id===item.id || (x.po||"").toLowerCase()===(item.po||"").toLowerCase());
  if (o) {
    o.shippedOut = Math.max(0, (o.shippedOut||0) - item.qty);
  } else {
    // restore as ongoing with full total known
    ongoing.push({
      id: item.id||uid(), dueDate: item.dueDate, designation: item.designation, partNo: item.partNo,
      po: item.po, originalQty: item.originalQty||item.qty, shippedOut: 0, scrap: {}, priority: false, qc: false
    });
  }
  queue.splice(i,1);
  persist(); render();
  toast("Returned to ongoing");
}

function openBolExport(){
  if (!queue.length) return alert("Queue empty");
  if (!dockDir) return alert("Link Dock Folder first");
  document.getElementById("bolWS").value="";
  document.getElementById("bolNAC").value="";
  document.getElementById("bolModal").classList.remove("hidden");
}
function closeBolExport(){ document.getElementById("bolModal").classList.add("hidden"); }

async function exportBol(){
  const hasWS = queue.some(q=>(q.designation||"")==="Wolfsteel");
  const hasNAC = queue.some(q=>(q.designation||"")==="NAC");
  const bolWS = document.getElementById("bolWS").value.trim();
  const bolNAC = document.getElementById("bolNAC").value.trim();
  if (hasWS && !bolWS) return alert("Enter Wolfsteel BOL #");
  if (hasNAC && !bolNAC) return alert("Enter NAC BOL #");
  const date = today();
  async function writeGroup(wn, bol){
    const items = queue.filter(q=>(q.designation||"")===wn);
    if (!items.length) return;
    // merge same PO+part
    const map = {};
    items.forEach(it=>{
      const k = (it.po+"|"+it.partNo).toLowerCase();
      if (!map[k]) map[k]={ qty:0, partNo:it.partNo, po:it.po };
      map[k].qty += it.qty;
    });
    let body = `DATE\t${date}\t\tBOL #\t${bol}\n`;
    body += `QTY\tPart Number\tPO\n`;
    Object.values(map).forEach(r=>{
      body += `${r.qty}\t${r.partNo}BK2GL\t${r.po}\n`;
    });
    // also csv companion
    let csv = "ShipDate,Qty,Part,PO,BOL,Designation\n";
    Object.values(map).forEach(r=>{
      csv += [date,r.qty,`"${r.partNo}"`,`"${r.po}"`,`"${bol}"`,`"${wn}"`].join(",")+"\n";
    });
    const safe = bol.replace(/[^\w\-]+/g,"_");
    const fh = await dockDir.getFileHandle(`BOL_${wn}_${safe}_${date}.txt`, {create:true});
    const w = await fh.createWritable(); await w.write(body); await w.close();
    const fh2 = await dockDir.getFileHandle(`BOL_${wn}_${safe}_${date}.csv`, {create:true});
    const w2 = await fh2.createWritable(); await w2.write("\ufeff"+csv); await w2.close();
  }
  saveState();
  if (hasWS) await writeGroup("Wolfsteel", bolWS);
  if (hasNAC) await writeGroup("NAC", bolNAC);
  // remove exported from queue
  queue = queue.filter(q=>{
    if ((q.designation||"")==="Wolfsteel" && hasWS) return false;
    if ((q.designation||"")==="NAC" && hasNAC) return false;
    return true;
  });
  closeBolExport();
  persist(); render();
  toast("BOL files written to Dock folder");
}

function openTodo(){
  const w = window.open("", "clipTodo", "width=480,height=760");
  if (!w) return alert("Allow popups");
  const html = `<!DOCTYPE html><html><head><title>To-Do</title>
  <style>
  body{font-family:Inter,Segoe UI,sans-serif;background:#12121a;color:#f1f0f5;margin:0;padding:16px}
  h1{font-size:18px;margin:0 0 4px}.hint{color:#6e6c7e;font-size:12px;margin:0 0 12px}
  .item{display:flex;align-items:center;gap:8px;padding:10px 12px;margin:6px 0;background:#1e1e2a;border-radius:12px;cursor:grab}
  .item.over{outline:2px solid #8B7AE8}.item.done .main{text-decoration:line-through;opacity:.55}
  .main{flex:1}.meta{color:#a8a6b8;font-size:12px}
  .pdf{border:0;border-radius:8px;padding:6px 8px;font-weight:700;font-size:11px;cursor:pointer;background:#134e4a;color:#99f6e4}
  .strike{border:0;border-radius:8px;padding:6px 8px;font-weight:700;font-size:11px;cursor:pointer;background:#3f3f50;color:#e2e0ea}
  </style></head><body>
  <h1>To-Do</h1>
  <p class="hint">Drag to reorder · Open PDF only when found · Strike = QC done (hidden from list after refresh)</p>
  <div id="list"></div>
  <script>
  function load(){
    try {
      if (window.opener && window.opener.getTodoData) return window.opener.getTodoData();
    } catch(e){}
    try { return JSON.parse(localStorage.getItem("clip_ongoing")||"[]").filter(function(o){
      var scrap=0; if(o.scrap) Object.keys(o.scrap).forEach(function(k){scrap+=o.scrap[k]||0;});
      var rem=Math.max(0,(o.originalQty||0)-scrap-(o.shippedOut||0));
      return rem>0 && !o.qc;
    }).map(function(o){ var scrap=0; if(o.scrap) Object.keys(o.scrap).forEach(function(k){scrap+=o.scrap[k]||0;});
      o.rem=Math.max(0,(o.originalQty||0)-scrap-(o.shippedOut||0)); return o; }); } catch(e){ return []; }
  }
  function orderIds(){ try{return JSON.parse(localStorage.getItem("clip_todoOrder")||"[]");}catch(e){return[];} }
  function saveOrder(ids){ localStorage.setItem("clip_todoOrder", JSON.stringify(ids)); }
  function sorted(){
    var data=load(); data.forEach(function(o,i){ if(!o.id) o.id="t"+i; });
    var ids=orderIds(), by={}; data.forEach(function(o){by[o.id]=o;});
    var out=[]; ids.forEach(function(id){ if(by[id]){out.push(by[id]); delete by[id];}});
    Object.keys(by).forEach(function(k){out.push(by[k]);}); return out;
  }
  function hasPdf(part){
    try { if (window.opener && window.opener.hasPdf) return window.opener.hasPdf(part); } catch(e){}
    return false;
  }
  function render(){
    var data=sorted(), list=document.getElementById("list");
    if(!data.length){ list.innerHTML='<p style="color:#6e6c7e">No open items (QC-checked are hidden)</p>'; return; }
    list.innerHTML=data.map(function(o){
      var pdfBtn = hasPdf(o.partNo) ? '<button class="pdf" data-part="'+String(o.partNo||"").replace(/"/g,"&quot;")+'">Open PDF</button>' : '';
      return '<div class="item" draggable="true" data-id="'+(o.id||'')+'"><div class="main"><strong>'+(o.rem||o.qty||'')+'</strong> '+(o.partNo||'')+
        '<div class="meta">'+(o.designation||'')+' · '+(o.dueDate||'')+' · PO '+(o.po||'')+'</div></div>'+
        pdfBtn+'<button class="strike" data-id="'+(o.id||'')+'">QC</button></div>';
    }).join("");
    list.querySelectorAll(".pdf").forEach(function(btn){
      btn.onclick=function(){ var p=btn.getAttribute("data-part"); if(window.opener&&window.opener.openPDF) window.opener.openPDF(p); };
    });
    list.querySelectorAll(".strike").forEach(function(btn){
      btn.onclick=function(){
        var id=btn.getAttribute("data-id");
        try {
          if (window.opener && window.opener.markQcById) window.opener.markQcById(id);
        } catch(e){}
        render();
      };
    });
    var dragId=null;
    list.querySelectorAll(".item").forEach(function(el){
      el.ondragstart=function(){ dragId=el.dataset.id; };
      el.ondragover=function(e){ e.preventDefault(); el.classList.add("over"); };
      el.ondragleave=function(){ el.classList.remove("over"); };
      el.ondrop=function(e){
        e.preventDefault(); el.classList.remove("over");
        if(!dragId||dragId===el.dataset.id) return;
        var ids=sorted().map(function(o){return o.id;});
        var from=ids.indexOf(dragId), to=ids.indexOf(el.dataset.id);
        if(from<0||to<0) return;
        ids.splice(to,0,ids.splice(from,1)[0]); saveOrder(ids); render();
      };
    });
  }
  render(); setInterval(render, 2000);
  <\/script></body></html>`;
  w.document.write(html); w.document.close();
}
window.hasPdf = hasPdf;
window.markQcById = function(id){
  const o = ongoing.find(x=>x.id===id);
  if (!o) return;
  saveState(); o.qc=true; persist(); render();
};

function render(){
  const t=today();
  document.getElementById("sOpen").textContent = ongoing.filter(o=>remaining(o)>0).length;
  document.getElementById("sOver").textContent = ongoing.filter(o=>remaining(o)>0 && o.dueDate && o.dueDate<t).length;
  document.getElementById("sQueue").textContent = queue.length;
  document.getElementById("sScrap").textContent = ongoing.filter(o=>scrapTotal(o)>0).length;

  ongoing.sort((a,b)=>{
    if(a.priority!==b.priority) return a.priority?-1:1;
    return String(a.dueDate).localeCompare(String(b.dueDate));
  });

  const tb=document.getElementById("ongoingTable");
  if(!ongoing.length) tb.innerHTML=`<tr><td colspan="11" class="text-center text-slate-400 py-8">Load orders from Bruno's Orders Folder</td></tr>`;
  else tb.innerHTML = ongoing.map((o,i)=>{
    const rem=remaining(o);
    const chips = Object.entries(o.scrap||{}).filter(([,n])=>n).map(([ty,n])=>`<span class="scrap-chip">${ty} ${n}</span>`).join(" ") || "—";
    const overdue = o.dueDate && o.dueDate<t && rem>0;
    return `<tr class="${o.priority?"priority-row":""} ${overdue?"overdue-row":""}">
      <td><button class="btn-action btn-prio btn-trendy" onclick="prioritize(${i})">${o.priority?"★":"☆"}</button></td>
      <td><input type="checkbox" ${o.qc?"checked":""} onchange="toggleQc(${i})" title="QC Checked — hide from To-Do" /></td>
      <td>${o.dueDate||""}</td>
      <td class="font-semibold">${rem}<span class="text-slate-400 text-xs"> / ${o.originalQty}</span></td>
      <td>${o.partNo||""}</td>
      <td>${o.designation||""}</td>
      <td class="font-semibold">${o.po||""}</td>
      <td class="text-xs">${chips}</td>
      <td><button class="btn-action btn-ship btn-trendy" onclick="openShip(${i})" ${rem<=0?"disabled":""}>Ship</button></td>
      <td><button class="btn-action btn-scrap btn-trendy" onclick="openScrap(${i})" ${rem<=0?"disabled":""}>Scrap</button></td>
      <td>${hasPdf(o.partNo)?`<button class="btn-action btn-trendy text-teal-700" onclick="openPDF('${String(o.partNo).replace(/'/g,"\\'")}')">PDF</button>`:""}</td>
    </tr>`;
  }).join("");

  const qt=document.getElementById("queueTable");
  if(!queue.length) qt.innerHTML=`<tr><td colspan="6" class="text-center text-slate-400 py-6">Empty</td></tr>`;
  else qt.innerHTML = queue.map((q,i)=>`<tr>
    <td>${q.dueDate||""}</td><td>${q.designation||""}</td><td>${q.partNo||""}</td>
    <td class="font-semibold">${q.qty}</td><td>${q.po||""}</td>
    <td><button class="btn-action btn-delete btn-trendy" onclick="returnFromQueue(${i})">Return</button></td>
  </tr>`).join("");

  updateUndo();
  if (window.lucide) lucide.createIcons();
}

async function restore(){
  try {
    for (const [key, mode] of [["ordersDir","read"],["dockDir","readwrite"],["pdfDir","read"]]) {
      const h = await idbGet(key);
      if (!h) continue;
      let p = await h.queryPermission({mode});
      if (p!=="granted") p = await h.requestPermission({mode});
      if (p==="granted") {
        if (key==="ordersDir") ordersDir=h;
        if (key==="dockDir") dockDir=h;
        if (key==="pdfDir"){ pdfDir=h; await scanPdfs(); }
      }
    }
  } catch(e){ console.warn(e); }
  status();
}
document.addEventListener("DOMContentLoaded", async ()=>{ await restore(); render(); if(window.lucide) lucide.createIcons(); });
