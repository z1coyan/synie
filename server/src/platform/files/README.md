# files（骨架）

不可变文件对象（≤50MB、SHA-256 元数据）+ 存储接入点（本地/S3 兼容/OSS，
全局恰一个默认）+ 文件挂接（宿主白名单 fail-closed，公司归属固化）。
- 行为参考：`server-go/internal/platform/files/`
- 表：`sys_file` / `sys_storage` / `sys_attachment`
- 实现工单：`.scratch/ts-backend-rewrite/issues/01-platform-completion.md`
