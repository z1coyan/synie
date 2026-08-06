let meta = #{
    name: "asset-management",
    description: "实现资产管理模块工单 01–09：主数据、物料类型、卡片、采购建卡、折旧、转移/维修/处置与文档收尾",
    phases: [
        #{ title: "基线", detail: "确认无半成品、规格与工单齐全" },
        #{ title: "01 主数据", detail: "资产分类/位置 + asset 模块骨架与菜单组" },
        #{ title: "02 物料类型", detail: "库存/虚拟/资产三分与单据拦截" },
        #{ title: "03 资产卡片", detail: "卡片主数据、台账、存量导入、流水" },
        #{ title: "04 采购建卡", detail: "入库审核自动生成草稿卡" },
        #{ title: "05 折旧", detail: "计划、计提单、重排/补提函数" },
        #{ title: "06 转移", detail: "转移/领用/归还" },
        #{ title: "07 维修", detail: "费用化与资本化改良" },
        #{ title: "08 处置", detail: "出售/报废与先补提" },
        #{ title: "09 收尾", detail: "文档晋升与全链验收" },
        #{ title: "验收", detail: "typecheck + 测试 + code-review 摘要" },
    ],
    when_to_use: "开始或继续落地 .scratch/asset-management 全模块时",
};

let work_schema = #{
    "type": "object",
    "required": ["complete", "summary", "commits", "remaining"],
    "properties": #{
        "complete": #{ "type": "boolean" },
        "summary": #{ "type": "string" },
        "commits": #{ "type": "array", "items": #{ "type": "string" } },
        "remaining": #{ "type": "array", "items": #{ "type": "string" } },
        "tests": #{ "type": "array", "items": #{ "type": "string" } },
    },
};

fn constraints() {
    let s = "";
    s += "工作区 /home/zyan/code/synie。中文第一语言（文档与用户可见文案）；标识符英文。";
    s += "必读：AGENTS.md、server/AGENTS.md、server/README.md、web 侧既有资源/菜单先例、";
    s += ".scratch/asset-management/spec.md、当前工单 md、docs/术语表.md 术语。";
    s += "实现方式：/implement — 优先在约定 seam 上 TDD；实现中定期 typecheck 与单测；";
    s += "工单完成后对该工单改动做 code-review 级自检并修明显问题；conventional commit（中文 subject），";
    s += "更新 issue Status: resolved（或 partial 并写 remaining）。禁止 push / reset --hard / 改 origin。";
    s += "技术栈：Bun + Hono + Kysely；工厂闭包；禁 class（ApiError 除外）；严格 TS；金额走 @synie/shared decimal；";
    s += "DbHandle/withTx；ApiError；Meta 注册；菜单 web/app/lib/menu.ts 与 server/src/platform/menu/catalog.ts 双侧同步。";
    s += "模块四件套先例：server/src/modules/inventory/；装配：register-all.ts、composition.ts、app.ts、resource-classification.ts。";
    s += "迁移 goose 格式 server/db/migrations/；写完后 bun run db:codegen（在 server 目录）。";
    s += "验证：cd server && bun run typecheck；相关 bun test；有库则 ";
    s += "SYNIE_TEST_DATABASE_URL=postgres://synie:synie@localhost:5441/synie_test?sslmode=disable；";
    s += "web 侧 bun run typecheck。禁止空路由/固定成功/skip 测试/any 占位。真实业务实现。";
    s
}

fn implement_issue(path, focus) {
    let p = constraints();
    p += " 实施工单 " + path + "。焦点：" + focus + "。";
    p += " 先完整阅读工单与 spec 对应章节，再对照仓库先例实现。";
    p += " 范围严格按工单；「不做」节禁止越界。依赖未完成时在 remaining 标明并 complete=false。";
    p += " 完成后：相关测试+typecheck 绿；git commit；issue Status: resolved；";
    p += " 按 schema 返回 complete/summary/commits/remaining/tests。";
    p
}

let mode = if args == () { "run" } else if args.mode == () { "run" } else { args.mode };

