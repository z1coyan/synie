import type { ResourceMeta } from '~/platform/meta/types.ts'

function field(
  dbName: string,
  apiName: string,
  type: ResourceMeta['fields'][number]['type'],
  label: string,
  opts: Partial<ResourceMeta['fields'][number]> = {},
): ResourceMeta['fields'][number] {
  return { name: dbName, apiName, dbColumn: dbName, type, label, ...opts }
}

export const USER_RESOURCE = 'sysUsers'
export const ROLE_RESOURCE = 'sysRoles'
export const ROLE_PERM_RESOURCE = 'sysRolePermissions'
export const ROLE_MENU_RESOURCE = 'sysRoleMenus'
export const DEPARTMENT_RESOURCE = 'sysDepartments'

/**
 * 部门：挂公司的组织树主数据（IAM 拥有），dept/deptTree 数据范围的取值来源。
 * 自身按公司域判定——本资源即新授权体系（guard + Permit）的首个消费者。
 */
export function departmentResourceMeta(): ResourceMeta {
  return {
    name: DEPARTMENT_RESOURCE,
    classification: { presentation: 'basic', interactive: true },
    permissionPrefix: 'sys.department',
    permissionLabel: '部门',
    numbering: true,
    table: 'sys_department',
    authz: { kind: 'company' },
    fields: [
      field('id', 'id', 'uuid', 'id', { readonly: true, sortable: true }),
      field('code', 'code', 'string', '部门编码', {
        readonly: true,
        maxLength: 32,
        filterable: true,
        sortable: true,
      }),
      field('name', 'name', 'string', '部门名称', {
        required: true,
        maxLength: 64,
        filterable: true,
        sortable: true,
      }),
      field('enabled', 'enabled', 'boolean', '启用', { filterable: true, sortable: true }),
      field('has_children', 'hasChildren', 'boolean', '含下级部门', {
        calculated: true,
        printOnly: true,
      }),
      field('inserted_at', 'insertedAt', 'datetime', '创建时间', {
        readonly: true,
        filterable: true,
        sortable: true,
      }),
      field('updated_at', 'updatedAt', 'datetime', '更新时间', {
        readonly: true,
        filterable: true,
        sortable: true,
      }),
      field('company_id', 'companyId', 'fk', '公司', {
        required: true,
        createOnly: true,
        filterable: true,
        ref: { resource: 'basCompanies', relation: 'company', labelField: 'name' },
      }),
      // nullable：置空即升为公司下的一级部门（标准派生 create/update schema 消费）
      field('parent_id', 'parentId', 'fk', '上级部门', {
        nullable: true,
        filterable: true,
        ref: { resource: DEPARTMENT_RESOURCE, relation: 'parent', labelField: 'name' },
      }),
    ],
    actions: [
      { key: 'read', label: '查看', scope: 'both' },
      { key: 'create', label: '新增', scope: 'both' },
      { key: 'update', label: '编辑', scope: 'row' },
      { key: 'delete', label: '删除', scope: 'row', isDanger: true },
    ],
    form: {
      kind: 'basic',
      // enabled 走独立行动作（启停不进表单）；path 是物化实现细节，不投影
      exclude: ['id', 'enabled', 'hasChildren', 'insertedAt', 'updatedAt'],
      fields: {
        // basic form 的只读事实由字段级 readonly 投影，form 层不得重复声明 edit
        code: { placeholder: '保存后自动编号', span: 6 },
        name: { placeholder: '如 冲压车间', span: 6 },
        parentId: { placeholder: '留空即公司下的一级部门' },
      },
    },
    lookup: {
      labelField: 'name',
      searchFields: ['name', 'code'],
      subtitleFields: ['code'],
    },
    audit: { enabled: true },
  }
}

export function userResourceMeta(): ResourceMeta {
  return {
    name: USER_RESOURCE,
    classification: { presentation: 'basic', interactive: true },
    permissionPrefix: 'sys.user',
    permissionLabel: '用户',
    table: 'sys_user',
    authz: { kind: 'global' },
    fields: [
      field('id', 'id', 'uuid', 'id', { readonly: true, sortable: true }),
      field('username', 'username', 'string', '用户名', {
        required: true,
        createOnly: true,
        filterable: true,
        sortable: true,
      }),
      field('name', 'name', 'string', '姓名', { filterable: true, sortable: true }),
      field('email', 'email', 'string', '邮箱', {
        filterable: true,
        sortable: true,
      }),
      field('preferred_language', 'preferredLanguage', 'string', '首选语言', {
        readonly: true,
        filterable: true,
        sortable: true,
      }),
      // 单部门（兼任需求出现时再演进为关系表）；部门所在公司须在该用户公司授权集内
      field('department_id', 'departmentId', 'fk', '部门', {
        filterable: true,
        ref: { resource: DEPARTMENT_RESOURCE, relation: 'department', labelField: 'name' },
      }),
      field('inserted_at', 'insertedAt', 'datetime', '创建时间', {
        readonly: true,
        filterable: true,
        sortable: true,
      }),
      field('updated_at', 'updatedAt', 'datetime', '更新时间', {
        readonly: true,
        filterable: true,
        sortable: true,
      }),
    ],
    actions: [
      { key: 'read', label: '查看', scope: 'both' },
      { key: 'create', label: '新增', scope: 'both' },
      { key: 'update', label: '编辑', scope: 'row' },
      { key: 'delete', label: '删除', scope: 'row', isDanger: true },
    ],
    form: {
      exclude: ['id', 'preferredLanguage', 'insertedAt', 'updatedAt'],
      fields: {
        username: { placeholder: '如 zhangsan' },
        name: { placeholder: '如 张三' },
        email: { placeholder: '如 zhangsan@example.com（Logto 登录匹配用）' },
        departmentId: { placeholder: '限所选公司下的部门' },
      },
    },
    // extra：角色/公司关联并入用户审计面（join 数组，非物理列）
    audit: { enabled: true, sensitiveFields: ['hashed_password'], extra: ['role_ids', 'company_ids'] },

  }
}

