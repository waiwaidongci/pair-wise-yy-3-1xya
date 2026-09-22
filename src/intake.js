import { activeOrderOf, findSlice, saveDb } from "./store.js";
import { judgeCheckout, judgeReturn } from "./judge.js";

const now = () => new Date().toISOString();
let seq = 0;
function nextOrderId() {
  seq += 1;
  return `SO-${Date.now().toString(36).toUpperCase()}-${seq}`;
}

// 入口一：出库登记。判定不通过则整单拒绝，不落库、不占工位
export async function checkout(db, input) {
  const verdict = judgeCheckout(db, input);
  if (!verdict.ok) return { status: 409, body: { error: "出库整单拒绝", reasons: verdict.errors } };
  const at = now();
  const order = {
    id: nextOrderId(),
    sampleId: verdict.sample.id,
    sliceId: verdict.slice.id,
    method: verdict.slice.method,
    slideNo: String(input.slideNo).trim(),
    workstationId: verdict.workstation.id,
    status: "出库中",
    checkedOutAt: at,
    return: null,
    supersedes: null,
    invalidatedReason: null,
    logs: [{ at, step: "出库", note: `载玻片 ${String(input.slideNo).trim()} 于 ${verdict.workstation.name} 出库` }]
  };
  db.scanOrders.unshift(order);
  verdict.workstation.status = "占用";
  verdict.workstation.orderId = order.id;
  await saveDb(db);
  return { status: 201, body: order };
}

// 入口二：归还核销。登记即留痕；不合格或有裂纹只进待返工，不释放工位
export async function registerReturn(db, orderId, input) {
  const order = db.scanOrders.find(item => item.id === orderId);
  if (!order) return { status: 404, body: { error: `扫描单 ${orderId} 不存在` } };
  if (!["出库中", "待返工"].includes(order.status)) {
    return { status: 409, body: { error: `扫描单 ${order.id} 已核销或失效，不能归还登记` } };
  }
  const verdict = judgeReturn(input);
  const at = now();
  order.return = {
    at,
    resolution: verdict.resolution,
    checksum: verdict.checksum,
    operator: verdict.operator,
    cracks: verdict.cracks,
    verdict: verdict.ok ? "合格" : "待返工",
    reasons: verdict.errors
  };
  const workstation = db.workstations.find(ws => ws.id === order.workstationId);
  if (verdict.ok) {
    order.status = "已归还";
    order.logs.push({ at, step: "归还核销", note: `分辨率 ${verdict.resolution}，校验码 ${verdict.checksum}，操作人 ${verdict.operator}` });
    if (workstation && workstation.orderId === order.id) {
      workstation.status = "空闲";
      workstation.orderId = null;
    }
  } else {
    order.status = "待返工";
    order.logs.push({ at, step: "待返工", note: verdict.errors.join("；") });
    if (workstation) {
      workstation.status = "占用";
      workstation.orderId = order.id;
    }
  }
  await saveDb(db);
  return { status: 200, body: order };
}

// 待返工单失效重排：旧单置为已失效并保留，新单带上变更后的编号/方法，继承载玻片与工位继续排队返工
function invalidateRework(db, predicate, reason, updated) {
  const at = now();
  const reworked = [];
  const targets = db.scanOrders.filter(order => predicate(order) && order.status === "待返工");
  for (const order of targets) {
    order.status = "已失效";
    order.invalidatedReason = reason;
    order.logs.push({ at, step: "失效", note: reason });
    const replacement = {
      id: nextOrderId(),
      sampleId: updated.sampleId,
      sliceId: updated.sliceId,
      method: updated.method,
      slideNo: order.slideNo,
      workstationId: order.workstationId,
      status: "待返工",
      checkedOutAt: at,
      return: null,
      supersedes: order.id,
      invalidatedReason: null,
      logs: [{ at, step: "重排", note: `继承 ${order.id} 的返工任务，工位 ${order.workstationId} 继续占用` }]
    };
    db.scanOrders.unshift(replacement);
    const workstation = db.workstations.find(ws => ws.id === order.workstationId);
    if (workstation && workstation.orderId === order.id) workstation.orderId = replacement.id;
    reworked.push({ invalidated: order.id, replacement: replacement.id });
  }
  return reworked;
}

