# 06 — 试点：files（via + owner，三套语义收敛）

**What to build:** 文件/附件域迁到新体系，作为 `via` 组合子与 owner 维度的第一消费者：`sys_file` 声明 `owner: uploaded_by_id`（孤儿文件 read/attach 范围=self）；挂接可达性（现 `owner-registry.resolveOwner`）、下载可达性（现 `files/service.ts:329`）、发票凭证附件（现 `invoice-service.ts:requireAccessibleFile`）三套各异语义收敛为一个 via 实现（以 owner-registry 语义为准：宿主 read 权限 + 公司范围，孤儿走 owner）。`AttachmentsMeta.companyScoped` 并入 authz 声明口径。uploader-only 裸 superAdmin 旗标读全部消除。

**Blocked by:** 04

**Status:** ready-for-agent

- [ ] sys_file / sys_attachment / sys_storage 三资源 authz 声明与服务签名 Permit 化
- [ ] via 实现：挂接→宿主递归判定（宿主 read + 公司；nullable 公司=全局宿主）
- [ ] 下载/挂接/删除三径统一语义，invoice requireAccessibleFile 删除改走平台判定
- [ ] 现有文件域集成测试全绿 + 新增孤儿/跨公司/无宿主权限用例
- [ ] 封路豁免清单移除 platform/files 与相关 finance 项

## Comments
