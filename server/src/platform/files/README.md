# files

不可变文件对象（≤50MB、SHA-256 元数据）+ 存储接入点（本地/S3 兼容/OSS，
全局恰一个默认）+ 文件挂接（宿主白名单 fail-closed，公司归属固化）。

可达性只有一条规则（见 `reachability.ts`）：孤儿文件走文件自身行过滤
（`sys_file` 声明 owner=上传者列 → 授 scope=self 即只碰本人上传），已挂接文件随业务宿主
（宿主 read 码 + 宿主行级范围）。码不满足 `forbidden`，行级不可达 `not_found`。

- 行为参考：`server-go/internal/platform/files/`
- 表：`sys_file` / `sys_storage` / `sys_attachment`

## 模块

| 文件 | 职责 |
|------|------|
| `service.ts` | 上传/下载/挂接/删除；默认存储写入；公司范围列表 |
| `storage-service.ts` | 存储接入 CRUD + 设默认（advisory lock 串行） |
| `object-storage.ts` | 本地磁盘 + S3/OSS（SigV4，含预签名 GET） |
| `owner-registry.ts` | 宿主白名单（自 `meta.attachments` 派生，携宿主资源名） |
| `reachability.ts` | 文件/挂接可达性单实现；`resolveOwner` 固化 `company_id` |
| `meta.ts` | `sysFiles` / `sysAttachments`（via sysFiles）/ `sysStorages` ResourceMeta |
| `routes.ts` | `/files/*` 与 `/system/storages/*`（链式 + zValidator） |

## 装配（集成代理）

```ts
const owners = buildOwnerRegistryFromMeta(registry.list())
const authz = createAuthzEnforcer(registry)
const files = createFileService({ db, owners, authz })
const storages = createStorageService({ db, authz })
registerFileResources(registry)
app.route('/files', fileRoutes({ auth, authz, files }))
app.route('/system/storages', storageRoutes({ auth, authz, storages }))
```

密钥字段 `secretAccessKey` 只写不回读；响应仅 `secretConfigured`。
