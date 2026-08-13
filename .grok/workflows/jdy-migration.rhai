let meta = #{
    name: "jdy-migration",
    description: "简道云业务数据迁移端到端：抽取→规则清洗→AI语义清洗→载荷→分阶段导入→验收，全程无人值守",
    phases: [
        #{ title: "Bootstrap", detail: "决策写入、目录与鉴权" },
        #{ title: "Extract", detail: "未迁表游标抽取 + 附件" },
        #{ title: "RuleClean", detail: "确定性规则清洗脚本" },
        #{ title: "AiClean", detail: "dsv4flash 语义映射分片" },
        #{ title: "Payloads", detail: "载荷生成与线上只读预检" },
        #{ title: "Stage0", detail: "配置导入" },
        #{ title: "Stage1", detail: "银行流水导入" },
        #{ title: "Stage2", detail: "期初凭证" },
        #{ title: "Stage3", detail: "销售在途链" },
        #{ title: "Stage4", detail: "采购委外链" },
        #{ title: "Stage5", detail: "票据接收" },
        #{ title: "Stage6", detail: "库存收付款收尾" },
        #{ title: "Verify", detail: "V1~V6 验收与总报告" },
    ],
    when_to_use: "按 docs/部署/简道云业务数据迁移方案.md 无人值守执行业务数据迁移时",
};

// ── schemas ──────────────────────────────────────────────────────────
let extract_schema = #{
    "type": "object",
    "required": ["form", "count", "path"],
    "properties": #{
        "form": #{ "type": "string" },
        "count": #{ "type": "integer" },
        "min_date": #{ "type": "string" },
        "max_date": #{ "type": "string" },
        "path": #{ "type": "string" },
        "error": #{ "type": "string" },
    },
};

let clean_schema = #{
    "type": "object",
    "required": ["input", "output", "dropped", "anomalies"],
    "properties": #{
        "input": #{ "type": "string" },
        "output": #{ "type": "string" },
        "dropped": #{ "type": "array", "items": #{ "type": "object" } },
        "anomalies": #{ "type": "array", "items": #{ "type": "object" } },
        "summary": #{ "type": "string" },
    },
};

let ai_shard_schema = #{
    "type": "object",
    "required": ["items"],
    "properties": #{
        "items": #{
            "type": "array",
            "items": #{
                "type": "object",
                "required": ["input", "mapped_to", "confidence", "reason"],
                "properties": #{
                    "input": #{ "type": "string" },
                    "mapped_to": #{ "type": "string" },
                    "confidence": #{ "type": "number" },
                    "reason": #{ "type": "string" },
                },
            },
        },
        "shard_path": #{ "type": "string" },
        "kind": #{ "type": "string" },
    },
};

let prepare_ai_schema = #{
    "type": "object",
    "required": ["shards", "master_codes_path"],
    "properties": #{
        "shards": #{
            "type": "array",
            "items": #{
                "type": "object",
                "required": ["path", "kind", "index", "count"],
                "properties": #{
                    "path": #{ "type": "string" },
                    "kind": #{ "type": "string" },
                    "index": #{ "type": "integer" },
                    "count": #{ "type": "integer" },
                },
            },
        },
        "master_codes_path": #{ "type": "string" },
        "summary": #{ "type": "string" },
    },
};

let stage_schema = #{
    "type": "object",
    "required": ["imported", "failed", "state_path"],
    "properties": #{
        "imported": #{ "type": "integer" },
        "failed": #{ "type": "array", "items": #{ "type": "object" } },
        "state_path": #{ "type": "string" },
        "skipped": #{ "type": "integer" },
        "pilot_ok": #{ "type": "boolean" },
        "fail_rate": #{ "type": "number" },
        "summary": #{ "type": "string" },
        "halt": #{ "type": "boolean" },
        "halt_reason": #{ "type": "string" },
    },
};

let precheck_schema = #{
    "type": "object",
    "required": ["modules", "gaps"],
    "properties": #{
        "modules": #{
            "type": "array",
            "items": #{
                "type": "object",
                "required": ["module", "should_migrate", "archive"],
                "properties": #{
                    "module": #{ "type": "string" },
                    "should_migrate": #{ "type": "integer" },
                    "archive": #{ "type": "integer" },
                },
            },
        },
        "gaps": #{ "type": "array", "items": #{ "type": "object" } },
        "gaps_fixed": #{ "type": "array", "items": #{ "type": "object" } },
        "gaps_unfixed": #{ "type": "array", "items": #{ "type": "object" } },
        "payloads_dir": #{ "type": "string" },
        "summary": #{ "type": "string" },
    },
};

let verify_schema = #{
    "type": "object",
    "required": ["v1", "v2", "v3", "v4", "v5", "v6", "report_path"],
    "properties": #{
        "v1": #{ "type": "object" },
        "v2": #{ "type": "object" },
        "v3": #{ "type": "object" },
        "v4": #{ "type": "object" },
        "v5": #{ "type": "object" },
        "v6": #{ "type": "object" },
        "report_path": #{ "type": "string" },
        "summary": #{ "type": "string" },
        "open_issues": #{ "type": "array", "items": #{ "type": "string" } },
    },
};

let bootstrap_schema = #{
    "type": "object",
    "required": ["ok", "cutoff", "root", "auth_ok"],
    "properties": #{
        "ok": #{ "type": "boolean" },
        "cutoff": #{ "type": "string" },
        "root": #{ "type": "string" },
        "auth_ok": #{ "type": "boolean" },
        "synie_base": #{ "type": "string" },
        "auth_path": #{ "type": "string" },
        "decisions_path": #{ "type": "string" },
        "summary": #{ "type": "string" },
    },
};

// ── helpers ──────────────────────────────────────────────────────────
fn iron_rules() {
    let s = "";
    s += "\n## 铁律（必须遵守）\n";
    s += "1. AI 不碰金额、不补造单据；宁可留档不导入，不可编造；留档桶逐条带理由。\n";
    s += "2. 有过账后果的单据只走 API，不 SQL 直插；先 1~3 单试导入再放量，熔断条件触发即停。\n";
    s += "3. 产物全落 .scratch/jdy-migration/；排序用业务日期字段，createTime 不可信。\n";
    s += "4. 不向用户提问、不暂停等人；拿不准的记入报告「遗留问题」节并跳过对应批次，继续后续不受影响的部分。\n";
    s += "5. 匹配键一律是 code（编号）；历史单号写单据备注，单号由系统生成。\n";
    s += "6. 三轨策略：A 在途链迁移 / B 期初凭证找平 / C 归档留档——已结清历史不进业务表。\n";
    s
}

