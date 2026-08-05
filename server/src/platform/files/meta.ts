import type { ResourceMeta } from '../meta/types.ts'
import { SYS_STORAGE } from './permissions.ts'

export const FILE_RESOURCE_NAME = 'sysFiles'
export const ATTACHMENT_RESOURCE_NAME = 'sysAttachments'
export const STORAGE_RESOURCE_NAME = 'sysStorages'

export function fileResourceMeta(): ResourceMeta {
  return {
    name: FILE_RESOURCE_NAME,
    classification: { presentation: 'none', interactive: true, note: '上传创建、只读详情与删除；无普通 create/edit Form' },
    permissionPrefix: 'sys.file',
    permissionLabel: '附件',
    table: 'sys_file',
    // 无公司列；owner 绑定上传者列 → 开放 self 范围（授 scope=self 即「只看/只下本人上传」）
    authz: { kind: 'global', owner: { column: 'uploaded_by_id' } },
    print: true,
    // 与挂接资源同前缀（sys.file）：文件是打印字段目录的头资源
    printHead: true,
    audit: { enabled: true },
    fields: [
      { name: 'id', apiName: 'id', dbColumn: 'id', type: 'uuid', label: 'id', readonly: true, sortable: true },
      {
        name: 'storage',
        apiName: 'storage',
        dbColumn: 'storage',
        type: 'string',
        label: '存储接入',
        readonly: true,
        filterable: true,
        sortable: true,
      },
      {
        name: 'key',
        apiName: 'key',
        dbColumn: 'key',
        type: 'string',
        label: '对象键',
        readonly: true,
        filterable: true,
        sortable: true,
      },
      {
        name: 'filename',
        apiName: 'filename',
        dbColumn: 'filename',
        type: 'string',
        label: '文件名',
        readonly: true,
        filterable: true,
        sortable: true,
      },
      {
        name: 'content_type',
        apiName: 'contentType',
        dbColumn: 'content_type',
        type: 'string',
        label: 'MIME 类型',
        readonly: true,
        filterable: true,
        sortable: true,
      },
      {
        name: 'size',
        apiName: 'size',
        dbColumn: 'size',
        type: 'integer',
        label: '大小',
        readonly: true,
        filterable: true,
        sortable: true,
      },
      {
        name: 'sha256',
        apiName: 'sha256',
        dbColumn: 'sha256',
        type: 'string',
        label: 'SHA-256 摘要',
        readonly: true,
        filterable: true,
        sortable: true,
      },
      {
        name: 'inserted_at',
        apiName: 'insertedAt',
        dbColumn: 'inserted_at',
        type: 'datetime',
        label: '上传时间',
        readonly: true,
        filterable: true,
        sortable: true,
      },
      {
        name: 'uploaded_by_id',
        apiName: 'uploadedById',
        dbColumn: 'uploaded_by_id',
        type: 'uuid',
        label: '上传人',
        readonly: true,
        filterable: true,
        ref: { resource: 'sysUsers', relation: 'uploadedBy', labelField: 'name' },
      },
    ],
    actions: [
      { key: 'read', label: '查看', scope: 'both' },
      { key: 'create', label: '上传', scope: 'both' },
      { key: 'delete', label: '删除', scope: 'row', isDanger: true },
    ],
    form: { exclude: ['id', 'storage', 'key', 'insertedAt'] },

  }
}

/**
 * 文件挂接（sys_attachment）。
 *
 * 判定归宿声明为 `via(sysFiles, file_id)`：码级判定复用 `sys.file:*`（挂接不设独立权限点），
 * 行级基线判定递归到文件自己的 decide()。业务宿主（owner_type/owner_id）是**多态**的，
 * 静态 via 表达不了，故宿主可达性在 files/reachability.ts 动态解析（见其文件头）。
 */
export function attachmentResourceMeta(): ResourceMeta {
  return {
    name: ATTACHMENT_RESOURCE_NAME,
    classification: {
      presentation: 'none',
      interactive: false,
      note: '文件挂接关联行：无独立列表/表单，随宿主资源的附件面板呈现',
    },
    permissionPrefix: 'sys.file',
    permissionLabel: '附件',
    table: 'sys_attachment',
    authz: { kind: 'via', parent: FILE_RESOURCE_NAME, fk: 'file_id' },
    audit: { enabled: true },
    lookup: { labelField: 'category' },
    fields: [
      { name: 'id', apiName: 'id', dbColumn: 'id', type: 'uuid', label: 'id', readonly: true, sortable: true },
      {
        name: 'file_id',
        apiName: 'fileId',
        dbColumn: 'file_id',
        type: 'uuid',
        label: '文件',
        readonly: true,
        filterable: true,
      },
      {
        name: 'owner_type',
        apiName: 'ownerType',
        dbColumn: 'owner_type',
        type: 'string',
        label: '宿主类型',
        readonly: true,
        filterable: true,
        sortable: true,
      },
      {
        name: 'owner_id',
        apiName: 'ownerId',
        dbColumn: 'owner_id',
        type: 'uuid',
        label: '宿主记录',
        readonly: true,
        filterable: true,
      },
      {
        name: 'category',
        apiName: 'category',
        dbColumn: 'category',
        type: 'string',
        label: '分类',
        readonly: true,
        filterable: true,
        sortable: true,
      },
      {
        // 挂接时按宿主固化（宿主为全局资源时为 NULL）；仅作展示/筛选，判定走宿主自身声明
        name: 'company_id',
        apiName: 'companyId',
        dbColumn: 'company_id',
        type: 'uuid',
        label: '公司',
        readonly: true,
        filterable: true,
      },
      {
        name: 'inserted_at',
        apiName: 'insertedAt',
        dbColumn: 'inserted_at',
        type: 'datetime',
        label: '挂接时间',
        readonly: true,
        filterable: true,
        sortable: true,
      },
    ],
    actions: [
      { key: 'read', label: '查看', scope: 'both' },
      { key: 'create', label: '挂接', scope: 'both' },
      { key: 'delete', label: '移除', scope: 'row', isDanger: true },
    ],
  }
}

