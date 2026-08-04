# 09 — 扫荡：base / party / iam / platform 杂项

**What to build:** 按 08 手册迁移 base（币种/公司/单位/科目/行情）、party（客商/员工/地址）、iam（用户/角色，含授权 sync 自身的门控）、platform 余量（printing/numbering/settings/todo/audit/setup）。要点：printing 的客户端提供 prefix + mode/arity 派生动作（S9/D9/D10）改为目录解析后 guard；todo 注册表析取（D6）改 anyOf 声明；settings/market 的 null-actor 与「受信任读」（D11/D12）改 systemPermit；setup 的 superAdmin 路由（D13）改主体判定；audit 的 nullable 公司列走声明。global 资源（币种/单位/物料分类等）声明 `global` 后断言矩阵无行级范围。

**Blocked by:** 08

**Status:** ready-for-agent

- [ ] 各模块 routes 挂 guard、服务 Permit 化、本地包装删除
- [ ] printing/todo/settings/market/setup/audit 的特殊形态按上述归宿落地
- [ ] 相关集成测试全绿；封路豁免移除对应项

## Comments
