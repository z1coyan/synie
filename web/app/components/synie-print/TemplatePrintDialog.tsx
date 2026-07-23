import { useState } from 'react'
import { Button, Label, ListBox, Modal, Select, toast } from '@heroui/react'
import {
  downloadBlob,
  fetchPrintTemplates,
  openPdfBlob,
  runTemplateOutput,
  type PrintTemplateOption,
} from '~/lib/print'
import type { Row } from '~/components/synie-data-grid/types'

export function useTemplatePrint(resource: string) {
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<'print' | 'export'>('print')
  const [rows, setRows] = useState<Row[]>([])
  const [templates, setTemplates] = useState<PrintTemplateOption[]>([])
  const [templateId, setTemplateId] = useState<string>('')
  const [loading, setLoading] = useState(false)
  const [loadingList, setLoadingList] = useState(false)

  const start = async (nextMode: 'print' | 'export', selected: Row[]) => {
    if (selected.length === 0) {
      toast.warning('请先选择单据')
      return
    }
    if (selected.length > 100) {
      toast.danger('单次最多处理 100 条')
      return
    }
    setMode(nextMode)
    setRows(selected)
    setOpen(true)
    setLoadingList(true)
    try {
      const list = await fetchPrintTemplates(resource)
      setTemplates(list)
      const def = list.find((t) => t.isDefault) ?? list[0]
      setTemplateId(def?.id ?? '')
      if (list.length === 0) {
        toast.warning('尚无可用打印模板', {
          description: '请到「系统管理 → 打印模板」上传后再试',
        })
      }
    } catch (e) {
      toast.danger(e instanceof Error ? e.message : '加载模板失败')
      setOpen(false)
    } finally {
      setLoadingList(false)
    }
  }

  const confirm = async () => {
    if (!templateId) {
      toast.warning('请选择模板')
      return
    }
    setLoading(true)
    try {
      const { blob, filename } = await runTemplateOutput({
        resource,
        ids: rows.map((r) => String(r.id)),
        templateId,
        mode,
      })
      if (mode === 'print') {
        if (!openPdfBlob(blob)) {
          toast.danger('打印预览被浏览器拦截', { description: '请允许弹窗后重试' })
        } else {
          toast.success('已打开打印预览')
        }
      } else {
        downloadBlob(blob, filename)
        toast.success('已开始下载 Excel')
      }
      setOpen(false)
    } catch (e) {
      toast.danger(e instanceof Error ? e.message : '操作失败')
    } finally {
      setLoading(false)
    }
  }

  const dialog = (
    <Modal.Backdrop isOpen={open} onOpenChange={setOpen}>
      <Modal.Container>
        <Modal.Dialog className="max-w-md">
          <Modal.Header>
            <Modal.Heading>{mode === 'print' ? '模板打印' : '导出 Excel'}</Modal.Heading>
          </Modal.Header>
          <Modal.Body className="space-y-3">
            <p className="text-sm text-muted">
              已选 {rows.length} 条单据
              {mode === 'print' ? '，将生成 PDF 预览' : '，将下载填充后的 xlsx'}
            </p>
            {loadingList ? (
              <p className="text-sm">加载模板…</p>
            ) : templates.length === 0 ? (
              <p className="text-sm text-danger">无可用模板，请先到系统管理上传</p>
            ) : (
              <div className="flex flex-col gap-1">
                <Label>打印模板</Label>
                <Select
                  selectedKey={templateId}
                  onSelectionChange={(k) => setTemplateId(String(k))}
                  aria-label="打印模板"
                >
                  <Select.Trigger>
                    <Select.Value />
                    <Select.Indicator />
                  </Select.Trigger>
                  <Select.Popover>
                    <ListBox>
                      {templates.map((t) => (
                        <ListBox.Item key={t.id} id={t.id} textValue={t.name}>
                          {t.name}
                          {t.isDefault ? '（默认）' : ''}
                          <ListBox.ItemIndicator />
                        </ListBox.Item>
                      ))}
                    </ListBox>
                  </Select.Popover>
                </Select>
              </div>
            )}
          </Modal.Body>
          <Modal.Footer>
            <Button variant="secondary" onPress={() => setOpen(false)}>
              取消
            </Button>
            <Button
              variant="primary"
              isDisabled={!templateId || loading || templates.length === 0}
              isPending={loading}
              onPress={() => void confirm()}
            >
              {mode === 'print' ? '打印' : '导出'}
            </Button>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  )

  return { start, dialog }
}
