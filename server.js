import http from "node:http";
import { loadDb, saveDb } from "./src/store.js";
import { checkout, overview, registerReturn, relabelSample, relabelSlice } from "./src/intake.js";

const port = Number(process.env.PORT || 3025);
const statuses = ["待切割", "制片中", "待观察", "已交付"];
const taskSteps = ["取样", "切割", "研磨", "染色", "观察"];

async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}
function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}
function updateSampleStatus(sample) {
  const sliceStatuses = sample.slices.map(slice => slice.status);
  if (sliceStatuses.length && sliceStatuses.every(step => step === "观察")) sample.status = "待观察";
  if (sample.delivery === "已交付") sample.status = "已交付";
  else if (sliceStatuses.some(step => ["取样", "切割", "研磨", "染色"].includes(step))) sample.status = "制片中";
  else sample.status = "待切割";
}

const page = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>岩芯样本切片实验室 · 显微扫描核销台</title>
  <style>
    :root { --bg:#f1f3ef; --panel:#fff; --ink:#242822; --muted:#687062; --line:#d7ddd1; --accent:#526f43; --warn:#9a5b2d; --bad:#a03d3d; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; align-items:center; gap:16px; }
    h1 { margin:0; font-size:26px; } main { display:grid; grid-template-columns:390px 1fr; gap:22px; padding:22px 28px; }
    form,.panel,.card,.stat { background:#fff; border:1px solid var(--line); border-radius:8px; padding:16px; } h2 { margin:0 0 12px; font-size:18px; } h3 { margin:0 0 10px; font-size:16px; }
    label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; } input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; background:#fff; } textarea { min-height:68px; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:10px 13px; font-weight:700; cursor:pointer; margin-top:8px; }
    .stats { display:grid; grid-template-columns:repeat(4,1fr); gap:10px; margin-bottom:14px; } .stat strong { display:block; font-size:24px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(310px,1fr)); gap:12px; } .card { display:grid; gap:8px; }
    .meta { color:var(--muted); font-size:13px; } .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 8px; font-size:12px; }
    .slice { border-top:1px solid var(--line); padding-top:10px; }
    .scan { padding:0 28px 28px; } .scan-head { display:flex; align-items:center; gap:16px; margin-bottom:12px; }
    #scanMsg { font-size:14px; } #scanMsg.ok { color:var(--accent); } #scanMsg.err { color:var(--bad); }
    .scan-grid { display:grid; grid-template-columns:320px 1fr 1fr; gap:14px; align-items:start; }
    .ws { border:1px solid var(--line); border-radius:8px; padding:10px; margin-bottom:8px; display:flex; justify-content:space-between; align-items:center; gap:8px; }
    .ws.busy { border-color:var(--warn); } .ws.free { border-color:var(--accent); }
    .order { border:1px solid var(--line); border-radius:8px; padding:10px; margin-bottom:10px; }
    .order.已归还 { opacity:.75; } .order.已失效 { opacity:.6; }
    .ret { display:grid; grid-template-columns:1fr 1fr; gap:6px; margin-top:8px; } .ret .ck { display:flex; align-items:center; gap:6px; margin:0; color:var(--ink); }
    .ret .ck input { width:auto; } .ret button { grid-column:1 / -1; margin-top:2px; }
    .hist { max-height:420px; overflow:auto; } .hist div { padding:5px 0; border-bottom:1px dashed var(--line); }
    .relabel { display:grid; grid-template-columns:1fr 1fr auto; gap:6px; align-items:end; } .relabel button { margin-top:0; }
    @media (max-width:950px){ header{display:block;padding:18px 16px;} main{grid-template-columns:1fr;padding:16px;} .stats{grid-template-columns:1fr 1fr;} .scan{padding:0 16px 16px;} .scan-grid{grid-template-columns:1fr;} }
  </style>
