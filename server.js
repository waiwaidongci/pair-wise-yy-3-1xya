import http from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = join(__dirname, "data", "core-slices.json");
const port = Number(process.env.PORT || 3025);
const statuses = ["待切割", "制片中", "待观察", "已交付"];
const taskSteps = ["取样", "切割", "研磨", "染色", "观察"];

// —— 显微扫描业务常量 ——
const orderStatuses = ["使用中", "待返工", "已核销", "已失效"];
const ACTIVE_ORDER = new Set(["使用中", "待返工"]); // 未归还：占用切片与工位
const STANDARDS = { minWidth: 2048, minHeight: 1536, checksumRule: "8-64 位十六进制字符" };
const CHECKSUM_RE = /^[a-f0-9]{8,64}$/i;
const RESOLUTION_RE = /^(\d+)\s*[x×]\s*(\d+)$/i;

const defaultStations = [
  { id: "WS-01", name: "偏光显微扫描工位 01" },
  { id: "WS-02", name: "偏光显微扫描工位 02" },
  { id: "WS-03", name: "体式显微扫描工位 03" },
  { id: "WS-04", name: "荧光显微扫描工位 04" }
];

const seed = {
  samples: [
    {
      id: "CORE-001",
      project: "东岭铜矿薄片",
      borehole: "ZK-17",
      coreBox: "BX-09",
      depth: "128.4-128.8m",
      owner: "陆川",
      status: "制片中",
      delivery: "未交付",
      slices: [
        {
          id: "SL-001-A",
          method: "茜素红染色",
          slideId: "SLD-101",
          observation: "",
          status: "研磨",
          logs: [
            { at: "2026-06-12T10:00:00.000Z", step: "取样", note: "截取含矿化条带位置" },
            { at: "2026-06-13T11:20:00.000Z", step: "切割", note: "完成粗切" }
          ]
        }
      ]
    }
  ],
  stations: defaultStations,
  orders: [
    {
      id: "SO-20260618-7F3A",
      createdAt: "2026-06-18T01:30:00.000Z",
      sliceId: "SL-001-A",
      sampleId: "CORE-001",
      method: "茜素红染色",
      slideId: "SLD-101",
      stationId: "WS-01",
      status: "已核销",
      closedAt: "2026-06-18T03:05:00.000Z",
      returns: [
        { at: "2026-06-18T03:05:00.000Z", resolution: "4096x3072", checksum: "9af3c1d27b60e451", operator: "周岚", cracked: false, passed: true, reasons: [] }
      ],
      events: [
        { at: "2026-06-18T01:30:00.000Z", type: "出库", note: "核对通过：染色 茜素红染色｜载玻片 SLD-101｜工位 WS-01" },
        { at: "2026-06-18T03:05:00.000Z", type: "归还", note: "归还核销通过（分辨率 4096x3072｜校验码 9af3c1d27b60e451｜操作人 周岚）" }
      ]
    }
  ]
};

async function loadDb() {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    await writeFile(dbPath, JSON.stringify(seed, null, 2));
    return JSON.parse(JSON.stringify(seed));
  }
  const db = JSON.parse(await readFile(dbPath, "utf8"));
  // 旧档迁移：补齐工位与扫描单集合
  if (!Array.isArray(db.stations)) db.stations = defaultStations;
  if (!Array.isArray(db.orders)) db.orders = [];
  for (const sample of db.samples) for (const slice of sample.slices) if (!("slideId" in slice)) slice.slideId = "";
  return db;
}
async function saveDb(db) { await writeFile(dbPath, JSON.stringify(db, null, 2)); }
async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}
function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}
function nowIso() { return new Date().toISOString(); }
function trim(v) { return String(v ?? "").trim(); }
function updateSampleStatus(sample) {
  const sliceStatuses = sample.slices.map(slice => slice.status);
  if (sliceStatuses.length && sliceStatuses.every(step => step === "观察")) sample.status = "待观察";
  if (sample.delivery === "已交付") sample.status = "已交付";
  else if (sliceStatuses.some(step => ["取样", "切割", "研磨", "染色"].includes(step))) sample.status = "制片中";
  else sample.status = "待切割";
}
function findSlice(db, sliceId) {
  for (const sample of db.samples) {
    const slice = sample.slices.find(item => item.id === sliceId);
    if (slice) return { sample, slice };
  }
  return null;
}
function activeOrders(db) { return db.orders.filter(order => ACTIVE_ORDER.has(order.status)); }

// 待返工单失效重排：改样本编号/染色方法后调用，释放工位、旧单保留
function voidReworkOrders(db, sliceIds, reason) {
  const affected = [];
  const idSet = new Set(sliceIds);
  const at = nowIso();
  for (const order of db.orders) {
    if (order.status === "待返工" && idSet.has(order.sliceId)) {
      order.status = "已失效";
      order.voidedAt = at;
      order.voidReason = reason;
      order.events.push({ at, type: "失效", note: reason });
      affected.push(order);
    }
  }
  return affected;
}

// 归还判定：分辨率 / 图像校验码 / 操作人 / 裂纹
function evaluateReturn(input) {
  const reasons = [];
  const rawResolution = trim(input.resolution);
  let resolution = "";
  const match = RESOLUTION_RE.exec(rawResolution);
  if (!match) reasons.push("分辨率缺项或格式无效（需形如 4096×3072）");
  else {
    resolution = `${match[1]}x${match[2]}`;
    if (Number(match[1]) < STANDARDS.minWidth || Number(match[2]) < STANDARDS.minHeight) {
      reasons.push(`分辨率 ${resolution} 低于标准 ${STANDARDS.minWidth}×${STANDARDS.minHeight}`);
    }
  }
  const checksum = trim(input.checksum);
  if (!checksum) reasons.push("图像校验码缺项");
  else if (!CHECKSUM_RE.test(checksum)) reasons.push(`图像校验码不合规（需 ${STANDARDS.checksumRule}）`);
  const operator = trim(input.operator);
  if (!operator) reasons.push("操作人缺项");
  const cracked = Boolean(input.cracked);
  if (cracked) reasons.push("载玻片/切片存在裂纹");
  return { passed: reasons.length === 0, resolution, checksum, operator, cracked, reasons };
}

