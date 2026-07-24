# 04 — 夹具世界批次A：sys + base

**What to build:** sys 与 base 两域在权限目录内的全部资源进夹具世界（构造函数 + 应得集声明），从覆盖豁免清单移除，读写矩阵自动覆盖并全绿。本批含最多应得集特例：全局共享资源（公司/币种/单位等）按"有码即读、无公司轴"声明；审计日志按"无公司行放行 + 公司匹配"声明；文件资源按"裸文件仅上传者本人与超管、附件随宿主"声明。

**Blocked by:** 02 — 矩阵内核 tracer bullet；03 — 写侧三件套接入矩阵.

**Status:** resolved

- [x] 两域目录资源构造函数齐全（尽量搬既有 domain fixtures），从豁免清单移除
- [x] 全局资源、审计日志、文件三类特例以显式应得集声明表达，不硬编码进断言循环
- [x] 内置角色等迁移种子数据与世界建数不冲突（世界建数须与既有种子共存）
- [x] 本批全部资源读写矩阵全绿，进 CI

## Comments

落地:15 个资源全部进世界(sys 9 + base 6),豁免清单批次A段清零,读/写/覆盖矩阵全绿。

- **内核缺陷修复(顺手,属工单03遗留)**:三件套 mutation 反射原用
  `Ash.Resource.Info.primary_action/2`,而资源的通用 create/update 大多没标
  `primary? true`——写矩阵此前对试点静默只扫 destroy。改为「mutation 的动作名
  与类型同名即三件套」(audit/cancel 等衍生动作名不同,天然排除),批次A起
  create/update 写面真实展开。
- **世界改两段构建**:`build!` 先建标准数据 ctx(公司甲乙、世界币种/单位、默认
  存储、世界文件、行情品种,显式依赖顺序),再跑构造函数注册表(无序 map,
  构造函数间不得互相依赖,被引用记录一律进 ctx 由属主构造函数认领)。
  `write_inputs/0` 升格为 `write_inputs/1` 收 ctx(闭包内引用,守卫以占位空 map 查键)。
- **共享资源声明**(`World.shared/0`):sys.user/role/role_permission(合成主体
  自身就是这些表的行)、sys.audit_log(世界建数的审计副产物)、base.currency/unit/
  market_instrument(迁移种子)存在世界外行——其 list 扫描与写侧世界不变式降为
  id 定界查询(`filter: {id: {in: 世界}}`),断言口径不变(恰好等于+count),
  聚合跨公司泄露仍会被抓;独占资源维持全库无定界扫描(更强:顺带证明世界外无可见行)。
- **读出口三形态**(`Gql.read_endpoint!/1`):GridMeta list / 白名单豁免资源回落
  域 queries 反射——分页 list(sysRolePermissions)或 read_one 单行(sysSetting;
  有码即见单行、无码/匿名拒)。
- **应得集特例**:审计日志首个 `{:custom, fun}` 声明落地(无公司行放行+公司匹配,
  世界建甲/乙/无公司三行覆盖三种取值),`expected_ids/3` custom 分支启用。
  文件资源 GraphQL 元数据面=有码即读(:global);「裸文件仅上传者、附件随宿主」
  是 REST 下载出口语义,场景归工单08(世界已备好裸文件+上传者+真实存储字节)。
- **正向对照扩形态**:仅注册 update 的资源(sys.user/sys.setting)对世界记录做
  良性 update 作正向;仅注册 create 的(base.market_price)正向后经受信路径清场。
  记档缺口:sys.file 仅注册 destroy 且无 create 可对照,destroy 正向暂缺
  (全拒假绿风险有界,文件出口正反向归 08)。
- **种子共存**:sys_setting 单行、内置 admin 角色+`*` 授权、CNY/单位/预置品种
  均为迁移种子——setting 构造函数认领种子行,其余经共享声明隔离;世界公司代码
  (ja/yi)与写输入公司码(w?/x?)、币种(W??)错开命名空间防撞。
- 输入姿势坑:编号段 json_string **数组**输入是「JSON 串的数组」(不对称契约);
  公司代码限两位字母、币种 ISO 三位大写;枚举输入用 `{:enum, "DEBIT"}` 裸字面量。