fn docs_must_read() {
    let s = "";
    s += "必读（按序）：docs/部署/简道云业务数据迁移方案.md（唯一依据）、";
    s += "docs/部署/简道云数据迁移.md（MCP 坑/entry_id/5坑）、";
    s += "AGENTS.md、docs/术语表.md、.scratch/jdy-migration/handoff.md、";
    s += "涉及模块 docs/业务模块/*.md。\n";
    s
}

fn workspace_root() {
    "/home/zyan/code/synie"
}

fn scratch_root() {
    "/home/zyan/code/synie/.scratch/jdy-migration"
}

fn app_id() {
    "677a3250b67b4fe95301db1d"
}

fn form_catalog() {
    // form | entry_id | label
    [
        #{ form: "bank_tx", entry_id: "67e8e055d8fbc78316e41b65", label: "银行流水" },
        #{ form: "other_pay", entry_id: "67fc61dd8e08e2f914bfe9ac", label: "其他收付款" },
        #{ form: "opening_ar", entry_id: "67fbcc1332c47ef82544d421", label: "期初欠款" },
        #{ form: "bills", entry_id: "67e80285ca90794fd84d6d54", label: "承兑汇票" },
        #{ form: "stock_bills", entry_id: "67e8aa510503ccf45eb0e043", label: "库存承兑" },
        #{ form: "bank_accounts", entry_id: "67e8e12ac4cdcdd506d59b76", label: "我方银行账号" },
        #{ form: "customer_addr", entry_id: "67ebe338af7bf41ffb327234", label: "客户地址" },
        #{ form: "so_header", entry_id: "67c146a067f14a2d744cf428", label: "销售订单" },
        #{ form: "so_items", entry_id: "680f0c5835e4b1fc0c4ba005", label: "销售订单条目" },
        #{ form: "ship_header", entry_id: "67c94f497d729399a8252001", label: "销售出库" },
        #{ form: "ship_items", entry_id: "680f0fadfd5591cc14ffd8e1", label: "销售出库条目" },
        #{ form: "sales_return", entry_id: "67cd2a37df5a1f485b2ea538", label: "销售退货" },
        #{ form: "recon_header", entry_id: "6811a8d61efe22ba3f6d743e", label: "销售对账" },
        #{ form: "recon_items", entry_id: "6811a99ac4d676f521915085", label: "销售对账条目" },
        #{ form: "invoices", entry_id: "67e94d6c71bfd2914de8e3e1", label: "增值税发票" },
        #{ form: "os_issue", entry_id: "68087ebdcae14e2ce55e6a26", label: "委外发料" },
        #{ form: "os_issue_items", entry_id: "68087ebf77b5429506eaa73a", label: "委外出库条目" },
        #{ form: "os_receipt", entry_id: "68087bcb5f738a0a1534bf2e", label: "委外入库" },
        #{ form: "os_receipt_items", entry_id: "68087ce390c2684ea778eb79", label: "委外入库条目" },
        #{ form: "po_header", entry_id: "67cd2cf6db4c9c4fe9438a64", label: "采购订单" },
        #{ form: "po_items", entry_id: "6806fb1c7704e03005dca255", label: "采购订单条目" },
        #{ form: "pr_header", entry_id: "67eb7b55cf476ca499067a59", label: "采购入库" },
        #{ form: "pr_items", entry_id: "68079936b5a07b85d54f1c88", label: "采购入库条目" },
        #{ form: "pq", entry_id: "67cd2c45299828afdc0a1d7c", label: "采购报价" },
    ]
}

fn extract_prompt(form, entry_id, label) {
    let root = scratch_root();
    let p = "";
    p += "你是简道云数据抽取执行代理。工作区 " + workspace_root() + "。\n";
    p += docs_must_read();
    p += "任务：用 jiandaoyun MCP 工具 `jiandaoyun__member_data_list`（或 member_managed_data_list）全量抽取表单。\n";
    p += "app_id=" + app_id() + "\n";
    p += "form=" + form + " entry_id=" + entry_id + " label=" + label + "\n";
    p += "输出文件（必须写）：" + root + "/raw/" + form + ".json\n";
    p += "游标文件：" + root + "/raw/" + form + ".cursor.json\n";
    p += "\n抽取规则（写死）：\n";
    p += "1. 游标分页 limit=100，参数 cursor_data_id=上一页最后一条 _id；首次不传。\n";
    p += "2. 空包/超时重试最多 3 次（间隔约 1s）；JSON 解析用 strict=False 宽松模式（若走 curl 直调 MCP）。\n";
    p += "3. 并发限制：全 run 全局 ≤3 次/秒；你这一路串行分页即可，页间 sleep ≈0.35s。\n";
    p += "4. 断点续跑：若输出文件已存在，读 cursor 文件或文件内最后 _id 续拉；合并去重按 _id。\n";
    p += "5. 优先用 MCP use_tool/search_tool 调 jiandaoyun；若 MCP 不稳可仿 /tmp/jdy_fetch_sq.py 用 curl SSE（令牌已在 MCP 配置，勿把 URL 写入仓库文档）。\n";
    p += "6. 落盘为 JSON 数组；统计 count、业务日期字段的 min_date/max_date（无业务日期则空字符串）。\n";
    p += "7. 不要抽取已迁主数据表（客户/供应商/物料/销售报价）。\n";
    p += iron_rules();
    p += "按 output_schema 返回 {form, count, min_date, max_date, path}；失败时 path 仍写预期路径、count=0、error 填原因。\n";
    p
}