</head>
<body>
  <header><div><h1>岩芯样本切片实验室</h1><div class="meta">样本、切片任务、制片步骤、交付与显微扫描出库归还</div></div><button id="reload">刷新</button></header>
  <main>
    <form id="form">
      <h2>创建岩芯样本</h2>
      <label>项目</label><input name="project" required>
      <label>钻孔编号</label><input name="borehole" required>
      <label>岩芯箱号</label><input name="coreBox" required>
      <label>取样深度</label><input name="depth" required>
      <label>负责人</label><input name="owner" required>
      <label>初始切片编号</label><input name="sliceId" required>
      <label>染色方法</label><input name="method" required>
      <button>保存样本</button>
    </form>
    <section>
      <div class="stats" id="stats"></div>
      <div class="grid" id="samples"></div>
    </section>
  </main>
  <section class="scan">
    <div class="scan-head"><h2>显微扫描出库与归还核销台</h2><span id="scanMsg"></span></div>
    <div class="scan-grid">
      <form id="checkoutForm">
        <h3>出库登记</h3>
        <label>切片编号</label><select name="sliceId" id="coSlice"></select>
        <label>染色方法</label><input name="method" id="coMethod" required>
        <label>载玻片编号</label><input name="slideNo" placeholder="如 SLD-1001" required>
        <label>扫描工位</label><select name="workstationId" id="coWs"></select>
        <button>出库</button>
      </form>
      <div class="panel"><h3>工位看板</h3><div id="wsBoard"></div><h3 style="margin-top:14px">履历</h3><div class="hist" id="history"></div></div>
      <div class="panel"><h3>扫描单列表</h3><div id="orders"></div></div>
    </div>
  </section>
  <script>
    const statuses = ${JSON.stringify(statuses)};
    const steps = ${JSON.stringify(taskSteps)};
    const form = document.querySelector("#form");
    const stats = document.querySelector("#stats");
    const samplesEl = document.querySelector("#samples");
    const checkoutForm = document.querySelector("#checkoutForm");
    const coSlice = document.querySelector("#coSlice");
    const coMethod = document.querySelector("#coMethod");
    const coWs = document.querySelector("#coWs");
    const scanMsg = document.querySelector("#scanMsg");
    let samples = [];
    let scan = { orders: [], workstations: [], history: [] };
    async function api(path, options) {
      const res = await fetch(path, options && options.body ? { ...options, headers:{ "Content-Type":"application/json" } } : options);
      const data = await res.json();
      if (!res.ok) { const err = new Error(data.error || "请求失败"); err.reasons = data.reasons || []; throw err; }
      return data;
    }
    function showMsg(text, ok) { scanMsg.textContent = text; scanMsg.className = ok ? "ok" : "err"; }
    function showErr(e) { showMsg([e.message].concat(e.reasons || []).join("；"), false); }
    function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;" }[c])); }
    function render() {
      stats.innerHTML = statuses.map(s => '<div class="stat"><span>'+s+'</span><strong>'+samples.filter(item => item.status === s).length+'</strong></div>').join("");
      samplesEl.innerHTML = samples.map(sample => '<article class="card"><h3>'+esc(sample.project)+'</h3><span class="pill">'+esc(sample.status)+'</span><div class="meta">'+esc(sample.id)+' · '+esc(sample.borehole)+' · '+esc(sample.coreBox)+' · '+esc(sample.depth)+' · '+esc(sample.owner)+'</div><div class="relabel"><input data-sample-newid="'+sample.id+'" placeholder="新样本编号"><button data-sample-relabel="'+sample.id+'">改样本编号</button></div><label>新增切片</label><input data-new-slice="'+sample.id+'" placeholder="切片编号"><input data-method="'+sample.id+'" placeholder="染色方法"><button data-add="'+sample.id+'">添加切片</button>'+sample.slices.map(slice => '<div class="slice"><b>'+esc(slice.id)+'</b><div class="meta">'+esc(slice.method)+' · 当前步骤 '+esc(slice.status)+'</div><div class="relabel"><input data-slice-newid="'+sample.id+'|'+slice.id+'" placeholder="新切片编号"><input data-slice-newmethod="'+sample.id+'|'+slice.id+'" placeholder="新染色方法"><button data-slice-relabel="'+sample.id+'|'+slice.id+'">改号/改染色</button></div><select data-step="'+sample.id+'|'+slice.id+'">'+steps.map(step => '<option>'+step+'</option>').join("")+'</select><textarea data-note="'+sample.id+'|'+slice.id+'" placeholder="步骤备注或观察结果"></textarea><button data-log="'+sample.id+'|'+slice.id+'">记录步骤</button><div class="meta">'+slice.logs.map(log => esc(log.step)+"："+esc(log.note)).join(" / ")+'</div></div>').join("")+'<button data-deliver="'+sample.id+'">标记交付</button></article>').join("");
      document.querySelectorAll("[data-step]").forEach(sel => {
        const [sampleId, sliceId] = sel.dataset.step.split("|");
        const sample = samples.find(s => s.id === sampleId);
        const slice = sample && sample.slices.find(s => s.id === sliceId);
        if (slice) sel.value = slice.status;
      });
      document.querySelectorAll("[data-add]").forEach(btn => btn.onclick = async () => {
        const id = btn.dataset.add;
        try {
          await api('/api/samples/'+encodeURIComponent(id)+'/slices', { method:'POST', body: JSON.stringify({ id: document.querySelector('[data-new-slice="'+id+'"]').value, method: document.querySelector('[data-method="'+id+'"]').value || "未指定" }) });
          await refresh();
        } catch(e) { showErr(e); }
      });
      document.querySelectorAll("[data-log]").forEach(btn => btn.onclick = async () => {
        const [sampleId, sliceId] = btn.dataset.log.split("|");
        try {
          await api('/api/samples/'+encodeURIComponent(sampleId)+'/slices/'+encodeURIComponent(sliceId)+'/logs', { method:'POST', body: JSON.stringify({ step: document.querySelector('[data-step="'+sampleId+'|'+sliceId+'"]').value, note: document.querySelector('[data-note="'+sampleId+'|'+sliceId+'"]').value || "步骤完成" }) });
          await refresh();
        } catch(e) { showErr(e); }
      });
      document.querySelectorAll("[data-deliver]").forEach(btn => btn.onclick = async () => {
        try { await api('/api/samples/'+encodeURIComponent(btn.dataset.deliver)+'/deliver', { method:'POST', body: JSON.stringify({}) }); await refresh(); } catch(e) { showErr(e); }
      });
      document.querySelectorAll("[data-sample-relabel]").forEach(btn => btn.onclick = async () => {
        const id = btn.dataset.sampleRelabel;
        try {
          await api('/api/samples/'+encodeURIComponent(id)+'/relabel', { method:'POST', body: JSON.stringify({ newId: document.querySelector('[data-sample-newid="'+id+'"]').value }) });
          showMsg("样本编号已变更，待返工单已失效重排", true);
          await refresh();
        } catch(e) { showErr(e); }
      });
      document.querySelectorAll("[data-slice-relabel]").forEach(btn => btn.onclick = async () => {
        const [sampleId, sliceId] = btn.dataset.sliceRelabel.split("|");
        try {
          await api('/api/samples/'+encodeURIComponent(sampleId)+'/slices/'+encodeURIComponent(sliceId)+'/relabel', { method:'POST', body: JSON.stringify({ newId: document.querySelector('[data-slice-newid="'+sampleId+'|'+sliceId+'"]').value, newMethod: document.querySelector('[data-slice-newmethod="'+sampleId+'|'+sliceId+'"]').value }) });
          showMsg("切片已改号/改染色，待返工单已失效重排", true);
          await refresh();
        } catch(e) { showErr(e); }
      });
    }
    function renderScan() {
      document.querySelector("#wsBoard").innerHTML = scan.workstations.map(ws => '<div class="ws '+(ws.status === "空闲" ? "free" : "busy")+'"><b>'+esc(ws.name)+'</b><span class="pill">'+esc(ws.status)+'</span><span class="meta">'+(ws.orderId ? "扫描单 "+esc(ws.orderId) : "可分配")+'</span></div>').join("");
      document.querySelector("#orders").innerHTML = scan.orders.length ? scan.orders.map(order => {
        const active = order.status === "出库中" || order.status === "待返工";
        const ret = order.return ? '<div class="meta">归还：分辨率 '+esc(order.return.resolution)+' · 校验码 '+esc(order.return.checksum)+' · 操作人 '+esc(order.return.operator)+' · '+(order.return.cracks ? "有裂纹" : "无裂纹")+' → '+esc(order.return.verdict)+(order.return.reasons && order.return.reasons.length ? "（"+esc(order.return.reasons.join("；"))+"）" : "")+'</div>' : "";
        const form = active ? '<div class="ret"><input data-res="'+order.id+'" placeholder="分辨率(dpi)"><input data-sum="'+order.id+'" placeholder="图像校验码(十六进制)"><input data-op="'+order.id+'" placeholder="操作人"><label class="ck"><input type="checkbox" data-crack="'+order.id+'"> 有裂纹</label><button data-return="'+order.id+'">归还登记</button></div>' : "";
        return '<div class="order '+order.status+'"><b>'+esc(order.id)+'</b> <span class="pill">'+esc(order.status)+'</span><div class="meta">切片 '+esc(order.sliceId)+' · '+esc(order.method)+' · 载玻片 '+esc(order.slideNo)+' · 工位 '+esc(order.workstationId)+(order.supersedes ? ' · 重排自 '+esc(order.supersedes) : "")+(order.invalidatedReason ? ' · '+esc(order.invalidatedReason) : "")+'</div>'+ret+form+'</div>';
      }).join("") : '<div class="meta">暂无扫描单</div>';
      document.querySelector("#history").innerHTML = scan.history.length ? scan.history.map(h => '<div class="meta">'+esc(h.at.slice(0,19).replace("T"," "))+' · '+esc(h.orderId)+' · '+esc(h.step)+'：'+esc(h.note)+'</div>').join("") : '<div class="meta">暂无履历</div>';
      coSlice.innerHTML = samples.flatMap(s => s.slices.map(sl => '<option value="'+esc(sl.id)+'" data-method="'+esc(sl.method)+'">'+esc(sl.id)+'（'+esc(s.id)+'）</option>')).join("");
      coWs.innerHTML = scan.workstations.map(ws => '<option value="'+esc(ws.id)+'"'+(ws.status !== "空闲" ? " disabled" : "")+'>'+esc(ws.name)+'（'+esc(ws.status)+'）</option>').join("");
      syncMethod();
      document.querySelectorAll("[data-return]").forEach(btn => btn.onclick = async () => {
        const id = btn.dataset.return;
        try {
          const order = await api('/api/scan/orders/'+encodeURIComponent(id)+'/return', { method:'POST', body: JSON.stringify({ resolution: document.querySelector('[data-res="'+id+'"]').value, checksum: document.querySelector('[data-sum="'+id+'"]').value, operator: document.querySelector('[data-op="'+id+'"]').value, cracks: document.querySelector('[data-crack="'+id+'"]').checked }) });
          showMsg(order.status === "已归还" ? id+" 归还核销合格，工位已释放" : id+" 进入待返工，工位继续占用", order.status === "已归还");
          await refresh();
        } catch(e) { showErr(e); }
      });
    }
    function syncMethod() { const opt = coSlice.selectedOptions && coSlice.selectedOptions[0]; coMethod.value = opt ? opt.dataset.method : ""; }
    coSlice.onchange = syncMethod;
    async function load(){ samples = await api("/api/samples"); render(); }
    async function loadScan(){ scan = await api("/api/scan/overview"); renderScan(); }
    async function refresh(){ await load(); await loadScan(); }
    document.querySelector("#reload").onclick = refresh;
    checkoutForm.onsubmit = async event => {
      event.preventDefault();
      try {
        const order = await api("/api/scan/checkout", { method:"POST", body: JSON.stringify(Object.fromEntries(new FormData(checkoutForm).entries())) });
        showMsg(order.id+" 出库成功", true);
        checkoutForm.reset();
        await refresh();
      } catch(e) { showErr(e); }
    };
    form.onsubmit = async event => {
      event.preventDefault();
      try {
        await api("/api/samples", { method:"POST", body: JSON.stringify(Object.fromEntries(new FormData(form).entries())) });
        form.reset(); await refresh();
      } catch(e) { showErr(e); }
    };
    refresh();
  </script>
