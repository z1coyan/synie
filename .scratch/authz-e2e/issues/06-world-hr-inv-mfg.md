# 06 — 夹具世界批次C：hr + inv + mfg

**What to build:** hr、inv、mfg 三域在权限目录内的全部资源进夹具世界（构造函数 + 应得集声明），从覆盖豁免清单移除，读写矩阵自动覆盖并全绿。注意 inv/mfg 的全局共享资源（物料分类、物料、工序等不分公司）按"有码即读、无公司轴"声明；hr 的员工证件照等附件槽位不必进世界（文件出口面归 08 票）。

**Blocked by:** 02 — 矩阵内核 tracer bullet；03 — 写侧三件套接入矩阵.

**Status:** resolved

- [x] 三域目录资源构造函数齐全，从豁免清单移除
- [x] 全局共享资源与公司隔离资源的应得集声明各归其位
- [x] 本批全部资源读写矩阵全绿，进 CI

## Comments

落地:16 资源(hr 7 + inv 6 + mfg 3)进世界,豁免清单批次C段清零,读/写矩阵
一次全绿(读 43/写 43/覆盖 3,累计 184 web 测试)。

- **应得集归位**:hr 全域(员工/打卡/考勤日/补卡/借款/工资单/发放行)与
  inv.material_category/material、mfg 全域都是全局主数据(:global 有码即读);
  inv 的 stock_doc/count/transfer/entry 按 :company 默认声明。批次B在 ctx
  预建的员工由 hr.employee 构造函数认领(工单05注记的跨批次认领落实)。
- **物料强制自动编号**:inv.material 的 code `manual_entry: false` 不收手填
  ——世界自带启用的 `inv.material` 编号规则(进 ctx、由 numbering_rule
  构造函数认领),GraphQL 正向 create 才能走通。
- **考勤重算互扰防护**:补卡(correction)增删改会触发当天考勤日重算,
  世界考勤日(07-01)/世界补卡日(07-03)/写输入补卡日(07-04)三个日期错开;
  hr.attendance_day 进共享清单(重算副产物),list 扫描 id 定界。
- **打卡的导入外键**:真实 AttendanceImport 创建要可解析的 .dat(越出矩阵射程),
  用 `Ash.Seed` 种最小 import 行(仅 file_id 必填,挂世界裸文件)。
- **发放行状态联动**:PayrollPayment 无通用 update(不可改只可删重录);
  正向 create 翻转世界工资单为已发放、destroy 翻回,净零;世界不变式按 id
  断言不受状态翻转影响。
- **BOM 每物料一份**:世界 BOM 挂主物料,写正向落在备用物料(material2,
  同由 material 构造函数认领)。
- **调拨三仓**:from/to/transit 两两不同,世界仓库扩为每司三座
  (warehouse 构造函数认领全部六座)。
- stock_entry 与 gl_entry 同款裁量:资源层无动作校验,直建最小合法行,
  voucher_type 无白名单校验(任意串);业务链路(审核过账)有各自功能测试。