fn attach_prompt() {
    let root = scratch_root();
    let p = "";
    p += "你是附件下载代理。工作区 " + workspace_root() + "。\n";
    p += "从已抽取的 raw 中收集发票原件、承兑正背面图片 URL，下载到 " + root + "/attach/。\n";
    p += "输入：扫描 " + root + "/raw/invoices.json、bills.json、stock_bills.json（若存在）。\n";
    p += "状态：写 " + root + "/attach/attach_state.json；按 URL 判重，已下过的跳过。\n";
    p += "文件名：{form}_{record_id}_{index}_{safe_name}。限流 ~2s/次。\n";
    p += "失败 URL 记入 " + root + "/attach/failed.json。\n";
    p += iron_rules();
    p += "返回 {form:\"attachments\", count:已下载数, min_date:\"\", max_date:\"\", path:\"" + root + "/attach/attach_state.json\"}。\n";
    p
}

fn ok_stage(r) {
    r != () && r.success && r.output != ()
}

fn stage_halted(r) {
    if !ok_stage(r) { return true; }
    if r.output.halt == true { return true; }
    if r.output.fail_rate != () && r.output.fail_rate > 0.05 { return true; }
    if r.output.pilot_ok == false { return true; }
    false
}

// ── args / mode ──────────────────────────────────────────────────────
// `args` is a host global; only read it at top level (not inside fns).
let cutoff = "2026-08-31";
if args != () && args.cutoff != () && type_of(args.cutoff) == "string" && args.cutoff != "" {
    cutoff = args.cutoff;
}
let synie_base = "https://erp.tzjingtai.com";
if args != () && args.synie_base != () && type_of(args.synie_base) == "string" && args.synie_base != "" {
    synie_base = args.synie_base;
}
let mode = "run";
if args != () && args.mode != () && type_of(args.mode) == "string" && args.mode != "" {
    mode = args.mode;
}

if mode == "smoke" {
    phase("Bootstrap");
    let s = agent(
        "用一句中文说明 jdy-migration workflow 将无人值守执行简道云业务数据迁移全阶段。不要改文件。",
        #{ label: "smoke", capability_mode: "read-only" }
    );
    complete(#{ summary: "jdy-migration smoke ok", ok: s != () && s.success, cutoff: cutoff });
}

// ════════════════════════════════════════════════════════════════════
// Phase Bootstrap
// ════════════════════════════════════════════════════════════════════
phase("Bootstrap");
log("cutoff=" + cutoff + " base=" + synie_base);

let boot_p = "";
boot_p += "你是迁移 bootstrap 代理。工作区 " + workspace_root() + "。\n";
boot_p += docs_must_read();
boot_p += "任务：准备运行环境，不要向用户提问。\n";
boot_p += "1. mkdir -p " + scratch_root() + "/{raw,clean,ai,payloads,state,attach,scripts,reports,queues,logs}\n";
boot_p += "2. 写入决策执行记录 " + scratch_root() + "/decisions.json 与 " + scratch_root() + "/reports/decisions.md：\n";
boot_p += "   D1 cutoff=" + cutoff + "（args.cutoff，默认 2026-08-31）\n";
boot_p += "   D2 已票账两清不迁发票、只迁在途未票链\n";
boot_p += "   D4 导入期打开相关仓 allow_negative=true，库存盘点完成后关闭\n";
boot_p += "   D5 按在途单实际放宽超发/超收容差，迁完收回\n";
boot_p += "   D8 委外归一后缺档即补建供应商+外协仓\n";
boot_p += "   D9 承兑两表按业务键对账后取信息更全的一份，对账过程留档\n";
boot_p += "   （D3 库存期初实盘后手工出入库；D6/D7 沿用报价迁移决策）\n";
boot_p += "3. 鉴权：SYNIE_BASE=" + synie_base + "。优先顺序：\n";
boot_p += "   a) 若 args 带 token（检查环境变量 JDY_MIG_TOKEN 或文件 " + scratch_root() + "/auth.json 的 token 字段）\n";
boot_p += "   b) 环境变量 TOKEN / SYNIE_TOKEN\n";
boot_p += "   c) " + scratch_root() + "/auth.json 含 username+password 则 POST " + synie_base + "/api/v1/auth/login 取 token\n";
boot_p += "   d) 环境变量 SYNIE_USER + SYNIE_PASS 登录\n";
boot_p += "   成功则写 " + scratch_root() + "/auth.env（export SYNIE_BASE=... TOKEN=...，chmod 600），auth_ok=true。\n";
boot_p += "   失败则 auth_ok=false，记遗留问题，后续导入阶段跳过写操作但抽取/清洗继续。\n";
boot_p += "4. 复制 forms_catalog 确认存在 " + scratch_root() + "/forms_catalog.json。\n";
boot_p += "5. 写入 " + scratch_root() + "/run_meta.json：cutoff、synie_base、started 说明。\n";
boot_p += iron_rules();
boot_p += "返回 {ok, cutoff, root, auth_ok, synie_base, auth_path, decisions_path, summary}。\n";

// If token passed via args, pre-seed auth.json for bootstrap agent
if args != () && args.token != () && type_of(args.token) == "string" && args.token != "" {
    let seed = agent(
        "Write file " + scratch_root() + "/auth.json with content exactly: " +
            "{\"token\":" + json_encode(args.token) + ",\"synie_base\":" + json_encode(synie_base) + "} " +
            "using shell or write tool. chmod 600. Return ok=true if written. Also ensure dirs exist under " + scratch_root() + ".",
        #{ label: "seed-auth", capability_mode: "execute", output_schema: #{
            "type": "object", "required": ["ok"],
            "properties": #{ "ok": #{ "type": "boolean" } },
        }}
    );
    log("seed-auth done");
}

