import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Button,
  Input,
  Label,
  Modal,
  Table,
  TextField,
  toast,
} from '@heroui/react'
import {
  createApiKey,
  listApiKeys,
  revokeApiKey,
  type CreatedUserApiKey,
  type UserApiKey,
} from '~/lib/api/api-keys'
import { toastError } from '~/lib/toast'

export const Route = createFileRoute('/_app/account/api-keys')({
  component: ApiKeysPage,
})

const QUERY_KEY = ['account', 'api-keys'] as const

function formatInstant(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('zh-CN', { hour12: false })
}

function legacyCopy(text: string) {
  const ta = document.createElement('textarea')
  ta.value = text
  ta.style.position = 'fixed'
  ta.style.opacity = '0'
  document.body.appendChild(ta)
  ta.select()
  const ok = document.execCommand('copy')
  document.body.removeChild(ta)
  if (!ok) throw new Error('execCommand copy failed')
}

async function copyText(text: string) {
  if (window.isSecureContext && navigator.clipboard) {
    await navigator.clipboard.writeText(text)
    return
  }
  legacyCopy(text)
}

function ApiKeysPage() {
  const queryClient = useQueryClient()
  const list = useQuery({ queryKey: QUERY_KEY, queryFn: listApiKeys })
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [expiresOn, setExpiresOn] = useState('')
  const [created, setCreated] = useState<CreatedUserApiKey | null>(null)
  const [revokeTarget, setRevokeTarget] = useState<UserApiKey | null>(null)

  const createMut = useMutation({
    mutationFn: () =>
      createApiKey({
        name,
        expiresAt: expiresOn.trim() === '' ? null : expiresOn.trim(),
      }),
    onSuccess: (key) => {
      setCreating(false)
      setName('')
      setExpiresOn('')
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY })
      queueMicrotask(() => setCreated(key))
    },
    onError: toastError('创建密钥失败'),
  })

  const revokeMut = useMutation({
    mutationFn: (id: string) => revokeApiKey(id),
    onSuccess: () => {
      setRevokeTarget(null)
      toast.success('密钥已撤销')
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY })
    },
    onError: toastError('撤销密钥失败'),
  })

  const copyToken = async () => {
    if (!created) return
    try {
      await copyText(created.token)
      toast.success('已复制到剪贴板')
    } catch {
      toast.danger('复制失败,请手动选中密钥复制')
    }
  }

  const rows = list.data?.results ?? []

  return (
    <>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="font-brand text-xl">API 密钥</h1>
          <p className="mt-1 max-w-2xl text-xs text-ink-500">
            给外部 AI（Grok、Cursor 等）签发可撤销凭证。请求头使用{' '}
            <code className="rounded bg-ink-900/5 px-1">Authorization: Bearer &lt;密钥&gt;</code>
            ，权限与登录后的你相同。明文只在创建时显示一次；泄露请立即撤销。
          </p>
        </div>
        <Button onPress={() => setCreating(true)}>新建密钥</Button>
      </div>

      <div className="mt-6">
        {list.isError ? (
          <p className="text-sm text-danger">
            {list.error instanceof Error ? list.error.message : '加载失败'}
          </p>
        ) : rows.length === 0 && !list.isPending ? (
          <p className="text-sm text-ink-500">还没有密钥。新建后即可把明文配进 AI 工具。</p>
        ) : (
          <Table>
            <Table.Content aria-label="个人 API 密钥">
              <Table.Header>
                <Table.Column>名称</Table.Column>
                <Table.Column>密钥提示</Table.Column>
                <Table.Column>创建时间</Table.Column>
                <Table.Column>最后使用</Table.Column>
                <Table.Column>过期时间</Table.Column>
                <Table.Column className="w-24">操作</Table.Column>
              </Table.Header>
              <Table.Body>
                {rows.map((row) => (
                  <Table.Row key={row.id}>
                    <Table.Cell>{row.name}</Table.Cell>
                    <Table.Cell>
                      <code className="font-mono text-xs">{row.tokenHint}…</code>
                    </Table.Cell>
                    <Table.Cell>{formatInstant(row.insertedAt)}</Table.Cell>
                    <Table.Cell>{formatInstant(row.lastUsedAt)}</Table.Cell>
                    <Table.Cell>
                      {row.expiresAt ? formatInstant(row.expiresAt) : '不过期'}
                    </Table.Cell>
                    <Table.Cell>
                      <Button
                        size="sm"
                        variant="danger"
                        onPress={() => setRevokeTarget(row)}
                      >
                        撤销
                      </Button>
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Content>
          </Table>
        )}
      </div>

      <Modal.Backdrop isOpen={creating} onOpenChange={(open) => !open && setCreating(false)}>
        <Modal.Container>
          <Modal.Dialog>
            <Modal.Header>
              <Modal.Heading>新建 API 密钥</Modal.Heading>
            </Modal.Header>
            <Modal.Body className="flex flex-col gap-3">
              <TextField value={name} onChange={setName} isRequired>
                <Label>名称</Label>
                <Input placeholder="如 Grok、本机 Cursor" maxLength={64} />
              </TextField>
              <TextField value={expiresOn} onChange={setExpiresOn}>
                <Label>过期日期（可选）</Label>
                <Input type="date" />
              </TextField>
              <p className="text-xs text-ink-500">留空表示不过期。当天结束（UTC）后失效。</p>
            </Modal.Body>
            <Modal.Footer>
              <Button variant="secondary" onPress={() => setCreating(false)}>
                取消
              </Button>
              <Button
                isPending={createMut.isPending}
                isDisabled={name.trim() === ''}
                onPress={() => createMut.mutate()}
              >
                创建
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>

      <Modal.Backdrop
        isOpen={created !== null}
        onOpenChange={(open) => !open && setCreated(null)}
      >
        <Modal.Container>
          <Modal.Dialog>
            <Modal.Header>
              <Modal.Heading>一次性密钥</Modal.Heading>
            </Modal.Header>
            <Modal.Body>
              <p className="text-sm">
                密钥 <span className="font-medium">{created?.name}</span> 已创建。
                <span className="text-danger">明文只显示这一次</span>
                ，关闭后无法再查看，请立即复制并妥善保存。
              </p>
              <div className="mt-3 flex items-center gap-2">
                <code className="flex-1 break-all rounded-md border border-ink-900/10 bg-ink-900/5 px-3 py-2 font-mono text-xs select-all">
                  {created?.token}
                </code>
                <Button variant="secondary" onPress={copyToken}>
                  复制
                </Button>
              </div>
            </Modal.Body>
            <Modal.Footer>
              <Button onPress={() => setCreated(null)}>我已保存密钥</Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>

      <Modal.Backdrop
        isOpen={revokeTarget !== null}
        onOpenChange={(open) => !open && setRevokeTarget(null)}
      >
        <Modal.Container>
          <Modal.Dialog>
            <Modal.Header>
              <Modal.Heading>撤销密钥</Modal.Heading>
            </Modal.Header>
            <Modal.Body>
              <p className="text-sm">
                撤销 <span className="font-medium">{revokeTarget?.name}</span>（
                <code className="font-mono text-xs">{revokeTarget?.tokenHint}…</code>
                ）后，使用该密钥的 AI 将立即无法访问。是否继续？
              </p>
            </Modal.Body>
            <Modal.Footer>
              <Button variant="secondary" onPress={() => setRevokeTarget(null)}>
                取消
              </Button>
              <Button
                variant="danger"
                isPending={revokeMut.isPending}
                onPress={() => revokeTarget && revokeMut.mutate(revokeTarget.id)}
              >
                确认撤销
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </>
  )
}
