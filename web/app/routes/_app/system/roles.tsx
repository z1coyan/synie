import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { Button, Input, Label, Switch, TextField, toast } from '@heroui/react'
import { Sheet } from '@heroui-pro/react'
import { gqlFetch } from '~/lib/graphql'
import { SynieDataGrid } from '~/components/synie-data-grid/SynieDataGrid'
import type { Row } from '~/components/synie-data-grid/types'

export const Route = createFileRoute('/_app/system/roles')({
  component: RolesPage,
})

interface RoleForm {
  id: string | null
  code: string
  name: string
  enabled: boolean
}

const CREATE_ROLE = `
  mutation ($input: CreateSysRoleInput!) {
    createSysRole(input: $input) { result { id } errors { message } }
  }
`
const UPDATE_ROLE = `
  mutation ($id: ID!, $input: UpdateSysRoleInput!) {
    updateSysRole(id: $id, input: $input) { result { id } errors { message } }
  }
`

function RolesPage() {
  const [form, setForm] = useState<RoleForm | null>(null)
  const [saving, setSaving] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)

  const save = async () => {
    if (!form) return
    if (!form.code.trim() || !form.name.trim()) {
      toast.danger('请填写角色编码与名称')
      return
    }
    setSaving(true)
    try {
      // 更新/创建两支返回不同字段名,各自取 errors 而非 Object.values(data)[0](那样会退化为 any)
      let errors: { message: string }[] | null
      if (form.id) {
        const data = await gqlFetch<{ updateSysRole: { errors: { message: string }[] | null } }>(UPDATE_ROLE, {
          id: form.id,
          input: { name: form.name, enabled: form.enabled },
        })
        errors = data.updateSysRole.errors
      } else {
        const data = await gqlFetch<{ createSysRole: { errors: { message: string }[] | null } }>(CREATE_ROLE, {
          input: { code: form.code, name: form.name, enabled: form.enabled },
        })
        errors = data.createSysRole.errors
      }
      if (errors && errors.length > 0) {
        toast.danger('保存失败', { description: errors.map((e) => e.message).join('; ') })
        return
      }
      toast.success(form.id ? '角色已更新' : '角色已创建')
      setForm(null)
      setReloadKey((k) => k + 1) // 触发 SynieDataGrid 重挂载刷新
    } catch (e) {
      toast.danger('保存失败', { description: (e as Error).message })
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <h1 className="font-brand text-3xl tracking-wide">角色权限</h1>
      <p className="mt-2 text-sm text-ink-500">管理系统角色与其权限授权。</p>

      <div className="mt-6">
        <SynieDataGrid
          key={reloadKey}
          resource="sysRoles"
          onCreate={() => setForm({ id: null, code: '', name: '', enabled: true })}
          onEdit={(row: Row) =>
            setForm({
              id: row.id,
              code: String(row.code ?? ''),
              name: String(row.name ?? ''),
              enabled: Boolean(row.enabled),
            })
          }
        />
      </div>

      <Sheet isOpen={form !== null} onOpenChange={(open) => !open && setForm(null)} placement="right">
        <Sheet.Backdrop>
          <Sheet.Content className="w-[400px]">
            <Sheet.Dialog className="h-full">
              <Sheet.CloseTrigger />
              <Sheet.Header>
                <Sheet.Heading>{form?.id ? '编辑角色' : '新增角色'}</Sheet.Heading>
              </Sheet.Header>
              {form && (
                <Sheet.Body className="flex flex-col gap-4">
                  <TextField
                    value={form.code}
                    onChange={(v) => setForm({ ...form, code: v })}
                    isDisabled={form.id !== null}
                    isRequired
                  >
                    <Label>角色编码</Label>
                    <Input placeholder="如 purchaser" />
                  </TextField>
                  <TextField value={form.name} onChange={(v) => setForm({ ...form, name: v })} isRequired>
                    <Label>角色名称</Label>
                    <Input placeholder="如 采购管理员" />
                  </TextField>
                  <Switch
                    isSelected={form.enabled}
                    onChange={(selected) => setForm({ ...form, enabled: selected })}
                  >
                    <Switch.Content className="text-sm">
                      <Switch.Control>
                        <Switch.Thumb />
                      </Switch.Control>
                      启用
                    </Switch.Content>
                  </Switch>
                </Sheet.Body>
              )}
              <Sheet.Footer>
                <Sheet.Close>
                  <Button variant="secondary" isDisabled={saving}>取消</Button>
                </Sheet.Close>
                <Button onPress={save} isPending={saving}>保存</Button>
              </Sheet.Footer>
            </Sheet.Dialog>
          </Sheet.Content>
        </Sheet.Backdrop>
      </Sheet>
    </>
  )
}