let boot = agent(boot_p, #{
    label: "bootstrap",
    capability_mode: "all",
    output_schema: bootstrap_schema,
});
if !ok_stage(boot) {
    complete(#{ summary: "bootstrap 失败", complete: false, phase: "Bootstrap" });
}
let auth_ok = boot.output.auth_ok == true;
log("bootstrap ok auth_ok=" + auth_ok.to_string() + " cutoff=" + cutoff);

// ════════════════════════════════════════════════════════════════════
// Phase Extract — panels of ≤3
// ════════════════════════════════════════════════════════════════════
phase("Extract");
let forms = form_catalog();
let extract_results = [];
let i = 0;
while i < forms.len() {
    let jobs = [];
    let j = 0;
    while j < 3 && (i + j) < forms.len() {
        let f = forms[i + j];
        jobs.push(#{
            prompt: extract_prompt(f.form, f.entry_id, f.label),
            label: "extract:" + f.form,
            capability_mode: "all",
            output_schema: extract_schema,
        });
        j += 1;
    }
    log("extract panel forms[" + i.to_string() + ".." + (i + jobs.len()).to_string() + ")");
    let panel = parallel(jobs);
    for r in panel {
        if r != () && r.success && r.output != () {
            extract_results.push(r.output);
            let cnt = 0;
            if r.output.count != () { cnt = r.output.count; }
            log("extracted " + r.output.form + " count=" + cnt.to_string());
        } else {
            log("extract slot failed or empty");
        }
    }
    i += 3;
}

// attachments after invoices/bills raw may exist
let attach_r = agent(attach_prompt(), #{
    label: "extract:attachments",
    capability_mode: "all",
    output_schema: extract_schema,
});
if ok_stage(attach_r) {
    extract_results.push(attach_r.output);
    log("attachments done");
}

// ════════════════════════════════════════════════════════════════════
// Phase RuleClean
// ════════════════════════════════════════════════════════════════════
phase("RuleClean");
let rule_p = "";
rule_p += "你是规则清洗执行代理（execute）。工作区 " + workspace_root() + "。\n";
rule_p += docs_must_read();
rule_p += "先写脚本到 " + scratch_root() + "/scripts/ 再运行（Python 或 bun）。cutoff=" + cutoff + "。\n";
rule_p += "输入目录：" + scratch_root() + "/raw/；输出目录：" + scratch_root() + "/clean/。\n";
rule_p += "必须完成的清洗步骤（每步输出 sidecar JSON：{input,output,dropped[],anomalies[]}，dropped 逐条带理由）：\n";
rule_p += "A. 银行流水去重：业务键=日期+账号+金额+对方户名，保留首条；输出 bank_tx_dedup.json + bank_tx_dedup.report.json。\n";
rule_p += "B. 承兑票号规范化（去空格）+ 两表对账（bills vs stock_bills）：按票号/金额/到期日业务键匹配；\n";
rule_p += "   D9：取信息更全的一份（字段更全优先 stock_bills 在库态），对账过程落 clean/bills_reconcile_audit.json；\n";
rule_p += "   异常日期（如 2500-01-01）单列 anomalies；输出 bills_canonical.json。\n";
rule_p += "C. 期初欠款：剔测试（名称/编号含 9999 或测试）与 0 值行；负数行单列 anomalies 不自动定性；输出 opening_ar_clean.json。\n";
rule_p += "D. 单位/币种/税率/日期归一（各业务表通用）：日期 ISO；币种 CNY/USD/THB；税率 0.13 等小数。\n";
rule_p += "E. 物料 code 规则直配：条目物料字段若已是主档 code（对照 " + scratch_root() + "/material_code_map.txt 或 jdy_materials）则直配；\n";
rule_p += "   客户方编码对照 material 的 customer_part_no；未匹配的进 queues/material_unmapped.json 供 AI。\n";
rule_p += "F. 客户地址去重：按客户编号+地址文本去重；输出 customer_addr_clean.json。\n";
rule_p += "G. 其他收付款归一整理 other_pay_clean.json。\n";
rule_p += "H. 写总清洗报告 " + scratch_root() + "/reports/rule_clean.md。\n";
rule_p += iron_rules();
rule_p += "返回 schema：input=raw 目录, output=clean 目录摘要路径, dropped/anomalies 数组可截断前 50 条但文件要全量, summary 写各步计数。\n";

let rule_r = agent(rule_p, #{
    label: "rule-clean",
    capability_mode: "execute",
    output_schema: clean_schema,
});
if !ok_stage(rule_r) {
    log("rule-clean failed; continue with partial raw if any");
} else {
    log("rule-clean: " + (if rule_r.output.summary != () { rule_r.output.summary } else { "ok" }));
}

// ════════════════════════════════════════════════════════════════════
// Phase AiClean — prepare shards then fan-out deepseek-v4-flash
// ════════════════════════════════════════════════════════════════════
phase("AiClean");
let prep_p = "";
prep_p += "你是 AI 清洗任务切分代理。工作区 " + workspace_root() + "。\n";
prep_p += "读取 clean/ 与 raw/ 与主档：\n";
prep_p += "- 供应商：" + scratch_root() + "/supplier_code_map.json 与 suppliers.json\n";
prep_p += "- 物料 code 集合：" + scratch_root() + "/material_code_map.txt（或 jdy_materials 抽 code）\n";
prep_p += "- 客户：" + scratch_root() + "/customer_code_map.txt\n";
prep_p += "生成主档 code 集合文件 " + scratch_root() + "/ai/master_codes.json：{suppliers:[code...], materials:[code...], customers:[code...]}。\n";
prep_p += "切分三类 AI 任务，每 shard ≤100 条，写入 " + scratch_root() + "/ai/shards/：\n";
prep_p += "① kind=os_supplier：委外发料/入库供应商名称去重列表 → 归一主档 code 或标 SUGGEST_CREATE\n";
prep_p += "② kind=material_spec：发票/出库条目未直配规格自由文本 → 物料 code\n";
prep_p += "③ kind=bank_counterparty：流水对方户名去重 → 对手归类(customer/supplier/other/internal)+收支性质(receipt/payment/transfer/fee/unknown)\n";
prep_p += "每个 shard 文件 JSON 数组，元素含 id/text/context 字段。\n";
prep_p += "返回 shards 数组（path,kind,index,count）与 master_codes_path。若某类为空则不生成 shard。\n";
prep_p += iron_rules();

let prep_ai = agent(prep_p, #{
    label: "ai-prepare",
    capability_mode: "execute",
    output_schema: prepare_ai_schema,
});

let ai_tokens = 0;
let ai_accepted = 0;
let ai_queued = 0;
let shards = [];
if ok_stage(prep_ai) && prep_ai.output.shards != () {
    shards = prep_ai.output.shards;
}
log("ai shards=" + shards.len().to_string());