if mode == "smoke" {
    phase("基线");
    let s = agent(
        "用一句中文说明本 workflow 将顺序实现资产管理 01–09 工单。",
        #{ label: "smoke", capability_mode: "read-only" }
    );
    complete(#{ summary: "asset-management smoke ok", ok: s != () && s.success });
}

phase("基线");
let audit_p = constraints();
audit_p += " 只读基线：确认 .scratch/asset-management/spec.md 与 issues/01–09 存在；";
audit_p += " 确认 server/src/modules/asset 尚未存在或列出已有半成品；";
audit_p += " git status/log 简述。输出 complete=true 表示可开工，summary 写基线结论。";
let audit = agent(
    audit_p,
    #{ label: "audit-baseline", capability_mode: "read-only", output_schema: work_schema }
);
if audit == () || !audit.success {
    complete(#{ summary: "基线检查失败", complete: false });
}

phase("01 主数据");
let t01 = agent(
    implement_issue(
        ".scratch/asset-management/issues/01-asset-category-and-location-masters.md",
        "asset 模块骨架；ast_asset_category/_account/_location 迁移与 codegen；meta/routes/service；"
            + "菜单组「资产」与分类/位置列表页；分类科目子表呈现扩展；unit 测试"
    ),
    #{ label: "issue-01", capability_mode: "all", output_schema: work_schema }
);
if t01 == () || !t01.success || t01.output == () || t01.output.complete != true {
    complete(#{
        summary: "01 失败或未完成，停止后续工单",
        issue01: if t01 != () && t01.success { t01.output } else { () },
        complete: false,
    });
}

phase("02 物料类型");
let t02 = agent(
    implement_issue(
        ".scratch/asset-management/issues/02-material-type-extension.md",
        "inv_material 加 material_type 与 asset_category_id；保存锁死与校验；库存单据仅 stock；"
            + "销售发货拦 asset；采购 asset 行若 04 未就绪则硬错「资产建卡通道未就绪」；前端类型字段与选料器过滤"
    ),
    #{ label: "issue-02", capability_mode: "all", output_schema: work_schema }
);
if t02 == () || !t02.success || t02.output == () || t02.output.complete != true {
    complete(#{
        summary: "02 失败或未完成，停止后续工单",
        issue01: t01.output,
        issue02: if t02 != () && t02.success { t02.output } else { () },
        complete: false,
    });
}

phase("03 资产卡片");
let t03 = agent(
    implement_issue(
        ".scratch/asset-management/issues/03-asset-card.md",
        "ast_asset + ast_asset_activity；草稿/在用；存量导入校验；审核写流水；"
            + "台账列表+抽屉；编号规则 asset.asset；折旧计划 tab 占位留给 05"
    ),
    #{ label: "issue-03", capability_mode: "all", output_schema: work_schema }
);
if t03 == () || !t03.success || t03.output == () || t03.output.complete != true {
    complete(#{
        summary: "03 失败或未完成，停止后续工单",
        issue01: t01.output,
        issue02: t02.output,
        issue03: if t03 != () && t03.success { t03.output } else { () },
        complete: false,
    });
}

phase("04 采购建卡");
let t04 = agent(
    implement_issue(
        ".scratch/asset-management/issues/04-purchase-receipt-auto-create.md",
        "采购入库 asset 行不写库存、按数量生成草稿卡、原值均摊尾差；作废级联/拦截；"
            + "解除 02 临时硬错；前端审核提示"
    ),
    #{ label: "issue-04", capability_mode: "all", output_schema: work_schema }
);

phase("05 折旧");
let t05 = agent(
    implement_issue(
        ".scratch/asset-management/issues/05-depreciation-schedule-and-run.md",
        "折旧计划子表+计提单；卡片审核生成计划；重排与补提可复用函数；"
            + "GL 过账 shapes；前端计提页与计划 tab；编号规则 asset.depreciation"
    ),
    #{ label: "issue-05", capability_mode: "all", output_schema: work_schema }
);