export function roleResourceMeta(): ResourceMeta {
  return {
    name: ROLE_RESOURCE,
    classification: { presentation: 'extension', interactive: true, note: 'builtin 动态隐藏 + 权限矩阵' },
    permissionPrefix: 'sys.role',
    permissionLabel: '角色',
    table: 'sys_role',
    authz: { kind: 'global' },
    fields: [
      field('id', 'id', 'uuid', 'id', { readonly: true, sortable: true }),
      field('code', 'code', 'string', '角色编码', {
        required: true,
        createOnly: true,
        filterable: true,
        sortable: true,
      }),
      field('name', 'name', 'string', '角色名称', {
        required: true,
        filterable: true,
        sortable: true,
      }),
      field('enabled', 'enabled', 'boolean', '启用', { filterable: true, sortable: true }),
      field('builtin', 'builtin', 'boolean', '内置角色', {
        readonly: true,
        filterable: true,
        sortable: true,
      }),
      field('inserted_at', 'insertedAt', 'datetime', '创建时间', {
        readonly: true,
        filterable: true,
        sortable: true,
      }),
      field('updated_at', 'updatedAt', 'datetime', '更新时间', {
        readonly: true,
        filterable: true,
        sortable: true,
      }),
    ],
    actions: [
      { key: 'read', label: '查看', scope: 'both' },
      { key: 'create', label: '新增', scope: 'both' },
      { key: 'update', label: '编辑', scope: 'row' },
      { key: 'delete', label: '删除', scope: 'row', isDanger: true },
      { key: 'batch_delete', label: '批量删除', scope: 'bulk', permissionAction: 'delete', isDanger: true },
      { key: 'export', label: '导出', scope: 'both' },
      { key: 'print', label: '打印', scope: 'row' },
      { key: 'batch_print', label: '批量打印', scope: 'bulk', permissionAction: 'print' },
    ],
    form: {
      exclude: ['id', 'enabled', 'builtin', 'insertedAt', 'updatedAt'],
      fields: {
        code: { required: true, edit: 'createOnly' },
        name: { required: true },
      },
    },
    print: true,
    audit: { enabled: true },

  }
}

export function rolePermissionResourceMeta(): ResourceMeta {
  return {
    name: ROLE_PERM_RESOURCE,
    classification: { presentation: 'none', interactive: false, note: 'catalog-only：嵌于角色 PE，无独立 Client/抽屉' },
    permissionPrefix: 'sys.role_permission',
    permissionLabel: '角色权限',
    table: 'sys_role_permission',
    authz: { kind: 'global' },
    fields: [
      field('id', 'id', 'uuid', 'id', { readonly: true, sortable: true }),
      field('role_id', 'roleId', 'fk', '角色', {
        required: true,
        filterable: true,
        sortable: true,
        ref: { resource: ROLE_RESOURCE, relation: 'role', labelField: 'name' },
      }),
      field('permission', 'permission', 'string', '权限码', {
        required: true,
        filterable: true,
        sortable: true,
      }),
      field('inserted_at', 'insertedAt', 'datetime', '创建时间', {
        readonly: true,
        sortable: true,
      }),
    ],
    actions: [
      { key: 'read', label: '查看', scope: 'both' },
      { key: 'create', label: '授权', scope: 'both' },
      { key: 'delete', label: '撤销', scope: 'row', isDanger: true },
    ],
    print: true,
    audit: { enabled: true },
  }
}

export function roleMenuResourceMeta(): ResourceMeta {
  return {
    name: ROLE_MENU_RESOURCE,
    classification: { presentation: 'none', interactive: false, note: 'catalog-only：嵌于角色「配置菜单」Sheet，无独立 Client/抽屉' },
    permissionPrefix: 'sys.role_menu',
    permissionLabel: '角色菜单',
    table: 'sys_role_menu',
    authz: { kind: 'global' },
    fields: [
      field('id', 'id', 'uuid', 'id', { readonly: true, sortable: true }),
      field('role_id', 'roleId', 'fk', '角色', {
        required: true,
        filterable: true,
        sortable: true,
        ref: { resource: ROLE_RESOURCE, relation: 'role', labelField: 'name' },
      }),
      field('menu_code', 'menuCode', 'string', '菜单码', {
        required: true,
        filterable: true,
        sortable: true,
      }),
      field('inserted_at', 'insertedAt', 'datetime', '创建时间', {
        readonly: true,
        sortable: true,
      }),
    ],
    actions: [
      { key: 'read', label: '查看', scope: 'both' },
      { key: 'update', label: '配置', scope: 'both' },
    ],
    audit: { enabled: true },
  }
}

export function allIamResourceMetas(): ResourceMeta[] {
  return [
    departmentResourceMeta(),
    userResourceMeta(),
    roleResourceMeta(),
    rolePermissionResourceMeta(),
    roleMenuResourceMeta(),
  ]
}