// 入口三：改切片编号或染色方法。待返工单失效重排，出库中单同步引用，旧记录保留
export async function relabelSlice(db, sampleId, sliceId, input) {
  const sample = db.samples.find(item => item.id === sampleId);
  if (!sample) return { status: 404, body: { error: `样本 ${sampleId} 不存在` } };
  const slice = sample.slices.find(item => item.id === sliceId);
  if (!slice) return { status: 404, body: { error: `切片 ${sliceId} 不存在` } };
  const newId = String(input.newId || "").trim();
  const newMethod = String(input.newMethod || "").trim();
  if (!newId && !newMethod) return { status: 400, body: { error: "未提供新切片编号或新染色方法" } };
  if (newId && newId !== slice.id && findSlice(db, newId)) {
    return { status: 409, body: { error: `切片编号 ${newId} 已存在，冲突` } };
  }
  const oldId = slice.id;
  const oldMethod = slice.method;
  if (newId) slice.id = newId;
  if (newMethod) slice.method = newMethod;
  const at = now();
  slice.logs.push({ at, step: "改号", note: `编号 ${oldId} → ${slice.id}，染色方法 ${oldMethod} → ${slice.method}` });

  const reason = `切片编号或染色方法变更（${oldId}/${oldMethod} → ${slice.id}/${slice.method}）`;
  const reworked = invalidateRework(db, order => order.sampleId === sample.id && order.sliceId === oldId, reason, { sampleId: sample.id, sliceId: slice.id, method: slice.method });
  for (const order of db.scanOrders.filter(item => item.sampleId === sample.id && item.sliceId === oldId && item.status === "出库中")) {
    order.sliceId = slice.id;
    order.method = slice.method;
    order.logs.push({ at, step: "同步改号", note: `切片变更为 ${slice.id}/${slice.method}，出库单同步更新` });
  }
  await saveDb(db);
  return { status: 200, body: { sample, reworked } };
}

// 入口三（样本级）：改样本编号，其下所有切片的待返工单失效重排
export async function relabelSample(db, sampleId, input) {
  const sample = db.samples.find(item => item.id === sampleId);
  if (!sample) return { status: 404, body: { error: `样本 ${sampleId} 不存在` } };
  const newId = String(input.newId || "").trim();
  if (!newId) return { status: 400, body: { error: "缺少新样本编号" } };
  if (newId !== sample.id && db.samples.some(item => item.id === newId)) {
    return { status: 409, body: { error: `样本编号 ${newId} 已存在，冲突` } };
  }
  const oldId = sample.id;
  sample.id = newId;
  const at = now();
  const reason = `样本编号变更（${oldId} → ${newId}）`;
  const reworked = [];
  for (const slice of sample.slices) {
    reworked.push(...invalidateRework(db, order => order.sampleId === oldId && order.sliceId === slice.id, reason, { sampleId: newId, sliceId: slice.id, method: slice.method }));
  }
  for (const order of db.scanOrders.filter(item => item.sampleId === oldId && item.status === "出库中")) {
    order.sampleId = newId;
    order.logs.push({ at, step: "同步改号", note: `样本编号变更为 ${newId}，出库单同步更新` });
  }
  await saveDb(db);
  return { status: 200, body: { sample, reworked } };
}

// 列表、工位、履历取自同一份快照，刷新后三者一致
export function overview(db) {
  const history = db.scanOrders
    .flatMap(order => order.logs.map(log => ({ orderId: order.id, sliceId: order.sliceId, ...log })))
    .sort((a, b) => b.at.localeCompare(a.at));
  return { orders: db.scanOrders, workstations: db.workstations, history };
}