export function storageResourceMeta(): ResourceMeta {
  const kinds = [
    { value: 'LOCAL', label: '本地磁盘' },
    { value: 'S3', label: 'S3 兼容' },
    { value: 'OSS', label: '阿里云 OSS' },
  ]
  return {
    name: STORAGE_RESOURCE_NAME,
    classification: { presentation: 'basic', interactive: true, note: 'setDefault 命令' },
    permissionPrefix: SYS_STORAGE.prefix,
    permissionLabel: '存储接入',
    table: 'sys_storage',
    authz: { kind: 'global' },
    print: true,
    // exclude 保留历史审计面：密钥列从不进审计 diff（sensitiveFields 兜底脱敏）
    audit: { enabled: true, sensitiveFields: ['secret_access_key'], exclude: ['secret_access_key'] },
    fields: [
      { name: 'id', apiName: 'id', dbColumn: 'id', type: 'uuid', label: 'id', readonly: true, sortable: true },
      {
        name: 'name',
        apiName: 'name',
        dbColumn: 'name',
        type: 'string',
        label: '接入名',
        required: true,
        createOnly: true,
        filterable: true,
        sortable: true,
      },
      {
        name: 'label',
        apiName: 'label',
        dbColumn: 'label',
        type: 'string',
        label: '显示名',
        required: true,
        filterable: true,
        sortable: true,
      },
      {
        name: 'kind',
        apiName: 'kind',
        dbColumn: 'kind',
        type: 'enum',
        label: '存储类型',
        required: true,
        createOnly: true,
        enumOptions: kinds,
        filterable: true,
        sortable: true,
      },
      {
        name: 'root',
        apiName: 'root',
        dbColumn: 'root',
        type: 'string',
        label: '根目录',
        filterable: true,
        sortable: true,
      },
      {
        name: 'endpoint',
        apiName: 'endpoint',
        dbColumn: 'endpoint',
        type: 'string',
        label: '服务地址',
        filterable: true,
        sortable: true,
      },
      {
        name: 'region',
        apiName: 'region',
        dbColumn: 'region',
        type: 'string',
        label: '区域',
        filterable: true,
        sortable: true,
      },
      {
        name: 'bucket',
        apiName: 'bucket',
        dbColumn: 'bucket',
        type: 'string',
        label: 'Bucket',
        filterable: true,
        sortable: true,
      },
      {
        name: 'prefix',
        apiName: 'prefix',
        dbColumn: 'prefix',
        type: 'string',
        label: '对象键前缀',
        filterable: true,
        sortable: true,
      },
      {
        name: 'access_key_id',
        apiName: 'accessKeyId',
        dbColumn: 'access_key_id',
        type: 'string',
        label: 'Access Key ID',
        filterable: true,
        sortable: true,
      },
      {
        name: 'secret_access_key',
        apiName: 'secretAccessKey',
        dbColumn: 'secret_access_key',
        type: 'string',
        label: 'Secret Access Key',
        sensitive: true,
      },
      {
        name: 'builtin',
        apiName: 'builtin',
        dbColumn: 'builtin',
        type: 'boolean',
        label: '内置',
        readonly: true,
        filterable: true,
        sortable: true,
      },
      {
        name: 'is_default',
        apiName: 'isDefault',
        dbColumn: 'is_default',
        type: 'boolean',
        label: '全局默认',
        readonly: true,
        filterable: true,
        sortable: true,
      },
      {
        name: 'inserted_at',
        apiName: 'insertedAt',
        dbColumn: 'inserted_at',
        type: 'datetime',
        label: '创建时间',
        readonly: true,
        filterable: true,
        sortable: true,
      },
      {
        name: 'updated_at',
        apiName: 'updatedAt',
        dbColumn: 'updated_at',
        type: 'datetime',
        label: '更新时间',
        readonly: true,
        filterable: true,
        sortable: true,
      },
    ],
    actions: [
      { key: 'read', label: '查看', scope: 'both' },
      { key: 'create', label: '新增', scope: 'both' },
      { key: 'update', label: '编辑', scope: 'row' },
      { key: 'delete', label: '删除', scope: 'row', isDanger: true },
      {
        // 语义 key=setDefault；requiredCapability=update（与 SYS_STORAGE.update 对齐）
        key: 'setDefault',
        label: '设为默认',
        scope: 'row',
        commandTarget: 'row',
        permissionAction: 'update',
        // v1 transport 兼容字段；工单 11 随旧 Grid action 删除

      },
    ],
    form: {
      exclude: ['id', 'insertedAt', 'updatedAt'],
      fields: {
        name: { span: 6, placeholder: '如 oss-hz,建后不可改' },
        label: { span: 6, placeholder: '如 杭州 OSS' },
        kind: { span: 6 },
        region: { span: 6, placeholder: '如 cn-hangzhou,可留空' },
        root: { placeholder: '如 uploads(相对后端工作目录)或 /var/synie/uploads' },
        endpoint: {
          placeholder: '如 https://oss-cn-hangzhou.aliyuncs.com 或 http://127.0.0.1:9000',
        },
        prefix: { placeholder: '对象键前缀(默认路径),可留空' },
      },
    },

  }
}
