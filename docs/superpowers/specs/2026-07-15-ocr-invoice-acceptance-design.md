# 票据 OCR(增值税发票 + 承兑汇票)设计

2026-07-15 · 已与用户对齐

## 目标

在增值税发票和承兑汇票"接收"的创建动线里,上传票据图片 → 阿里云 OCR 识别 → 预填表单 → 人工核对后保存;识别用的图片在保存后自动留档为该记录的附件。

不做:批量导入页(后续可加)、识别历史台账、按公司区分凭证。

## 阿里云 API 要点

- `RecognizeInvoice`(增值税发票)与 `RecognizeBankAcceptance`(银行承兑汇票),POST 到 `ocr-api.cn-hangzhou.aliyuncs.com`。
- 图片二进制直接放 HTTP body(≤10MB),或传 `Url` 参数;本项目走 body 二进制(`Storage.read` 现成,local 存储也能用,不依赖外网可访问 URL)。
- 认证:阿里云 OpenAPI V3 签名(ACS3-HMAC-SHA256),无可用 Elixir SDK,手写签名模块。
- 发票支持图片 + PDF/OFD(数电票常见);承兑接口只支持图片,不收 PDF。
- 返回 `Data` 为 JSON 串:发票含 invoiceCode/invoiceNumber/invoiceDate/purchaser*/seller*/totalAmount/invoiceAmountPreTax/invoiceTax/invoiceDetails(明细行)等;承兑含 draftNumber/issueDate/validToDate/totalAmount/issuer*/payee*/acceptor*/assignability 等。

## 1. 财务设置 `acc_setting`(新资源)

- 单行字段表,全局配置,不挂公司(与 sys_storage 同基线)。
- 字段:`ocr_access_key_id :string`、`ocr_access_key_secret :string, sensitive? true`(明文入库,安全基线与 sys_storage 一致:靠权限码控读 + 前端打码)。
- 计算字段 `ocr_configured`(布尔):两个凭证字段均非空。前端用它判断 OCR 按钮可用性,不暴露凭证内容。
- 权限:`permission_prefix "acc.setting"`,actions `read` / `update`。
- 单例实现:migration seed 一行;`read :get` 取第一行,`update` 常规更新。
- GraphQL 在域文件集中注册(get 查询 + update mutation)。
- 以后财务相关全局配置(非公司维度)都加字段进这张表。

## 2. OCR 后端

- 新增依赖 `req`。
- `SynieCore.Ocr.AliyunSigner`:OpenAPI V3 签名(纯函数,可单测对拍)。
- `SynieCore.Ocr.AliyunClient`:发请求、解析响应、错误码转中文信息。
- `SynieCore.Ocr` 门面:
  - `recognize_invoice(file_id, actor)` / `recognize_bank_acceptance(file_id, actor)`
  - 流程:查 `sys_file` → `Storage.read` 取二进制 → 调阿里云 → 解析 `Data` → 映射为前端表单字段名的 map。
- 错误处理:凭证未配置、文件不存在、格式不支持、阿里云侧错误(额度、无法识别)均转明确中文错误,由 GraphQL errors 透出。

## 3. GraphQL 暴露

- 两个 generic action 分别挂在 `VatInvoice` 与 `BillTransaction` 资源上,注册为 mutation(形如 `ocrAccVatInvoice(fileId)` / `ocrAccBillTransaction(fileId)`),返回识别结果。
- 权限不新增权限码:policy `{HasPermission, as: "create"}` 复用创建权(同银行流水导入的复用手法)。

## 4. 前端动线

### 发票(创建抽屉)

- "上传发票识别"按钮:选文件(图片/PDF)→ `uploadFile`(裸文件,不挂 owner)→ 调 OCR mutation → `patchValues` 回填:发票代码/号码/开票日期/购销方四件套(名称、税号、地址电话、开户行账号)/不含税金额/税额/价税合计/明细行(前端 `ITEM_META` 已标注为 OCR 目标 schema)。
- 方向(开入/开出)由用户自选,OCR 不猜;`invoice_kind` 若能从返回的 invoiceType 映射则填,映射不上留空。

### 承兑(接收交易抽屉)

- 票面草稿区加"上传票据识别":上传 → OCR → 回填票号/票面金额/出票日/到期日/出票人三件套/收款人三件套/承兑人四件套/能否转让/承兑日期。
- 票号回填后复用既有失焦查档逻辑:票已建档则切换为只读摘要。

### 附件留档

- 记录保存成功后,把 OCR 用的 sys_file 补挂为该记录附件(`category="original"`)。
- 需后端补小能力:"给已有 sys_file 挂 owner 附件"(现仅有上传时一并挂的路径)。

### 防呆

- `ocr_configured` 为假时 OCR 按钮置灰 + tooltip 提示到系统管理配置。

## 5. 财务设置页(前端)

- 系统管理 → 财务设置(与存储配置并列),表单页而非 DataGrid:读单例、编辑、保存;secret 显示打码。

## 6. 测试

- `AliyunSigner`:固定密钥 + 固定时间戳对拍签名结果。
- 字段映射:阿里云样例 JSON → 表单字段 map 的单测。
- HTTP 层:Req.Test 模拟阿里云响应(成功/错误码/凭证缺失)。
- 前端沿用现有 E2E 基线,OCR 动线人工验证(依赖真实凭证,不进 CI)。
