# 03 — 写侧三件套接入矩阵

**What to build:** 矩阵扫描扩到写侧（W1），在试点资源上全绿：跨公司 create 被拒、update 他司记录被拒、destroy 他司记录被拒、无码 mutation 全拒。构造函数契约扩展为"可产出合法 create 参数"，供跨公司 create 场景复用。

**Blocked by:** 02 — 矩阵内核 tracer bullet.

**Status:** resolved

- [x] 四类负向断言（跨公司建/改他司/删他司/无码写）进矩阵 runner，对每个已覆盖资源自动展开
- [x] 至少一个试点资源保留写侧正向对照（有码者可在本司正常写），防"全部拒绝"的坏系统假绿
- [x] 构造函数契约扩展后，既有试点构造函数适配
- [x] 失败信息规格与读侧一致（资源 × 主体形态 × 方向）
- [x] 试点资源读写矩阵全绿，进 CI

## Comments

落地:`apps/synie_web/test/synie_web/authz_matrix_write_test.exs` + 支撑扩展。

- 四类负向(跨公司建/改他司/删他司/无码写,外加匿名写)对每个已覆盖资源自动展开;
  mutation 字段名经域 mutations 反射只认主动作(audit/cancel 等衍生 update 不入三件套),
  资源没注册某件 mutation 自动跳过。
- 构造函数契约扩展为 `World.write_inputs/0`(create: 公司→合法输入;update: 良性变更),
  两个试点已适配;覆盖守卫新增「注册了 create/update mutation 必须给出写输入」契约断言。
- 正向对照双份:min_write_a 在甲司 create→update→destroy 净零走通(防全拒假绿);
  min_write_ab(同码、甲乙双授权)在乙司同套走通——证明跨公司负向的拒因是公司轴
  而非输入不合法。
- 世界不变式:负向与正向各扫完后,super_admin 可见集必须恰好等于世界记录
  ——被拒不靠错误形态自证,靠数据没动过实证。
- 失败信息与读侧同规格(资源 × 主体形态 × 方向);已做变异验证(给 min_write_a
  偷加乙司授权 → 跨公司三件套点名报红)。
