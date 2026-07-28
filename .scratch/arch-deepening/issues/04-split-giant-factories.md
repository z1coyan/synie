# 04 E · 拆巨型工厂隐藏聚合

Status: resolved

## 问题

- `trading/order/service.ts`（1948 行，30 方法 interface）：其中 12 个方法是
  纯采购委外配置（:906-1287，发料清单/副产物/需求池/BOM 展开，~380 行），
  与「订单」聚合弱关联、与 outsourced/ 天然同组；另有 4 个纯透传方法
  （:1320-1323，postFulfillment 等）只是装配迂回。
- `hr/service.ts`（2175 行，37 方法 interface）：一个闭包装 4 个领域概念
  7 个资源（考勤打卡/导入/日考勤+补卡 21 方法 + 工资单/发放/借款 16 方法）；
  routes 早已按 7 资源切分，service 没跟上；底部 210 行 mapper boilerplate；
  文件大到留下 `void DAY_MISSING; void toIso`（:2173）静默 hack。

## 方向

- order 拆出 `outsourced-config`（独立 service 工厂，或并入 outsourced/
  模块边界）；剔除 4 个透传方法，fulfillment/outsourced 直依赖 projection.ts
  （它们已持 trx），装配迂回消失；
- hr 按 routes 的天然切分拆 `attendance-service.ts` + `payroll-service.ts`
  两工厂，`rules.ts` 保持共享纯核，`createHrServices` 返回
  `{ attendance, payroll }`；mapper 按资源就近归位；顺手清 void hack。

## 验收

- order interface 30→18，hr 37→~20/个；
- 行为零变化（现有 PG 集成测试即安全网），226/226 绿；
- index.ts 装配同步更新，web 侧 hc 类型不受影响（routes 不动）。

## Comments

### 2026-07-28 主仓集成

- order：`2cfb9dd` 拆 outsourced-config + 投影透传；fulfillment/outsourced 保留 module index 引擎注入（不回退 file-level 单例）
- hr：`4a0dfd0` attendance/payroll 两工厂；保留 02 `employeeSeam` 与 06 `applyPayment`/`reversePayment` 纯核
- 验证：typecheck + 246 测全绿