const page = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>显微扫描出库与归还核销台</title>
  <style>
    :root { --bg:#f1f3ef; --panel:#fff; --ink:#242822; --muted:#687062; --line:#d7ddd1; --accent:#526f43; --stone:#73706a; --warn:#b5552f; --info:#3f6386; --ok:#477a4b; --dead:#8a8a84; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:20px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; align-items:center; gap:16px; }
    h1 { margin:0; font-size:24px; } h2 { margin:0 0 12px; font-size:17px; } h3 { margin:0; font-size:16px; }
    nav { display:flex; gap:8px; padding:14px 28px 0; } nav button { background:#fff; color:var(--muted); border:1px solid var(--line); border-bottom:none; border-radius:8px 8px 0 0; padding:10px 18px; font-weight:700; cursor:pointer; }
    nav button.on { color:var(--accent); border-color:var(--accent); }
    main { padding:20px 28px; } .tab { display:none; } .tab.on { display:block; }
    form,.panel,.card,.stat { background:#fff; border:1px solid var(--line); border-radius:8px; padding:16px; }
    label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; } input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; background:#fff; } textarea { min-height:54px; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:9px 13px; font-weight:700; cursor:pointer; } button.ghost { background:#fff; color:var(--accent); border:1px solid var(--accent); }
    button.mini { padding:5px 9px; font-size:12px; }
    .cols2 { display:grid; grid-template-columns:390px 1fr; gap:18px; align-items:start; }
    .judge { display:grid; grid-template-columns:1.1fr 1fr; gap:18px; align-items:start; }
    .stats { display:grid; grid-template-columns:repeat(6,1fr); gap:10px; margin-bottom:14px; } .stat strong { display:block; font-size:22px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(330px,1fr)); gap:12px; } .card { display:grid; gap:8px; }
    .meta { color:var(--muted); font-size:13px; } .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:2px 9px; font-size:12px; }
    .b-active { color:var(--info); border-color:var(--info); } .b-rework { color:#fff;background:var(--warn);border-color:var(--warn); }
    .b-done { color:var(--ok); border-color:var(--ok); } .b-dead { color:var(--dead); border-color:var(--dead); }
    .slice { border-top:1px solid var(--line); padding-top:10px; display:grid; gap:6px; }
    .row2 { display:grid; grid-template-columns:1fr 1fr; gap:8px; } .row3 { display:grid; grid-template-columns:1fr 1fr auto; gap:8px; align-items:end; }
    .crow { display:grid; grid-template-columns:1.2fr 1fr 1fr 1fr auto; gap:6px; align-items:center; margin-bottom:8px; }
    .crow select,.crow input { padding:7px; font-size:13px; }
    .errbox { border:1px solid var(--warn); background:#fbf0ea; color:var(--warn); border-radius:6px; padding:10px; margin:10px 0; font-size:13px; white-space:pre-line; }
    .okbox { border:1px solid var(--ok); background:#eef5ee; color:var(--ok); border-radius:6px; padding:10px; margin:10px 0; font-size:13px; }
    table { width:100%; border-collapse:collapse; background:#fff; border:1px solid var(--line); border-radius:8px; overflow:hidden; }
    th,td { text-align:left; padding:9px 10px; border-bottom:1px solid var(--line); font-size:13px; } th { background:#f7f8f5; color:var(--muted); }
    .stations { display:grid; grid-template-columns:repeat(auto-fill,minmax(230px,1fr)); gap:12px; }
    .station-idle { border-left:4px solid var(--ok); } .station-busy { border-left:4px solid var(--info); } .station-rework { border-left:4px solid var(--warn); }
    .timeline { list-style:none; margin:12px 0 0; padding:0; } .timeline li { border-left:2px solid var(--line); padding:0 0 14px 14px; position:relative; font-size:13px; }
    .timeline li:before { content:""; position:absolute; left:-5px; top:4px; width:8px; height:8px; border-radius:50%; background:var(--accent); }
    .chips { display:flex; gap:6px; flex-wrap:wrap; margin-bottom:10px; } .chip { border:1px dashed var(--warn); color:var(--warn); border-radius:999px; padding:3px 10px; font-size:12px; cursor:pointer; background:#fff; }
    .filters button { margin-right:6px; } .filters button.on { background:var(--accent); color:#fff; }
    #toast { position:fixed; right:18px; bottom:18px; display:none; max-width:380px; border-radius:8px; padding:12px 14px; font-size:13px; color:#fff; box-shadow:0 4px 14px rgba(0,0,0,.18); white-space:pre-line; z-index:9; }
    #toast.ok { background:var(--ok); } #toast.err { background:var(--warn); }
    @media (max-width:1000px){ header{display:block;padding:16px;} main{padding:14px;} nav{padding:10px 14px 0;} .cols2,.judge{grid-template-columns:1fr;} .stats{grid-template-columns:1fr 1fr 1fr;} .crow{grid-template-columns:1fr 1fr;} }
  </style>
</head>
<body>
  <header>
    <div><h1>显微扫描出库与归还核销台</h1><div class="meta">入口建档 · 出库核对 / 归还判定 · 列表 / 工位 / 履历存储</div></div>
    <div><span class="meta" id="updated"></span> <button id="reload">刷新</button></div>
  </header>
  <nav>
    <button data-tab="entry" class="on">入口</button>
    <button data-tab="judge">判定（出库 / 归还）</button>
    <button data-tab="store">存储（列表 / 工位 / 履历）</button>
  </nav>
  <main>
    <section class="tab on" id="tab-entry">
      <div class="cols2">
        <form id="form">
          <h2>入口 · 创建岩芯样本</h2>
          <label>项目</label><input name="project" required>
          <label>钻孔编号</label><input name="borehole" required>
          <label>岩芯箱号</label><input name="coreBox" required>
          <label>取样深度</label><input name="depth" required>
          <label>负责人</label><input name="owner" required>
          <label>初始切片编号</label><input name="sliceId" required>
          <label>染色方法</label><input name="method" required>
          <label>载玻片编号</label><input name="slideId" placeholder="如 SLD-102" required>
          <button>建档入库</button>
        </form>
        <section>
          <div class="stats" id="entry-stats"></div>
          <div class="grid" id="samples"></div>
        </section>
      </div>
    </section>

    <section class="tab" id="tab-judge">
      <div class="judge">
        <div class="panel">
          <h2>出库核对（整单原子校验）</h2>
          <div class="meta">每片仅允许一笔未归还扫描单；核对编号、染色方法、载玻片、工位，任一缺项或冲突则整单拒绝。</div>
          <div class="chips" id="requeue"></div>
          <div id="co-rows" style="margin-top:10px"></div>
          <button class="ghost" data-action="co-add-row">+ 增加一片</button>
          <div style="margin-top:12px"><button data-action="co-submit">提交出库单</button></div>
          <div id="co-msg"></div>
        </div>
        <div class="panel">
          <h2>归还登记与核销</h2>
          <div class="meta">登记分辨率（≥标准）、图像校验码、操作人；任一不达标或有裂纹 → 仅转待返工，工位不释放。</div>
          <div id="returns" style="margin-top:10px"></div>
        </div>
      </div>
    </section>

    <section class="tab" id="tab-store">
      <div class="stats" id="store-stats"></div>
      <div class="panel" style="margin-bottom:14px">
        <h2>扫描单列表</h2>
        <div class="filters" id="order-filters"></div>
        <table>
          <thead><tr><th>扫描单号</th><th>样本 / 切片</th><th>染色方法</th><th>载玻片</th><th>工位</th><th>状态</th><th>出库</th><th>完结/失效</th></tr></thead>
          <tbody id="order-rows"></tbody>
        </table>
      </div>
      <div class="panel" style="margin-bottom:14px">
        <h2>工位实况</h2>
        <div class="stations" id="stations"></div>
      </div>
      <div class="panel">
        <h2>切片履历</h2>
        <select id="hist-slice" style="max-width:360px"></select>
        <ul class="timeline" id="hist-list"></ul>
      </div>
    </section>
  </main>
  <div id="toast"></div>

  <script>
    const taskSteps = ${JSON.stringify(taskSteps)};
    const sampleStatuses = ${JSON.stringify(statuses)};
    const orderStatuses = ${JSON.stringify(orderStatuses)};
    const standards = ${JSON.stringify(STANDARDS)};
    let state = { samples: [], stations: [], orders: [] };
    let orderFilter = "全部";

    function esc(v) { return String(v == null ? "" : v).replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c])); }
    function fmt(at) { return at ? new Date(at).toLocaleString("zh-CN", { hour12:false }) : "—"; }
    function findSlice(sliceId) {
      for (const sample of state.samples) { const slice = sample.slices.find(s => s.id === sliceId); if (slice) return { sample, slice }; }
      return null;
    }
    const isActive = o => o.status === "使用中" || o.status === "待返工";
    function activeOrders() { return state.orders.filter(isActive); }
    function orderSample(o) { const hit = findSlice(o.sliceId); return hit ? hit.sample : null; }
    function statusPill(s) {
      const cls = s === "使用中" ? "b-active" : s === "待返工" ? "b-rework" : s === "已核销" ? "b-done" : "b-dead";
      return '<span class="pill ' + cls + '">' + esc(s) + "</span>";
    }
    function toast(msg, ok) {
      const el = document.querySelector("#toast");
      el.textContent = msg; el.className = ok === false ? "err" : "ok"; el.style.display = "block";
      clearTimeout(el._t); el._t = setTimeout(() => { el.style.display = "none"; }, 4200);
    }
    async function api(path, options) {
      const res = await fetch(path, options && options.body ? { ...options, headers: { "Content-Type": "application/json" } } : options);
      const data = await res.json();
      if (!res.ok) throw Object.assign(new Error(data.error || "请求失败"), { data });
      return data;
    }

    // —— 入口模块 ——
    function renderEntry() {
      document.querySelector("#entry-stats").innerHTML = sampleStatuses.map(s =>
        '<div class="stat"><span>' + s + '</span><strong>' + state.samples.filter(item => item.status === s).length + '</strong></div>').join("");
      document.querySelector("#samples").innerHTML = state.samples.map(sample =>
        '<article class="card"><h3>' + esc(sample.project) + '</h3>' +
        '<div>' + statusPill(sample.status) + ' <span class="pill">' + esc(sample.delivery) + "</span></div>" +
        '<div class="meta">' + esc(sample.borehole) + " · " + esc(sample.coreBox) + " · " + esc(sample.depth) + " · " + esc(sample.owner) + "</div>" +
        '<div class="row3"><div><label>样本编号（修改后待返工单失效重排）</label><input data-rename="' + esc(sample.id) + '" value="' + esc(sample.id) + '"></div><div style="padding-bottom:6px"><button data-action="rename-sample" data-id="' + esc(sample.id) + '">改样本编号</button></div><div></div></div>' +
        sample.slices.map(slice =>
          '<div class="slice"><b>' + esc(slice.id) + '</b><div class="meta">当前制片步骤：' + esc(slice.status) + "</div>" +
          '<div class="row2"><div><label>染色方法</label><input data-emethod="' + esc(sample.id) + "|" + esc(slice.id) + '" value="' + esc(slice.method) + '"></div>' +
          '<div><label>载玻片编号</label><input data-eslide="' + esc(sample.id) + "|" + esc(slice.id) + '" value="' + esc(slice.slideId || "") + '"></div></div>' +
          '<div><button class="mini" data-action="save-entry" data-key="' + esc(sample.id) + "|" + esc(slice.id) + '">保存入口信息</button></div>' +
          '<div class="row2"><div><label>制片步骤</label><select data-step="' + esc(sample.id) + "|" + esc(slice.id) + '">' + taskSteps.map(s => '<option>' + s + '</option>').join("") + '</select></div>' +
          '<div><label>备注 / 观察</label><input data-note="' + esc(sample.id) + "|" + esc(slice.id) + '" placeholder="步骤备注或观察结果"></div></div>' +
          '<div><button class="mini ghost" data-action="log-step" data-key="' + esc(sample.id) + "|" + esc(slice.id) + '">记录步骤</button></div>' +
          '<div class="meta">履历：' + esc(slice.logs.slice(-3).map(l => l.step + " " + l.note).join(" / ") || "无") + "</div></div>"
        ).join("") +
        '<div class="row3"><div><label>新增切片编号</label><input data-add-id="' + esc(sample.id) + '" placeholder="切片编号"></div>' +
        '<div><label>染色 / 载玻片</label><input data-add-method="' + esc(sample.id) + '" placeholder="染色方法"></div><div style="padding-bottom:4px"><input data-add-slide="' + esc(sample.id) + '" placeholder="载玻片编号" style="margin-bottom:4px"><button class="mini" data-action="add-slice" data-id="' + esc(sample.id) + '">添加切片</button></div></div>' +
        '<div><button class="mini ghost" data-action="deliver" data-id="' + esc(sample.id) + '">标记交付</button></div></article>'
      ).join("");
      state.samples.forEach(sample => sample.slices.forEach(slice => {
        const sel = document.querySelector('[data-step="' + sample.id + "|" + slice.id + '"]');
        if (sel) sel.value = slice.status;
      }));
    }

    // —— 判定模块：出库 ——
    function allSliceOptions() {
      return state.samples.flatMap(sample => sample.slices.map(slice =>
        '<option value="' + esc(slice.id) + '">' + esc(sample.id) + "（" + esc(sample.project) + "）</option>")).join("");
    }
    function requeueSlices() {
      // 最近一笔扫描单为「已失效」→ 待重排
      const latest = new Map();
      state.orders.forEach(o => { const prev = latest.get(o.sliceId); if (!prev || o.createdAt >= prev.createdAt) latest.set(o.sliceId, o); });
      return [...latest.values()].filter(o => o.status === "已失效").map(o => o.sliceId);
    }
    function checkoutRows() {
      return [...document.querySelectorAll("#co-rows .crow")];
    }
    function addCheckoutRow(prefill) {
      const div = document.createElement("div");
      div.className = "crow";
      div.innerHTML =
        '<select data-co-slice><option value="">切片编号…</option>' + allSliceOptions() + "</select>" +
        '<input data-co-method placeholder="染色方法（核对）">' +
        '<input data-co-slide placeholder="载玻片编号">' +
        '<select data-co-station><option value="">工位…</option>' + state.stations.map(st => '<option value="' + esc(st.id) + '">' + esc(st.id) + "</option>").join("") + "</select>" +
        '<button class="mini ghost" data-action="co-del-row">移除</button>';
      if (prefill) {
        const hit = findSlice(prefill);
        div.querySelector("[data-co-slice]").value = prefill;
        if (hit) { div.querySelector("[data-co-method]").value = hit.slice.method; div.querySelector("[data-co-slide]").value = hit.slice.slideId || ""; }
      }
      document.querySelector("#co-rows").appendChild(div);
    }
    function renderRequeueChips() {
      const ids = requeueSlices();
      document.querySelector("#requeue").innerHTML = ids.length
        ? '<span class="meta">待重排：</span>' + ids.map(id => '<span class="chip" data-action="co-quick" data-id="' + esc(id) + '">' + esc(id) + " 重排出库</span>").join("")
        : "";
    }
    function renderReturns() {
      const actives = activeOrders().sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
      document.querySelector("#returns").innerHTML = actives.length ? actives.map(o => {
        const last = o.returns && o.returns.length ? o.returns[o.returns.length - 1] : null;
        return '<div class="card" style="margin-bottom:10px"><div><b>' + esc(o.id) + "</b> " + statusPill(o.status) +
          '<div class="meta">切片 ' + esc(o.sliceId) + "｜" + esc(o.method) + "｜载玻片 " + esc(o.slideId) + "｜工位 " + esc(o.stationId) + "｜出库 " + fmt(o.createdAt) + "</div></div>" +
          (o.status === "待返工" && last ? '<div class="errbox">上次归还未通过（工位继续占用）：\\n' + esc(last.reasons.join("；")) + "</div>" : "") +
          '<div class="row2"><div><label>分辨率（≥ ' + standards.minWidth + "×" + standards.minHeight + '）</label><input data-rt-res="' + esc(o.id) + '" placeholder="如 4096x3072"></div>' +
          '<div><label>图像校验码（' + esc(standards.checksumRule) + '）</label><input data-rt-check="' + esc(o.id) + '" placeholder="如 9af3c1d27b60e451"></div></div>' +
          '<div class="row2"><div><label>操作人</label><input data-rt-op="' + esc(o.id) + '" placeholder="操作人姓名"></div>' +
          '<div style="display:flex;align-items:center;gap:8px;padding-bottom:4px"><input type="checkbox" data-rt-crack="' + esc(o.id) + '" style="width:auto"> <span class="meta">有裂纹</span></div></div>' +
          '<div><button data-action="rt-submit" data-id="' + esc(o.id) + '">归还登记 / 核销</button></div></div>';
      }).join("") : '<div class="meta">当前没有未归还扫描单。</div>';
    }
    function renderJudge() {
      if (!checkoutRows().length) addCheckoutRow();
      else checkoutRows().forEach(row => {
        const sel = row.querySelector("[data-co-slice]");
        const cur = sel.value;
        sel.innerHTML = '<option value="">切片编号…</option>' + allSliceOptions();
        sel.value = cur;
        const st = row.querySelector("[data-co-station]");
        const stCur = st.value;
        st.innerHTML = '<option value="">工位…</option>' + state.stations.map(s => '<option value="' + esc(s.id) + '">' + esc(s.id) + "</option>").join("");
        st.value = stCur;
      });
      renderRequeueChips();
      renderReturns();
    }

    // —— 存储模块 ——
    function renderStore() {
      const count = s => state.orders.filter(o => o.status === s).length;
      document.querySelector("#store-stats").innerHTML =
        '<div class="stat"><span>使用中</span><strong style="color:var(--info)">' + count("使用中") + "</strong></div>" +
        '<div class="stat"><span>待返工</span><strong style="color:var(--warn)">' + count("待返工") + "</strong></div>" +
        '<div class="stat"><span>已核销</span><strong style="color:var(--ok)">' + count("已核销") + "</strong></div>" +
        '<div class="stat"><span>已失效</span><strong style="color:var(--dead)">' + count("已失效") + "</strong></div>" +
        '<div class="stat"><span>占用工位</span><strong>' + new Set(activeOrders().map(o => o.stationId)).size + "/" + state.stations.length + "</strong></div>" +
        '<div class="stat"><span>扫描单总数</span><strong>' + state.orders.length + "</strong></div>";
      const filters = ["全部"].concat(orderStatuses);
      document.querySelector("#order-filters").innerHTML = filters.map(f =>
        '<button class="mini ghost ' + (f === orderFilter ? "on" : "") + '" data-action="filter" data-f="' + esc(f) + '">' + esc(f) + "</button>").join("");
      const rows = state.orders.filter(o => orderFilter === "全部" || o.status === orderFilter)
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      document.querySelector("#order-rows").innerHTML = rows.map(o => {
        const sample = orderSample(o);
        return "<tr><td>" + esc(o.id) + "</td><td>" + esc(sample ? sample.id : "（样本已改号）") + " / " + esc(o.sliceId) +
          "</td><td>" + esc(o.method) + "</td><td>" + esc(o.slideId) + "</td><td>" + esc(o.stationId) + "</td><td>" + statusPill(o.status) +
          "</td><td>" + fmt(o.createdAt) + "</td><td>" + fmt(o.closedAt || o.voidedAt) + "</td></tr>";
      }).join("") || '<tr><td colspan="8" class="meta">暂无扫描单</td></tr>';

      document.querySelector("#stations").innerHTML = state.stations.map(st => {
        const occ = activeOrders().find(o => o.stationId === st.id);
        const cls = !occ ? "station-idle" : occ.status === "待返工" ? "station-rework" : "station-busy";
        return '<div class="card ' + cls + '"><h3>' + esc(st.id) + '</h3><div class="meta">' + esc(st.name) + "</div>" +
          (occ ? '<div>' + statusPill(occ.status) + '</div><div class="meta">' + esc(occ.id) + "｜切片 " + esc(occ.sliceId) + "<br>载玻片 " + esc(occ.slideId) + "<br>自 " + fmt(occ.createdAt) + "</div>"
                  : '<div class="pill b-done">空闲</div>') + "</div>";
      }).join("");

      const histSel = document.querySelector("#hist-slice");
      const histCur = histSel.value;
      histSel.innerHTML = state.samples.flatMap(sample => sample.slices.map(slice =>
        '<option value="' + esc(slice.id) + '">' + esc(sample.id) + " / " + esc(slice.id) + "（" + esc(slice.method) + "）</option>")).join("");
      if (histCur) histSel.value = histCur;
      renderHistory(histSel.value);
    }
    function renderHistory(sliceId) {
      const el = document.querySelector("#hist-list");
      if (!sliceId) { el.innerHTML = '<li class="meta">请选择切片</li>'; return; }
      const hit = findSlice(sliceId);
      if (!hit) { el.innerHTML = ""; return; }
      const rows = [];
      hit.slice.logs.forEach(l => rows.push({ at: l.at, title: "制片 · " + l.step, detail: l.note }));
      state.orders.filter(o => o.sliceId === sliceId).forEach(o =>
        o.events.forEach(ev => rows.push({ at: ev.at, title: "扫描单 " + o.id + " · " + ev.type, detail: ev.note })));
      rows.sort((a, b) => String(b.at).localeCompare(String(a.at)));
      el.innerHTML = rows.map(r => "<li><b>" + esc(r.title) + '</b> <span class="meta">' + fmt(r.at) + "</span><div>" + esc(r.detail) + "</div></li>").join("");
    }

    async function load() {
      state = await api("/api/state");
      document.querySelector("#updated").textContent = "存储刷新于 " + new Date().toLocaleTimeString("zh-CN", { hour12: false });
      renderEntry(); renderJudge(); renderStore();
    }

    document.querySelector("#reload").onclick = () => load().then(() => toast("列表、工位、履历已按存储刷新一致"));
    document.querySelectorAll("[data-tab]").forEach(btn => btn.onclick = () => {
      document.querySelectorAll("nav button").forEach(b => b.classList.toggle("on", b === btn));
      document.querySelectorAll(".tab").forEach(t => t.classList.toggle("on", t.id === "tab-" + btn.dataset.tab));
    });
    document.querySelector("#hist-slice").onchange = e => renderHistory(e.target.value);
    document.querySelector("#order-filters").onclick = () => {};

    document.addEventListener("click", async event => {
      const btn = event.target.closest("[data-action]");
      if (!btn) return;
      const action = btn.dataset.action;
      try {
        if (action === "add-slice") {
          const id = btn.dataset.id;
          const payload = {
            id: document.querySelector('[data-add-id="' + id + '"]').value,
            method: document.querySelector('[data-add-method="' + id + '"]').value || "未指定",
            slideId: document.querySelector('[data-add-slide="' + id + '"]').value || ""
          };
          if (!payload.id) return toast("切片编号不能为空", false);
          await api("/api/samples/" + encodeURIComponent(id) + "/slices", { method: "POST", body: JSON.stringify(payload) });
          await load(); toast("切片已建档入库");
        } else if (action === "save-entry") {
          const [sampleId, sliceId] = btn.dataset.key.split("|");
          const payload = {
            method: document.querySelector('[data-emethod="' + sampleId + "|" + sliceId + '"]').value,
            slideId: document.querySelector('[data-eslide="' + sampleId + "|" + sliceId + '"]').value
          };
          const r = await api("/api/samples/" + encodeURIComponent(sampleId) + "/slices/" + encodeURIComponent(sliceId), { method: "PATCH", body: JSON.stringify(payload) });
          await load();
          toast(r.notice || "入口信息已保存");
        } else if (action === "rename-sample") {
          const oldId = btn.dataset.id;
          const newId = document.querySelector('[data-rename="' + oldId + '"]').value;
          const r = await api("/api/samples/" + encodeURIComponent(oldId), { method: "PATCH", body: JSON.stringify({ id: newId }) });
          await load();
          toast(r.notice || ("样本编号已改为 " + newId));
        } else if (action === "log-step") {
          const [sampleId, sliceId] = btn.dataset.key.split("|");
          await api("/api/samples/" + encodeURIComponent(sampleId) + "/slices/" + encodeURIComponent(sliceId) + "/logs", {
            method: "POST",
            body: JSON.stringify({
              step: document.querySelector('[data-step="' + sampleId + "|" + sliceId + '"]').value,
              note: document.querySelector('[data-note="' + sampleId + "|" + sliceId + '"]').value || "步骤完成"
            })
          });
          await load();
        } else if (action === "deliver") {
          await api("/api/samples/" + encodeURIComponent(btn.dataset.id) + "/deliver", { method: "POST", body: JSON.stringify({}) });
          await load(); toast("样本已交付");
        } else if (action === "co-add-row") {
          addCheckoutRow();
        } else if (action === "co-del-row") {
          btn.closest(".crow").remove();
        } else if (action === "co-quick") {
          addCheckoutRow(btn.dataset.id);
          document.querySelector("#tab-judge").scrollIntoView();
        } else if (action === "co-submit") {
          const items = checkoutRows().map(row => ({
            sliceId: row.querySelector("[data-co-slice]").value,
            method: row.querySelector("[data-co-method]").value,
            slideId: row.querySelector("[data-co-slide]").value,
            stationId: row.querySelector("[data-co-station]").value
          }));
          const msg = document.querySelector("#co-msg");
          msg.innerHTML = "";
          try {
            const r = await api("/api/scan-orders", { method: "POST", body: JSON.stringify({ items }) });
            document.querySelector("#co-rows").innerHTML = "";
            addCheckoutRow();
            await load();
            toast("出库成功：" + r.orders.map(o => o.id).join("、") + "，工位已占用");
          } catch (e) {
            if (e.data && e.data.details) {
              msg.innerHTML = '<div class="errbox">' + esc(e.data.message) + "\\n" +
                e.data.details.map(d => "第 " + d.row + " 行 · " + esc(d.field) + "：" + esc(d.message)).join("\\n") + "</div>";
            } else throw e;
          }
        } else if (action === "rt-submit") {
          const id = btn.dataset.id;
          const payload = {
            resolution: document.querySelector('[data-rt-res="' + id + '"]').value,
            checksum: document.querySelector('[data-rt-check="' + id + '"]').value,
            operator: document.querySelector('[data-rt-op="' + id + '"]').value,
            cracked: document.querySelector('[data-rt-crack="' + id + '"]').checked
          };
          const r = await api("/api/scan-orders/" + encodeURIComponent(id) + "/return", { method: "POST", body: JSON.stringify(payload) });
          await load();
          toast(r.verdict.passed ? id + " 归还核销通过，工位已释放" : id + " 转待返工：" + r.verdict.reasons.join("；") + "（工位不释放）", r.verdict.passed);
        } else if (action === "filter") {
          orderFilter = btn.dataset.f;
          renderStore();
        }
      } catch (e) {
        toast(e.message, false);
      }
    });

    document.querySelector("#form").onsubmit = async event => {
      event.preventDefault();
      await api("/api/samples", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(event.target).entries())) });
      event.target.reset();
      await load();
      toast("样本已建档入库");
    };

    load();
  </script>
</body>
</html>`;

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const db = await loadDb();
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(page);
    }

    // —— 存储模块：单一数据源，列表 / 工位 / 履历全部派生 ——
    if (req.method === "GET" && url.pathname === "/api/state") {
      return sendJson(res, 200, { samples: db.samples, stations: db.stations, orders: db.orders, standards: STANDARDS });
    }
    if (req.method === "GET" && url.pathname === "/api/samples") return sendJson(res, 200, db.samples);

    // —— 入口模块：建档 ——
    if (req.method === "POST" && url.pathname === "/api/samples") {
      const input = await body(req);
      const sample = {
        id: `CORE-${Date.now()}`,
        project: input.project, borehole: input.borehole, coreBox: input.coreBox,
        depth: input.depth, owner: input.owner,
        status: "待切割", delivery: "未交付",
        slices: [{
          id: input.sliceId, method: input.method, slideId: trim(input.slideId),
          observation: "", status: "取样",
          logs: [{ at: nowIso(), step: "取样", note: "创建初始切片任务，载玻片 " + (trim(input.slideId) || "未绑定") }]
        }]
      };
      updateSampleStatus(sample);
      db.samples.unshift(sample);
      await saveDb(db);
      return sendJson(res, 201, sample);
    }

    // —— 入口模块：改样本编号（待返工单失效重排，旧记录保留）——
    const renameMatch = url.pathname.match(/^\/api\/samples\/([^/]+)$/);
    if (renameMatch && req.method === "PATCH") {
      const sample = db.samples.find(item => item.id === renameMatch[1]);
      if (!sample) return sendJson(res, 404, { error: "sample_not_found" });
      const input = await body(req);
      const newId = trim(input.id);
      if (!newId) return sendJson(res, 400, { error: "sample_id_required" });
      if (db.samples.some(item => item !== sample && item.id === newId)) {
        return sendJson(res, 409, { error: "sample_id_conflict", message: "样本编号已存在" });
      }
      const oldId = sample.id;
      sample.id = newId;
      const at = nowIso();
      const affected = voidReworkOrders(db, sample.slices.map(slice => slice.id), `样本编号由 ${oldId} 变更为 ${newId}，待返工单失效并重新排程`);
      for (const order of affected) {
        const hit = findSlice(db, order.sliceId);
        hit?.slice.logs.push({ at, step: "扫描调度", note: `样本编号改为 ${newId}，待返工单 ${order.id} 失效重排（旧单保留）` });
      }
      await saveDb(db);
      return sendJson(res, 200, { sample, voided: affected.map(order => order.id), notice: affected.length ? `样本编号已改；${affected.length} 笔待返工单失效重排，工位已释放` : "样本编号已改" });
    }

    const addSlice = url.pathname.match(/^\/api\/samples\/([^/]+)\/slices$/);
    if (addSlice && req.method === "POST") {
      const sample = db.samples.find(item => item.id === addSlice[1]);
      if (!sample) return sendJson(res, 404, { error: "sample_not_found" });
      const input = await body(req);
      const sliceId = trim(input.id);
      if (!sliceId) return sendJson(res, 400, { error: "slice_id_required" });
      if (findSlice(db, sliceId)) return sendJson(res, 409, { error: "slice_id_conflict", message: "切片编号已存在" });
      sample.slices.push({
        id: sliceId, method: trim(input.method) || "未指定", slideId: trim(input.slideId),
        observation: "", status: "取样",
        logs: [{ at: nowIso(), step: "取样", note: "新增切片任务" }]
      });
      updateSampleStatus(sample);
      await saveDb(db);
      return sendJson(res, 201, sample);
    }

    // —— 入口模块：改染色方法 / 载玻片（改染色方法后待返工单失效重排）——
    const patchSlice = url.pathname.match(/^\/api\/samples\/([^/]+)\/slices\/([^/]+)$/);
    if (patchSlice && req.method === "PATCH") {
      const sample = db.samples.find(item => item.id === patchSlice[1]);
      if (!sample) return sendJson(res, 404, { error: "sample_not_found" });
      const slice = sample.slices.find(item => item.id === patchSlice[2]);
      if (!slice) return sendJson(res, 404, { error: "slice_not_found" });
      const input = await body(req);
      const at = nowIso();
      let affected = [];
      if (typeof input.method === "string" && trim(input.method) && trim(input.method) !== slice.method) {
        const oldMethod = slice.method;
        slice.method = trim(input.method);
        affected = voidReworkOrders(db, [slice.id], `染色方法由 ${oldMethod} 变更为 ${slice.method}，待返工单失效并重新排程`);
        slice.logs.push({ at, step: "档案变更", note: `染色方法由 ${oldMethod} 改为 ${slice.method}${affected.length ? `；待返工单 ${affected.map(o => o.id).join("、")} 失效重排（旧单保留）` : ""}` });
      }
      if (typeof input.slideId === "string") {
        const newSlide = trim(input.slideId);
        if (newSlide !== (slice.slideId || "")) {
          slice.slideId = newSlide;
          slice.logs.push({ at, step: "档案变更", note: `载玻片绑定改为 ${newSlide || "未绑定"}` });
        }
      }
      await saveDb(db);
      return sendJson(res, 200, { sample, voided: affected.map(order => order.id), notice: affected.length ? `${affected.length} 笔待返工单因染色方法变更失效重排，工位已释放` : "入口信息已保存" });
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
      slice.logs.push({ at: nowIso(), step: input.step, note: input.note || "" });
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

    // —— 判定模块：出库核对（批量整单，任一缺项/冲突整单拒绝）——
    if (req.method === "POST" && url.pathname === "/api/scan-orders") {
      const input = await body(req);
      const items = Array.isArray(input.items) ? input.items : [];
      if (!items.length) return sendJson(res, 400, { error: "empty_order", message: "出库单没有任何切片行" });
      const details = [];
      const seenSlice = new Map();
      const seenStation = new Map();

      items.forEach((raw, index) => {
        const row = index + 1;
        const sliceId = trim(raw.sliceId);
        const method = trim(raw.method);
        const slideId = trim(raw.slideId);
        const stationId = trim(raw.stationId);
        const push = (field, message) => details.push({ row, field, message });

        if (!sliceId) return push("切片编号", "缺项");
        const hit = findSlice(db, sliceId);
        if (!hit) return push("切片编号", `编号 ${sliceId} 不存在，无法核对`);
        if (seenSlice.has(sliceId)) push("切片编号", `与本单第 ${seenSlice.get(sliceId)} 行重复`);
        else seenSlice.set(sliceId, row);
        const existing = activeOrders(db).find(order => order.sliceId === sliceId);
        if (existing) push("切片编号", `已有未归还扫描单 ${existing.id}（状态：${existing.status}），每片仅限一笔`);

        if (!method) push("染色方法", "缺项");
        else if (method !== hit.slice.method) push("染色方法", `填报「${method}」与入口登记「${hit.slice.method}」冲突`);

        if (!slideId) push("载玻片", "缺项");
        else if (!hit.slice.slideId) push("载玻片", `切片 ${sliceId} 未在入口绑定载玻片，无法核对`);
        else if (slideId !== hit.slice.slideId) push("载玻片", `填报「${slideId}」与入口绑定「${hit.slice.slideId}」冲突`);
        else if (activeOrders(db).some(order => order.slideId === slideId && order.sliceId !== sliceId)) push("载玻片", `载玻片 ${slideId} 已在其他未归还扫描单中`);

        if (!stationId) push("工位", "缺项");
        else if (!db.stations.some(st => st.id === stationId)) push("工位", `工位 ${stationId} 不存在`);
        else {
          if (seenStation.has(stationId)) push("工位", `与本单第 ${seenStation.get(stationId)} 行重复占用`);
          else seenStation.set(stationId, row);
          const occupant = activeOrders(db).find(order => order.stationId === stationId);
          if (occupant) push("工位", `工位已被 ${occupant.id}（切片 ${occupant.sliceId}，状态：${occupant.status}）占用`);
        }
      });

      if (details.length) {
        return sendJson(res, 422, { error: "scan_order_rejected", message: "出库核对未通过，整单已拒绝（未落任何扫描单、未占工位）", details });
      }

      const at = nowIso();
      const created = items.map(raw => {
        const sliceId = trim(raw.sliceId);
        const hit = findSlice(db, sliceId);
        const order = {
          id: `SO-${Date.now().toString(36).toUpperCase()}-${String(db.orders.length + 1).padStart(2, "0")}`,
          createdAt: at,
          sliceId,
          sampleId: hit.sample.id,
          method: trim(raw.method),
          slideId: trim(raw.slideId),
          stationId: trim(raw.stationId),
          status: "使用中",
          returns: [],
          events: [{ at, type: "出库", note: `核对通过：编号 ${sliceId}｜染色 ${trim(raw.method)}｜载玻片 ${trim(raw.slideId)}｜工位 ${trim(raw.stationId)}` }]
        };
        hit.slice.logs.push({ at, step: "扫描调度", note: `出库至工位 ${order.stationId}，扫描单 ${order.id}` });
        db.orders.push(order);
        return order;
      });
      await saveDb(db);
      return sendJson(res, 201, { orders: created });
    }

    // —— 判定模块：归还登记 / 核销 ——
    const returnMatch = url.pathname.match(/^\/api\/scan-orders\/([^/]+)\/return$/);
    if (returnMatch && req.method === "POST") {
      const order = db.orders.find(item => item.id === returnMatch[1]);
      if (!order) return sendJson(res, 404, { error: "order_not_found" });
      if (!ACTIVE_ORDER.has(order.status)) return sendJson(res, 409, { error: "order_not_active", message: `扫描单 ${order.id} 当前为「${order.status}」，不可归还登记` });
      const input = await body(req);
      const verdict = evaluateReturn(input);
      const at = nowIso();
      const attempt = { at, resolution: verdict.resolution, checksum: verdict.checksum, operator: verdict.operator, cracked: verdict.cracked, passed: verdict.passed, reasons: verdict.reasons };
      order.returns.push(attempt);
      const hit = findSlice(db, order.sliceId);
      if (verdict.passed) {
        order.status = "已核销";
        order.closedAt = at;
        order.events.push({ at, type: "归还", note: `归还核销通过（分辨率 ${verdict.resolution}｜校验码 ${verdict.checksum}｜操作人 ${verdict.operator}），工位 ${order.stationId} 已释放` });
        hit?.slice.logs.push({ at, step: "扫描调度", note: `扫描单 ${order.id} 归还核销通过，工位 ${order.stationId} 释放` });
      } else {
        order.status = "待返工";
        order.events.push({ at, type: "归还", note: `归还未达标，仅转待返工，工位 ${order.stationId} 不释放：${verdict.reasons.join("；")}` });
        hit?.slice.logs.push({ at, step: "扫描调度", note: `扫描单 ${order.id} 归还未过，转待返工，工位 ${order.stationId} 保持占用` });
      }
      await saveDb(db);
      return sendJson(res, 200, { order, verdict });
    }

    sendJson(res, 404, { error: "not_found" });
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
});

server.listen(port, () => console.log(`Micro-scan checkout desk listening on http://localhost:${port}`));
