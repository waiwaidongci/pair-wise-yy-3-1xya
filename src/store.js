import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = join(__dirname, "..", "data", "core-slices.json");

export const orderStatuses = ["出库中", "已归还", "待返工", "已失效"];
export const activeStatuses = ["出库中", "待返工"];

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
        { id: "SL-001-A", method: "茜素红染色", observation: "", status: "研磨", logs: [{ at: "2026-06-12T10:00:00.000Z", step: "取样", note: "截取含矿化条带位置" }, { at: "2026-06-13T11:20:00.000Z", step: "切割", note: "完成粗切" }] }
      ]
    }
  ],
  workstations: [
    { id: "WS-01", name: "扫描工位 1", status: "空闲", orderId: null },
    { id: "WS-02", name: "扫描工位 2", status: "空闲", orderId: null },
    { id: "WS-03", name: "扫描工位 3", status: "空闲", orderId: null }
  ],
  scanOrders: []
};

export async function loadDb() {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    await writeFile(dbPath, JSON.stringify(seed, null, 2));
  }
  const db = JSON.parse(await readFile(dbPath, "utf8"));
  db.samples ||= [];
  db.workstations ||= seed.workstations.map(ws => ({ ...ws }));
  db.scanOrders ||= [];
  return db;
}

export async function saveDb(db) {
  await writeFile(dbPath, JSON.stringify(db, null, 2));
}

export function findSlice(db, sliceId) {
  for (const sample of db.samples) {
    const slice = sample.slices.find(item => item.id === sliceId);
    if (slice) return { sample, slice };
  }
  return null;
}

// 每片仅一笔未归还扫描单：出库中或待返工都视为未归还
export function activeOrderOf(db, sliceId) {
  return db.scanOrders.find(order => order.sliceId === sliceId && activeStatuses.includes(order.status)) || null;
}