// process shards in waves of ≤16
let master_path = scratch_root() + "/ai/master_codes.json";
if ok_stage(prep_ai) && prep_ai.output.master_codes_path != () {
    master_path = prep_ai.output.master_codes_path;
}

let si = 0;
while si < shards.len() {
    let jobs = [];
    let j = 0;
    while j < 16 && (si + j) < shards.len() {
        let sh = shards[si + j];
        let sp = "";
        sp += "你是语义映射 AI（模型 deepseek-v4-flash）。只做映射，不碰金额、不造单据。\n";
        sp += "工作区 " + workspace_root() + "。\n";
        sp += "输入 shard 文件：" + sh.path + "（kind=" + sh.kind + " index=" + sh.index.to_string() + "）\n";
        sp += "主档 code 集合：" + master_path + " —— 映射结果 mapped_to 必须是集合内 code，或特殊值 SUGGEST_CREATE:<name>（仅 os_supplier）、UNMAPPED。\n";
        sp += "任务说明：\n";
        sp += "- os_supplier：将委外供应商脏名归一到供应商 code；缺档用 SUGGEST_CREATE:规范名\n";
        sp += "- material_spec：规格/物料自由文本 → 物料 code；无把握 UNMAPPED\n";
        sp += "- bank_counterparty：对方户名 → mapped_to 形如 customer:<code>|supplier:<code>|other:<label>|internal:<label>，reason 含收支性质\n";
        sp += "每条输出 confidence 0~1；只对有把握的给 ≥0.8。\n";
        sp += "结果写入 " + scratch_root() + "/ai/results/" + sh.kind + "_" + sh.index.to_string() + ".json\n";
        sp += "同时按 schema 返回 items。\n";
        sp += iron_rules();
        jobs.push(#{
            prompt: sp,
            label: "ai:" + sh.kind + ":" + sh.index.to_string(),
            capability_mode: "execute",
            model: "deepseek-v4-flash",
            output_schema: ai_shard_schema,
        });
        j += 1;
    }
    log("ai wave offset=" + si.to_string() + " n=" + jobs.len().to_string());
    let panel = parallel(jobs);
    let pi = 0;
    for r in panel {
        if r != () {
            if r.tokens_used != () { ai_tokens += r.tokens_used; }
            if r.success && r.output != () && r.output.items != () {
                // Rhai-side filter: low confidence / invalid → human queue counts
                for it in r.output.items {
                    let conf = 0.0;
                    if it.confidence != () { conf = it.confidence; }
                    let mapped = "";
                    if it.mapped_to != () { mapped = it.mapped_to; }
                    if conf < 0.8 || mapped == "" || mapped == "UNMAPPED" {
                        ai_queued += 1;
                    } else {
                        ai_accepted += 1;
                    }
                }
            }
        }
        pi += 1;
    }
    si += 16;
}
log("ai tokens_used_total≈" + ai_tokens.to_string() + " accepted=" + ai_accepted.to_string() + " queued=" + ai_queued.to_string());

// merge AI results + write human queue
let merge_p = "";
merge_p += "你是 AI 结果合并代理。工作区 " + workspace_root() + "。\n";
merge_p += "读取 " + scratch_root() + "/ai/results/*.json 与 " + master_path + "。\n";
merge_p += "过滤规则：confidence<0.8 或 mapped_to 不在主档 code 集合（SUGGEST_CREATE 例外进补建清单）→ 人工队列。\n";
merge_p += "写出：\n";
merge_p += "- " + scratch_root() + "/ai/accepted.json（放行映射）\n";
merge_p += "- " + scratch_root() + "/queues/human_queue.json（人工队列，逐条理由）\n";
merge_p += "- " + scratch_root() + "/queues/suggest_create_suppliers.json（SUGGEST_CREATE 列表）\n";
merge_p += "- " + scratch_root() + "/reports/ai_clean.md（含 tokens 提示 " + ai_tokens.to_string() + "）\n";
merge_p += iron_rules();
merge_p += "返回 {input:\"ai/results\", output:\"ai/accepted.json\", dropped:[], anomalies:[], summary}。\n";
let merge_r = agent(merge_p, #{
    label: "ai-merge",
    capability_mode: "execute",
    output_schema: clean_schema,
});
if ok_stage(merge_r) {
    log("ai-merge: " + (if merge_r.output.summary != () { merge_r.output.summary } else { "ok" }));
}

// ════════════════════════════════════════════════════════════════════
// Phase Payloads + precheck
// ════════════════════════════════════════════════════════════════════
phase("Payloads");
let pay_p = "";
pay_p += "你是载荷生成与线上只读预检代理。工作区 " + workspace_root() + "。\n";
pay_p += docs_must_read();
pay_p += "cutoff=" + cutoff + "；过账日期口径：期初凭证=cutoff 前一日；发货/入库=历史业务日期；发票 audit 带 postingDate；票据接收=原收票日。\n";
pay_p += "决策 D2：已票账两清不迁发票，只迁在途未票链。\n";
pay_p += "输入：clean/*、ai/accepted.json、主档 map、attach。\n";
pay_p += "输出目录：" + scratch_root() + "/payloads/ 按模块分文件（pq, bank_accounts, addresses, bank_tx, opening_journal, so, ship, sales_return, recon, invoice, po, pr, os, bills, stock_opening, ar_ap_vouchers）。\n";
pay_p += "每个模块同时写 archive 桶 payloads/<mod>_archive.json（留档理由）。\n";
pay_p += "鉴权：source " + scratch_root() + "/auth.env（若存在）。SYNIE_BASE=" + synie_base + "。\n";
pay_p += "线上只读 GET 预检：code 存在性、科目角色七角色、仓叶子态、外协仓绑定、默认过账科目四槽。\n";
pay_p += "缺口：能自补的（补建供应商/外协仓/科目配置）写入 gaps_fixed 并生成补建 payloads；补不了的 gaps_unfixed，对应批次标记 skip。\n";
pay_p += "输出 modules[] 每模块 should_migrate/archive 两数；payloads_dir；summary。\n";
pay_p += iron_rules();

let pre = agent(pay_p, #{
    label: "payloads-precheck",
    capability_mode: "all",
    output_schema: precheck_schema,
});
if !ok_stage(pre) {
    log("payloads-precheck failed; import stages may no-op");
} else {
    log("precheck: " + (if pre.output.summary != () { pre.output.summary } else { "ok" }));
}

