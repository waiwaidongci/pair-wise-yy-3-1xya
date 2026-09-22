# 岩芯样本切片实验室 · 显微扫描出库与归还核销台

运行：

```bash
npm start
```

访问`http://localhost:3025`。支持样本创建、切片任务、步骤记录、交付统计，以及显微扫描的出库、归还核销与待返工管理。

## 业务模块

- **入口**（`src/intake.js`）：出库登记、归还核销、改号/改染色三类业务操作，组合判定与存储，返回统一结果。
- **判定**（`src/judge.js`）：纯规则校验。出库核对切片编号、染色方法、载玻片、工位，缺项或冲突整单拒绝；归还校验分辨率（≥2000 dpi）、图像校验码（8-64 位十六进制）、操作人与裂纹。
- **存储**（`src/store.js`）：JSON 落库与查询，含工位与扫描单状态。

## 规则

- 每片仅一笔未归还扫描单（出库中/待返工均算未归还）。
- 出库缺项或冲突（编号不存在、染色方法不符、载玻片未归还、工位占用）→ 整单拒绝，不落库。
- 归还登记分辨率、图像校验码、操作人；任一不达标或有裂纹 → 只进待返工，不释放工位；全部合格 → 已归还并释放工位。
- 改样本编号或切片编号/染色方法 → 相关待返工单失效重排（新单继承载玻片与工位），旧记录保留为已失效。
- 列表、工位、履历由 `GET /api/scan/overview` 同一快照渲染，刷新后一致。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/scan/overview` | 扫描单列表 + 工位看板 + 履历快照 |
| POST | `/api/scan/checkout` | 出库登记 `{sliceId, method, slideNo, workstationId}` |
| POST | `/api/scan/orders/:id/return` | 归还登记 `{resolution, checksum, operator, cracks}` |
| POST | `/api/samples/:id/relabel` | 改样本编号 `{newId}` |
| POST | `/api/samples/:id/slices/:sliceId/relabel` | 改切片编号/染色方法 `{newId, newMethod}` |
