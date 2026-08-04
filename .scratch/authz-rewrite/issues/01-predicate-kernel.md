# 01 — 谓词代数纯函数内核

**What to build:** `platform/authz/core`——零 IO、零表知识的判定内核：`Actor` v2 类型、`ScopeSet` 位集、`decide(actor, resource, action) → Decision`、`Permit` 凭证（含 `systemPermit()`）、`RowFilter` 抽象 AST（不含 SQL）。判定逻辑固定：superAdmin/system → allow(all)；grants 精确查（无通配）；命中 → company ∧ scopes 并集（格 `self ⊆ dept ⊆ deptTree ⊆ all`，granted 正交预留）。同步产出 decide fixtures（JSON 用例）替代 `contracts/fixtures/authz/permission_matches.json` 的对拍地位，前端后续消费同一份。

**Blocked by:** None — can start immediately.

**Status:** ready-for-human

- [x] Actor v2：kind/user/superAdmin/companies{all,ids}/deptId/deptSubtreeIds/grants Map
- [x] decide 纯函数 + Permit 只能经内核构造（系统主体走 systemPermit）
- [x] RowFilter AST：company（bypass/none/{ids,nullable}）× 范围原子数组；granted 原子类型预留但 decide 永不产出
- [x] 码级组合子 one/anyOf/allOf
- [x] 穷举单测：范围格并集、无部门用户空集、grants_all 展开语义、错误语义分类（码 miss=forbidden、行级 miss=not_found 的判定分类信息随 Decision 携带）
- [x] decide fixtures 落 `contracts/fixtures/authz/`，标注旧 permission_matches.json 待 15 号工单移除

## Comments

2026-08-05 实施：`platform/authz/core/{scope,actor,row-filter,decide}.ts`。
Permit 用未导出的 unique symbol brand，core 外结构化伪造在编译期不成立。
allOf 的范围折叠取**格上最小**（跨资源门控不放大行集），非位集交集——位与在格上不成立。
夹具 `contracts/fixtures/authz/decide_cases.json`（18 例），服务端由 core/fixtures.test.ts 消费，
前端在工单 14 接同一份；旧 permission_matches.json 已标 deprecated，工单 15 删除。