// shared import agent prompt builder (pass cutoff/base — Rhai fns do not capture outer lets)
fn import_prompt(stage_name, stage_detail, state_file, cutoff_v, base_v) {
    let p = "";
    p += "你是 synie 导入执行代理（阶段 " + stage_name + "）。工作区 " + workspace_root() + "。\n";
    p += docs_must_read();
    p += "cutoff=" + cutoff_v + " SYNIE_BASE=" + base_v + "\n";
    p += "鉴权：`set -a; source " + scratch_root() + "/auth.env 2>/dev/null; set +a`；Header Authorization: Bearer $TOKEN。\n";
    p += "若 auth 不可用：imported=0, pilot_ok=false, halt=true, halt_reason=no_auth，failed 记原因，不要伪造成功。\n";
    p += "阶段任务：\n" + stage_detail + "\n";
    p += "载荷目录：" + scratch_root() + "/payloads/\n";
    p += "状态文件（jdy→synie ID 映射，断点续跑）：" + scratch_root() + "/state/" + state_file + "\n";
    p += "编排：POST 建草稿 → POST /:id/audit 或 confirm；历史单号写入备注。\n";
    p += "熔断：先试导入 1~3 单；任一失败 → pilot_ok=false、halt=true、停止放量。\n";
    p += "放量后若失败率 >5% → halt=true、halt_reason 写明、停止。\n";
    p += "failed[] 带 API 报错原文；附件挂接 ~2s/次。\n";
    p += "幂等：state 已有映射则跳过。\n";
    p += iron_rules();
    p += "返回 {imported, failed[], state_path, skipped, pilot_ok, fail_rate, summary, halt, halt_reason}。\n";
    p
}

// ════════════════════════════════════════════════════════════════════
// Stage0 config
// ════════════════════════════════════════════════════════════════════
phase("Stage0");
let s0_detail = "";
s0_detail += "阶段 0 配置导入（幂等按 code 判存）：\n";
s0_detail += "1) 采购报价 payloads/pq.json → POST /purchase/quotations → audit\n";
s0_detail += "2) 银行账户 payloads/bank_accounts.json → POST /finance/bank-accounts + 绑科目\n";
s0_detail += "3) 供应商补建 payloads/suppliers_create.json → POST /base/suppliers\n";
s0_detail += "4) 外协仓 payloads/outsourced_warehouses.json（叶子+is_outsourced+绑供应商）\n";
s0_detail += "5) 客户地址 payloads/addresses.json → party-addresses 去重挂接\n";
s0_detail += "6) 默认过账科目四槽（发货借未开票应收、入库贷未开票应付等）只读确认/补配\n";
s0_detail += "7) D4：相关仓 allow_negative=true；D5：临时放宽超发/超收容差（记 state 以便收回）\n";
let s0 = agent(import_prompt("0-配置", s0_detail, "stage0.json", cutoff, synie_base), #{
    label: "import:stage0",
    capability_mode: "all",
    output_schema: stage_schema,
});
if stage_halted(s0) {
    log("Stage0 halt or fail — continue non-dependent extract already done; import may be limited");
}

// ════════════════════════════════════════════════════════════════════
// Stage1 bank transactions
// ════════════════════════════════════════════════════════════════════
phase("Stage1");
let s1_detail = "";
s1_detail += "阶段 1 资金台账：银行流水去重后全量导入。\n";
s1_detail += "路径：按账户拼 xlsx/CSV → POST /finance/bank-imports（绑定账户+模板）→ 解析修正 → POST /finance/bank-imports/:id/import。\n";
s1_detail += "≤5000 行/批；同文件防重传。流水不记账。其他收付款 48 条并入候选或手工流水。\n";
s1_detail += "本阶段不做流水对账。\n";
let s1 = agent(import_prompt("1-流水", s1_detail, "stage1_bank.json", cutoff, synie_base), #{
    label: "import:stage1",
    capability_mode: "all",
    output_schema: stage_schema,
});
if stage_halted(s1) {
    let reason = "stage1 halted";
    if ok_stage(s1) && s1.output.halt_reason != () { reason = s1.output.halt_reason; }
    // circuit: fail_rate>5% ends whole run per user rule
    if ok_stage(s1) && s1.output.fail_rate != () && s1.output.fail_rate > 0.05 {
        let early = "";
        early += "# 迁移提前结束（熔断）\n\n阶段 1 失败率超 5%。\n\n";
        early += "halt_reason: " + reason + "\n";
        early += "已完成：Bootstrap/Extract/RuleClean/AiClean/Payloads/Stage0/Stage1(部分)\n";
        early += "未完成：Stage2~6 与验收\n";
        let path = write_scratch_file("early_stop_report.md", early);
        complete(#{
            path: path,
            report: early,
            complete: false,
            halted_stage: "Stage1",
            halt_reason: reason,
        });
    }
}