// 04/05 顺序执行后若失败不硬停 06（06 仅依赖 03），但 07/08 依赖 05
phase("06 转移");
let t06 = agent(
    implement_issue(
        ".scratch/asset-management/issues/06-asset-movement.md",
        "转移/领用/归还；源值审核复核；回写位置保管人与流水；无会计影响；前端 movements 页"
    ),
    #{ label: "issue-06", capability_mode: "all", output_schema: work_schema }
);

let dep05_ok = t05 != () && t05.success && t05.output != () && t05.output.complete == true;

phase("07 维修");
let t07 = if dep05_ok {
    agent(
        implement_issue(
            ".scratch/asset-management/issues/07-asset-repair.md",
            "维修单费用化/资本化；维修中旁路标记；资本化调 05 重排；GL shapes；前端 repairs 页"
        ),
        #{ label: "issue-07", capability_mode: "all", output_schema: work_schema }
    )
} else {
    log("skip 07: 05 未完成");
    ()
};

phase("08 处置");
let t08 = if dep05_ok {
    agent(
        implement_issue(
            ".scratch/asset-management/issues/08-asset-disposal.md",
            "出售/报废；先补提再出清；终态卡片；GL shapes；前端 disposals 与行操作入口"
        ),
        #{ label: "issue-08", capability_mode: "all", output_schema: work_schema }
    )
} else {
    log("skip 08: 05 未完成");
    ()
};

let core_done = true;
if t04 == () || !t04.success || t04.output == () || t04.output.complete != true { core_done = false; }
if t05 == () || !t05.success || t05.output == () || t05.output.complete != true { core_done = false; }
if t06 == () || !t06.success || t06.output == () || t06.output.complete != true { core_done = false; }
if t07 == () || !t07.success || t07.output == () || t07.output.complete != true { core_done = false; }
if t08 == () || !t08.success || t08.output == () || t08.output.complete != true { core_done = false; }

phase("09 收尾");
let t09 = if core_done {
    agent(
        implement_issue(
            ".scratch/asset-management/issues/09-docs-and-acceptance.md",
            "docs/业务模块/资产管理.md 晋升；更新库存物料与 README 索引；CONTEXT 去未实现标注；"
                + "全链验收测试；spec 状态改为已实现"
        ),
        #{ label: "issue-09", capability_mode: "all", output_schema: work_schema }
    )
} else {
    log("skip 09: 04–08 未全部完成");
    ()
};

phase("验收");
let verify_p = constraints();
verify_p += " 汇总 01–09 完成度：读各 issue Status 行与 git log --oneline -30。";
verify_p += " 运行 cd server && bun run typecheck；有关 asset/material 测试；";
verify_p += " web 侧 typecheck 若改了前端。列出 open issue 与 remaining。";
verify_p += " complete=true 仅当 01–09 均为 resolved 且 typecheck 绿。";
let verify = agent(
    verify_p,
    #{ label: "verify", capability_mode: "execute", output_schema: work_schema }
);

let done = 0;
let parts = [t01, t02, t03, t04, t05, t06, t07, t08, t09];
for p in parts {
    if p != () && p.success && p.output != () && p.output.complete == true {
        done += 1;
    }
}

complete(#{
    summary: "asset-management finished " + done.to_string() + "/9 tickets complete path",
    done: done,
    issue01: if t01 != () && t01.success { t01.output } else { () },
    issue02: if t02 != () && t02.success { t02.output } else { () },
    issue03: if t03 != () && t03.success { t03.output } else { () },
    issue04: if t04 != () && t04.success { t04.output } else { () },
    issue05: if t05 != () && t05.success { t05.output } else { () },
    issue06: if t06 != () && t06.success { t06.output } else { () },
    issue07: if t07 != () && t07.success { t07.output } else { () },
    issue08: if t08 != () && t08.success { t08.output } else { () },
    issue09: if t09 != () && t09.success { t09.output } else { () },
    verify: if verify != () && verify.success { verify.output } else { () },
});
