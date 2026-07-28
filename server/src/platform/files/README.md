# files

不可变文件对象（≤50MB、SHA-256 元数据）+ 存储接入点（本地/S3 兼容/OSS，
全局恰一个默认）+ 文件挂接（宿主白名单 fail-closed，公司归属固化）。

- 行为参考：`server-go/internal/platform/files/`
- 表：`sys_file` / `sys_storage` / `sys_attachment`
- 实现工单：`.scratch/ts-backend-rewrite/issues/01-platform-completion.md`

## 模块

| 文件 | 职责 |
|------|------|
| `service.ts` | 上传/下载/挂接/删除；默认存储写入；公司范围列表 |
| `storage-service.ts` | 存储接入 CRUD + 设默认（advisory lock 串行） |
| `object-storage.ts` | 本地磁盘 + S3/OSS（SigV4，含预签名 GET） |
| `owner-registry.ts` | 宿主白名单；`resolveOwner` 固化 `company_id` |
| `meta.ts` | `sysFiles` / `sysStorages` ResourceMeta |
| `routes.ts` | `/files/*` 与 `/system/storages/*`（链式 + zValidator） |

## 装配（集成代理）

```ts
const owners = createOwnerRegistry()
// 领域包 register(ownerType, spec)...
const files = createFileService({ db, owners })
const storages = createStorageService({ db })
registerFileResources(registry)
app.route('/files', fileRoutes({ auth, files }))
app.route('/system/storages', storageRoutes({ auth, storages }))
```

密钥字段 `secretAccessKey` 只写不回读；响应仅 `secretConfigured`。