// ════════════════════════════════════════════════════════════════════
// Stage2 opening journal
// ════════════════════════════════════════════════════════════════════
phase("Stage2");
let s2_detail = "";
s2_detail += "阶段 2 期初凭证（轨道 B）：\n";
s2_detail += "1) 读 opening_ar_clean.json；负数行已在 anomalies 的跳过进遗留\n";
s2_detail += "2) POST /accounting/gl-journals 手工凭证，过账日期=" + cutoff + " 的前一日\n";
s2_detail += "3) 往来科目行强制带对手（客户/供应商）；借贷配平\n";
s2_detail += "4) audit 过账。GL 其余科目期初可同批或分批。\n";
let s2 = agent(import_prompt("2-期初", s2_detail, "stage2_opening.json", cutoff, synie_base), #{
    label: "import:stage2",
    capability_mode: "all",
    output_schema: stage_schema,
});
if stage_halted(s2) && ok_stage(s2) && s2.output.fail_rate != () && s2.output.fail_rate > 0.05 {
    let reason = if s2.output.halt_reason != () { s2.output.halt_reason } else { "stage2 fail_rate>5%" };
    let early = "# 迁移提前结束（熔断）\n\n阶段 2 失败率超 5%：" + reason + "\n";
    let path = write_scratch_file("early_stop_report.md", early);
    complete(#{ path: path, report: early, complete: false, halted_stage: "Stage2", halt_reason: reason });
}

// ════════════════════════════════════════════════════════════════════
// Stage3 sales chain
// ════════════════════════════════════════════════════════════════════
phase("Stage3");
let s3_detail = "";
s3_detail += "阶段 3 销售在途链（轨道 A），顺序不可乱：\n";
s3_detail += "1) 在途销售订单 → POST /sales/orders → audit（条目挂已审报价；注意非本客户物料）\n";
s3_detail += "2) 已发未对账发货 → POST /sales/shipments → audit；过账日期=历史发货日；行仓必填；负库存已开\n";
s3_detail += "3) 历史销售退货优先手工行 → audit\n";
s3_detail += "4) 销售对账单勾选在途发货/退货 → confirm\n";
s3_detail += "5) D2：仅在途未票链开票 → POST 发票 → audit 带 postingDate=历史开票日；一票一单金额相等\n";
s3_detail += "按业务日期时序、可按客户推进；state 记全链 ID 映射。\n";
let s3 = agent(import_prompt("3-销售链", s3_detail, "stage3_sales.json", cutoff, synie_base), #{
    label: "import:stage3",
    capability_mode: "all",
    output_schema: stage_schema,
});
if stage_halted(s3) && ok_stage(s3) && s3.output.fail_rate != () && s3.output.fail_rate > 0.05 {
    let reason = if s3.output.halt_reason != () { s3.output.halt_reason } else { "stage3 fail_rate>5%" };
    let early = "# 迁移提前结束（熔断）\n\n阶段 3：" + reason + "\n";
    let path = write_scratch_file("early_stop_report.md", early);
    complete(#{ path: path, report: early, complete: false, halted_stage: "Stage3", halt_reason: reason });
}

// ════════════════════════════════════════════════════════════════════
// Stage4 purchase + outsource
// ════════════════════════════════════════════════════════════════════
phase("Stage4");
let s4_detail = "";
s4_detail += "阶段 4 采购与委外在途链：\n";
s4_detail += "1) 采购订单全量（约 17）→ audit（依赖阶段 0 报价）\n";
s4_detail += "2) 已收未对账采购入库 → audit；过账日期=历史业务日\n";
s4_detail += "3) 委外：委外订单+发料清单 → 在途发料/入库；D8 供应商/外协仓已补\n";
s4_detail += "4) 采购/委外对账 → confirm → 在途发票（若适用）\n";
s4_detail += "注意作废闸：已对账>0 的委外入库禁止退货。\n";
let s4 = agent(import_prompt("4-采购委外", s4_detail, "stage4_purchase.json", cutoff, synie_base), #{
    label: "import:stage4",
    capability_mode: "all",
    output_schema: stage_schema,
});
if stage_halted(s4) && ok_stage(s4) && s4.output.fail_rate != () && s4.output.fail_rate > 0.05 {
    let reason = if s4.output.halt_reason != () { s4.output.halt_reason } else { "stage4 fail_rate>5%" };
    let early = "# 迁移提前结束（熔断）\n\n阶段 4：" + reason + "\n";
    let path = write_scratch_file("early_stop_report.md", early);
    complete(#{ path: path, report: early, complete: false, halted_stage: "Stage4", halt_reason: reason });
}

// ════════════════════════════════════════════════════════════════════
// Stage5 bills
// ════════════════════════════════════════════════════════════════════
phase("Stage5");
let s5_detail = "";
s5_detail += "阶段 5 票据：读 clean/bills_canonical.json（D9 已对账取一份）。\n";
s5_detail += "在手持承兑：逐票建接收交易（发生日期=原收票日）→ audit（自动建档+持有段+凭证）。\n";
s5_detail += "子票区间按 (止-起+1)/100；接收段不得与现有持有段重叠。\n";
s5_detail += "已转让/已兑付历史票：归档留档不补链。附件从 attach/ 挂接 ~2s/次。\n";
let s5 = agent(import_prompt("5-票据", s5_detail, "stage5_bills.json", cutoff, synie_base), #{
    label: "import:stage5",
    capability_mode: "all",
    output_schema: stage_schema,
});
if stage_halted(s5) && ok_stage(s5) && s5.output.fail_rate != () && s5.output.fail_rate > 0.05 {
    let reason = if s5.output.halt_reason != () { s5.output.halt_reason } else { "stage5 fail_rate>5%" };
    let early = "# 迁移提前结束（熔断）\n\n阶段 5：" + reason + "\n";
    let path = write_scratch_file("early_stop_report.md", early);
    complete(#{ path: path, report: early, complete: false, halted_stage: "Stage5", halt_reason: reason });
}

// ════════════════════════════════════════════════════════════════════
// Stage6 stock + AR/AP + bank recon
// ════════════════════════════════════════════════════════════════════
phase("Stage6");
let s6_detail = "";
s6_detail += "阶段 6 库存与收付款收尾：\n";
s6_detail += "1) 库存期初：若有实盘 payloads/stock_opening.json → 入库方向手工出入库单建账并 audit\n";
s6_detail += "   若无实盘数据：记遗留问题，跳过，勿编造盘点数\n";
s6_detail += "2) 收付款凭证：AI 归类流水候选 → 手工凭证（银行↔往来带对手）→ audit\n";
s6_detail += "3) 流水对账勾稽（最后做；已被对账引用的凭证不可取消）\n";
s6_detail += "4) 可选盘点单拉平账实；完成后 D4 关闭各仓 allow_negative；D5 收回容差\n";
let s6 = agent(import_prompt("6-收尾", s6_detail, "stage6_close.json", cutoff, synie_base), #{
    label: "import:stage6",
    capability_mode: "all",
    output_schema: stage_schema,
});

