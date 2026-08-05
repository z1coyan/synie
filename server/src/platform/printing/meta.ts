import type { ResourceMeta } from '../meta/types.ts'

export const RESOURCE_NAME = 'sysPrintTemplates'
export const PERMISSION_PREFIX = 'sys.print_template'

export function printTemplateResourceMeta(): ResourceMeta {
  const destroy = 'destroySysPrintTemplate'
  return {
    name: RESOURCE_NAME,
    classification: { presentation: 'basic', interactive: true },
    /** 模板源文件宿主（全局宿主，无公司隔离） */
    attachments: {},
    permissionPrefix: PERMISSION_PREFIX,
    permissionLabel: '打印模板',
    table: 'sys_print_template',
    authz: { kind: 'global' },
    print: true,
    audit: { enabled: true },
    fields: [
      {
        name: 'id',
        apiName: 'id',
        dbColumn: 'id',
        type: 'uuid',
        label: 'id',
        readonly: true,
        sortable: true,
      },
      {
        name: 'name',
        apiName: 'name',
        dbColumn: 'name',
        type: 'string',
        label: '模板名称',
        required: true,
        filterable: true,
        sortable: true,
      },
      {
        name: 'resource',
        apiName: 'resource',
        dbColumn: 'resource',
        type: 'string',
        label: '绑定资源',
        required: true,
        createOnly: true,
        filterable: true,
        sortable: true,
      },
      {
        name: 'is_default',
        apiName: 'isDefault',
        dbColumn: 'is_default',
        type: 'boolean',
        label: '默认模板',
        readonly: true,
        filterable: true,
        sortable: true,
      },
      {
        name: 'remarks',
        apiName: 'remarks',
        dbColumn: 'remarks',
        type: 'string',
        label: '备注',
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
      {
        name: 'file_id',
        apiName: 'fileId',
        dbColumn: 'file_id',
        type: 'uuid',
        label: '模板文件',
        required: true,
        filterable: true,
        ref: {
          resource: 'sysFiles',
          relation: 'file',
          labelField: 'filename',
        },
      },
    ],
    actions: [
      { key: 'read', label: '查看', scope: 'both' },
      { key: 'create', label: '新增', scope: 'both' },
      { key: 'update', label: '编辑', scope: 'row' },
      { key: 'delete', label: '删除', scope: 'row', isDanger: true },
      {
        key: 'setDefault',
        label: '设为默认',
        scope: 'row',
        commandTarget: 'row',
        permissionAction: 'update',
      },
      {
        key: 'unsetDefault',
        label: '取消默认',
        scope: 'row',
        commandTarget: 'row',
        permissionAction: 'update',
      },
    ],
    form: {
      exclude: ['id', 'isDefault', 'insertedAt', 'updatedAt'],
      fields: {
        name: { span: 6 },
        resource: { span: 6 },
        remarks: { span: 12 },
      },
    },
  }
}
