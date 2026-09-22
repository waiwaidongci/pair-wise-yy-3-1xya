import { activeOrderOf, findSlice } from "./store.js";

export const MIN_RESOLUTION = 2000;
export const CHECKSUM_PATTERN = /^[a-f0-9]{8,64}$/i;

// 出库判定：核对编号、染色方法、载玻片、工位；缺项或冲突即整单拒绝
export function judgeCheckout(db, input) {
  const sliceId = String(input.sliceId || "").trim();
  const method = String(input.method || "").trim();
  const slideNo = String(input.slideNo || "").trim();
  const workstationId = String(input.workstationId || "").trim();

  const errors = [];
  if (!sliceId) errors.push("缺少切片编号");
  if (!method) errors.push("缺少染色方法");
  if (!slideNo) errors.push("缺少载玻片编号");
  if (!workstationId) errors.push("缺少扫描工位");
  if (errors.length) return { ok: false, errors };

  const found = findSlice(db, sliceId);
  if (!found) errors.push(`切片 ${sliceId} 不存在`);
  else if (found.slice.method !== method) errors.push(`染色方法冲突：登记为「${found.slice.method}」，出库单填写「${method}」`);

  const workstation = db.workstations.find(ws => ws.id === workstationId);
  if (!workstation) errors.push(`工位 ${workstationId} 不存在`);
  else if (workstation.status !== "空闲") errors.push(`工位 ${workstation.name} 占用中（扫描单 ${workstation.orderId}）`);

  const active = activeOrderOf(db, sliceId);
  if (active) errors.push(`切片 ${sliceId} 已有未归还扫描单 ${active.id}，每片仅允许一笔`);

  const slideBusy = db.scanOrders.find(order => order.slideNo === slideNo && ["出库中", "待返工"].includes(order.status));
  if (slideBusy) errors.push(`载玻片 ${slideNo} 已随扫描单 ${slideBusy.id} 出库未归还`);

  if (errors.length) return { ok: false, errors };
  return { ok: true, sample: found.sample, slice: found.slice, workstation };
}

// 归还判定：登记分辨率、图像校验码、操作人；任一不达标或有裂纹只进待返工
export function judgeReturn(input) {
  const errors = [];
  const resolution = Number(input.resolution);
  if (input.resolution === undefined || input.resolution === null || input.resolution === "" || !Number.isFinite(resolution)) {
    errors.push("缺少有效的分辨率");
  } else if (resolution < MIN_RESOLUTION) {
    errors.push(`分辨率 ${resolution} 低于标准 ${MIN_RESOLUTION}`);
  }
  const checksum = String(input.checksum || "").trim();
  if (!CHECKSUM_PATTERN.test(checksum)) errors.push("图像校验码缺失或格式不符（8-64 位十六进制）");
  const operator = String(input.operator || "").trim();
  if (!operator) errors.push("缺少操作人");
  const cracks = input.cracks === true || input.cracks === "true" || input.cracks === "有";
  if (cracks) errors.push("切片存在裂纹");
  return { ok: errors.length === 0, errors, resolution: Number.isFinite(resolution) ? resolution : null, checksum, operator, cracks };
}