// ════════════════════════════════════════════════════════════════════
// Phase Verify V1~V6
// ════════════════════════════════════════════════════════════════════
phase("Verify");
let ver_p = "";
ver_p += "你是迁移验收代理（read-only + 写报告）。fail-closed：缺证据即判未通过。\n";
ver_p += "工作区 " + workspace_root() + "。cutoff=" + cutoff + " base=" + synie_base + "\n";
ver_p += docs_must_read();
ver_p += "鉴权 source " + scratch_root() + "/auth.env；只用 GET/query，不写业务数据。\n";
ver_p += "验收：\n";
ver_p += "V1 逐户应收应付：synie 七往来角色轧差 vs 简道云老公式（发票+期初−流水−承兑±其他收付款）；对照表写 reports/v1_ar_ap.csv\n";
ver_p += "V2 银行余额：各账户流水余额 vs 简道云/对账单末笔\n";
ver_p += "V3 持有承兑总额 vs 简道云库存承兑在库\n";
ver_p += "V4 库存账实（有盘点则核对；无则标 skip+遗留）\n";
ver_p += "V5 各模块应迁/已迁/留档三数（读 state/* 与 archive payloads）\n";
ver_p += "V6 GL 期间抽查：历史单据分录过账日期落业务期间\n";
ver_p += "总报告必须写入 " + scratch_root() + "/reports/final_report.md，结构：\n";
ver_p += "# 简道云业务数据迁移报告\n## 决策执行记录（D1~D9）\n## 各阶段产物路径\n## V1~V6 结论\n## 留档桶与人工队列\n## 遗留问题\n## 熔断与失败原文摘要\n";
ver_p += "同时把报告全文写到 workflow scratch（你无法直接 write_scratch_file，把完整 markdown 放在 summary 字段，path 用 reports/final_report.md）。\n";
ver_p += "每个 Vn 对象：{pass:bool, detail:string, path?:string}\n";
ver_p += iron_rules();

let ver = agent(ver_p, #{
    label: "verify:v1-v6",
    capability_mode: "all",
    output_schema: verify_schema,
});

// Assemble final report in workflow scratch
let report = "";
report += "# 简道云业务数据迁移报告\n\n";
report += "workflow: `.grok/workflows/jdy-migration.rhai`\n\n";
report += "cutoff: " + cutoff + "\n\n";
report += "synie_base: " + synie_base + "\n\n";
report += "## 决策执行记录\n\n";
report += "| # | 取值 |\n|---|---|\n";
report += "| D1 | cutoff=" + cutoff + " |\n";
report += "| D2 | 已票账两清不迁发票，只迁在途未票链 |\n";
report += "| D3 | 实盘后入库方向手工出入库建账（无盘点则遗留） |\n";
report += "| D4 | 导入期打开相关仓允许负数库存，盘点后关闭 |\n";
report += "| D5 | 按在途单放宽超发/超收，迁完收回 |\n";
report += "| D6 | 报价占位截止日 2099-12-31 沿用 |\n";
report += "| D7 | 23 张客户冲突报价单维持不导入 |\n";
report += "| D8 | 委外归一后缺档补建供应商+外协仓 |\n";
report += "| D9 | 承兑两表业务键对账后取信息更全一份，对账留档 |\n\n";

report += "## 各阶段产物路径\n\n";
report += "- raw: " + scratch_root() + "/raw/\n";
report += "- clean: " + scratch_root() + "/clean/\n";
report += "- ai: " + scratch_root() + "/ai/\n";
report += "- queues: " + scratch_root() + "/queues/\n";
report += "- payloads: " + scratch_root() + "/payloads/\n";
report += "- state: " + scratch_root() + "/state/\n";
report += "- attach: " + scratch_root() + "/attach/\n";
report += "- reports: " + scratch_root() + "/reports/\n";
report += "- decisions: " + scratch_root() + "/decisions.json\n\n";

report += "## 抽取摘要\n\n";
report += "表单数目标: " + forms.len().to_string() + "；成功回报: " + extract_results.len().to_string() + "\n\n";
for er in extract_results {
    let c = 0;
    if er.count != () { c = er.count; }
    let fname = "";
    if er.form != () { fname = er.form; }
    report += "- " + fname + ": " + c.to_string() + "\n";
}
report += "\n## AI 清洗\n\n";
report += "shards=" + shards.len().to_string() + " tokens_used≈" + ai_tokens.to_string();
report += " accepted≈" + ai_accepted.to_string() + " human_queue≈" + ai_queued.to_string() + "\n\n";

report += "## 导入阶段\n\n";
fn stage_line(name, r) {
    if !ok_stage(r) { return "- " + name + ": FAILED/empty\n"; }
    let imp = 0;
    if r.output.imported != () { imp = r.output.imported; }
    let fr = 0.0;
    if r.output.fail_rate != () { fr = r.output.fail_rate; }
    let sum = "";
    if r.output.summary != () { sum = r.output.summary; }
    "- " + name + ": imported=" + imp.to_string() + " fail_rate=" + fr.to_string() + " " + sum + "\n"
}
report += stage_line("Stage0", s0);
report += stage_line("Stage1", s1);
report += stage_line("Stage2", s2);
report += stage_line("Stage3", s3);
report += stage_line("Stage4", s4);
report += stage_line("Stage5", s5);
report += stage_line("Stage6", s6);

report += "\n## V1~V6 结论\n\n";
if ok_stage(ver) {
    if ver.output.summary != () {
        report += ver.output.summary + "\n\n";
    }
    report += "report_path: " + (if ver.output.report_path != () { ver.output.report_path } else { "" }) + "\n";
} else {
    report += "验收代理失败或无输出（fail-closed：未通过）。\n";
}

report += "\n## 留档桶与人工队列\n\n";
report += "- " + scratch_root() + "/queues/human_queue.json\n";
report += "- " + scratch_root() + "/queues/suggest_create_suppliers.json\n";
report += "- payloads/*_archive.json\n\n";

report += "## 遗留问题\n\n";
report += "详见 " + scratch_root() + "/reports/final_report.md 与验收 open_issues。\n";
if ok_stage(ver) && ver.output.open_issues != () {
    for iss in ver.output.open_issues {
        report += "- " + iss + "\n";
    }
}

let out_path = write_scratch_file("jdy_migration_report.md", report);
log("complete report -> " + out_path);
complete(#{
    path: out_path,
    report: report,
    cutoff: cutoff,
    complete: true,
    extract_forms: extract_results.len(),
    ai_shards: shards.len(),
    ai_tokens: ai_tokens,
});