</body>
</html>`;

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const db = await loadDb();
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type":"text/html; charset=utf-8" });
      return res.end(page);
    }
    if (req.method === "GET" && url.pathname === "/api/samples") return sendJson(res, 200, db.samples);
    if (req.method === "POST" && url.pathname === "/api/samples") {
      const input = await body(req);
      const sample = { id: `CORE-${Date.now()}`, project: input.project, borehole: input.borehole, coreBox: input.coreBox, depth: input.depth, owner: input.owner, status: "待切割", delivery: "未交付", slices: [{ id: input.sliceId, method: input.method, observation: "", status: "取样", logs: [{ at: new Date().toISOString(), step: "取样", note: "创建初始切片任务" }] }] };
      updateSampleStatus(sample);
      db.samples.unshift(sample);
      await saveDb(db);
      return sendJson(res, 201, sample);
    }
    const addSlice = url.pathname.match(/^\/api\/samples\/([^/]+)\/slices$/);
    if (addSlice && req.method === "POST") {
      const sample = db.samples.find(item => item.id === addSlice[1]);
      if (!sample) return sendJson(res, 404, { error: "sample_not_found" });
      const input = await body(req);
      sample.slices.push({ id: input.id, method: input.method || "未指定", observation: "", status: "取样", logs: [{ at: new Date().toISOString(), step: "取样", note: "新增切片任务" }] });
      updateSampleStatus(sample);
      await saveDb(db);
      return sendJson(res, 201, sample);
    }
    const logMatch = url.pathname.match(/^\/api\/samples\/([^/]+)\/slices\/([^/]+)\/logs$/);
    if (logMatch && req.method === "POST") {
      const sample = db.samples.find(item => item.id === logMatch[1]);
      if (!sample) return sendJson(res, 404, { error: "sample_not_found" });
      const slice = sample.slices.find(item => item.id === logMatch[2]);
      if (!slice) return sendJson(res, 404, { error: "slice_not_found" });
      const input = await body(req);
      slice.status = input.step;
      if (input.step === "观察") slice.observation = input.note || slice.observation;
      slice.logs.push({ at: new Date().toISOString(), step: input.step, note: input.note || "" });
      updateSampleStatus(sample);
      await saveDb(db);
      return sendJson(res, 200, sample);
    }
    const deliverMatch = url.pathname.match(/^\/api\/samples\/([^/]+)\/deliver$/);
    if (deliverMatch && req.method === "POST") {
      const sample = db.samples.find(item => item.id === deliverMatch[1]);
      if (!sample) return sendJson(res, 404, { error: "sample_not_found" });
      sample.delivery = "已交付";
      updateSampleStatus(sample);
      await saveDb(db);
      return sendJson(res, 200, sample);
    }
    const sliceRelabel = url.pathname.match(/^\/api\/samples\/([^/]+)\/slices\/([^/]+)\/relabel$/);
    if (sliceRelabel && req.method === "POST") {
      const result = await relabelSlice(db, decodeURIComponent(sliceRelabel[1]), decodeURIComponent(sliceRelabel[2]), await body(req));
      return sendJson(res, result.status, result.body);
    }
    const sampleRelabel = url.pathname.match(/^\/api\/samples\/([^/]+)\/relabel$/);
    if (sampleRelabel && req.method === "POST") {
      const result = await relabelSample(db, decodeURIComponent(sampleRelabel[1]), await body(req));
      return sendJson(res, result.status, result.body);
    }
    if (req.method === "GET" && url.pathname === "/api/scan/overview") return sendJson(res, 200, overview(db));
    if (req.method === "POST" && url.pathname === "/api/scan/checkout") {
      const result = await checkout(db, await body(req));
      return sendJson(res, result.status, result.body);
    }
    const returnMatch = url.pathname.match(/^\/api\/scan\/orders\/([^/]+)\/return$/);
    if (returnMatch && req.method === "POST") {
      const result = await registerReturn(db, decodeURIComponent(returnMatch[1]), await body(req));
      return sendJson(res, result.status, result.body);
    }
    sendJson(res, 404, { error: "not_found" });
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
});

server.listen(port, () => console.log(`Core slice lab app listening on http://localhost:${port}`));
