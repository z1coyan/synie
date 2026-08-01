import { useEffect, useRef, useState } from 'react'
import { Button, Label, ListBox, Modal, Select, toast } from '@heroui/react'
import { useQuery as useConvexQuery } from 'convex/react'
import {
  downloadSignedUrl,
  exportTemplateXlsx,
  fetchPrintResultUrl,
  fetchPrintTemplates,
  openPdfUrl,
  printErrorMessage,
  startTemplatePrint,
  type PrintTemplateOption,
} from '~/lib/print'
import { api } from '~/lib/convex-api'
import type { Row } from '~/components/synie-data-grid/types'

export function useTemplatePrint(resource: string) {
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<'print' | 'export'>('print')
  const [rows, setRows] = useState<Row[]>([])
  const [templates, setTemplates] = useState<PrintTemplateOption[]>([])
  const [templateId, setTemplateId] = useState<string>('')
  const [loading, setLoading] = useState(false)
  const [loadingList, setLoadingList] = useState(false)
  const [jobId, setJobId] = useState<string | null>(null)
  const [jobError, setJobError] = useState<string | null>(null)
  const previewWindow = useRef<Window | null>(null)
  const handledJob = useRef<string | null>(null)
  const storageKey = `synie:active-print:${resource}`
  const job = useConvexQuery(
    api.platform.printing.jobs.getJob,
    jobId ? { id: jobId as never } : 'skip',
  ) as { status?: string; errorCode?: string | null; attempts?: number } | undefined

  useEffect(() => {
    const saved = window.sessionStorage.getItem(storageKey)
    if (!saved) return
    setMode('print')
    setJobId(saved)
    setOpen(true)
    setLoading(true)
  }, [storageKey])

  useEffect(() => {
    if (!jobId || !job?.status) return
    if (job.status === 'succeeded' && handledJob.current !== `${jobId}:succeeded`) {
      handledJob.current = `${jobId}:succeeded`
      void fetchPrintResultUrl(jobId)
        .then(({ url }) => {
          if (previewWindow.current && !previewWindow.current.closed) {
            previewWindow.current.opener = null
            previewWindow.current.location.href = url
          } else if (!openPdfUrl(url)) {
            toast.danger('打印预览被浏览器拦截', { description: '请允许弹窗后重试' })
            return
          }
          toast.success('已打开打印预览')
          window.sessionStorage.removeItem(storageKey)
          setJobId(null)
          setOpen(false)
          setLoading(false)
        })
        .catch((error: unknown) => {
          setLoading(false)
          toast.danger(error instanceof Error ? error.message : '获取打印结果失败')
        })
    }
    if ((job.status === 'failed' || job.status === 'expired') && handledJob.current !== `${jobId}:failed`) {
      handledJob.current = `${jobId}:failed`
      const message = job.status === 'expired' ? '打印任务已过期，请重新发起' : printErrorMessage(job.errorCode)
      setJobError(message)
      setLoading(false)
      window.sessionStorage.removeItem(storageKey)
      previewWindow.current?.close()
      previewWindow.current = null
      toast.danger(message)
    }
  }, [job?.errorCode, job?.status, jobId, storageKey])

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
    setJobError(null)
    setOpen(true)
    setLoadingList(true)
    try {
      const list = await fetchPrintTemplates(resource)
      setTemplates(list)
      const preferred = list.find((template) => template.isDefault) ?? list[0]
      setTemplateId(preferred?.id ?? '')
      if (list.length === 0) {
        toast.warning('尚无可用打印模板', {
          description: '请到「系统管理 → 打印模板」上传后再试',
        })
      }
    } catch (error) {
      toast.danger(error instanceof Error ? error.message : '加载模板失败')
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
    setJobError(null)
    const requestNonce = crypto.randomUUID()
    try {
      if (mode === 'export') {
        const result = await exportTemplateXlsx({
          resource,
          ids: rows.map((row) => String(row.id)),
          templateId,
          requestNonce,
        })
        downloadSignedUrl(result.url, result.filename)
        toast.success('已开始下载 Excel')
        setOpen(false)
        setLoading(false)
        return
      }
      previewWindow.current = window.open('about:blank', '_blank')
      const result = await startTemplatePrint({
        resource,
        ids: rows.map((row) => String(row.id)),
        templateId,
        requestNonce,
      })
      handledJob.current = null
      setJobId(result.id)
      window.sessionStorage.setItem(storageKey, result.id)
    } catch (error) {
      previewWindow.current?.close()
      previewWindow.current = null
      setLoading(false)
      toast.danger(error instanceof Error ? error.message : '操作失败')
    }
  }

  const working = jobId && ['queued', 'running', 'retryable'].includes(job?.status ?? 'queued')
  const statusText = job?.status === 'running'
    ? `正在生成 PDF（第 ${job.attempts ?? 1} 次尝试）…`
    : job?.status === 'retryable'
      ? '转换暂时失败，正在等待自动重试…'
      : '打印任务已排队…'

  const dialog = (
    <Modal.Backdrop isOpen={open} onOpenChange={setOpen}>
      <Modal.Container>
        <Modal.Dialog className="max-w-md">
          <Modal.Header>
            <Modal.Heading>{mode === 'print' ? '模板打印' : '导出 Excel'}</Modal.Heading>
          </Modal.Header>
          <Modal.Body className="space-y-3">
            {working ? (
              <p className="text-sm text-muted">{statusText}</p>
            ) : (
              <>
                <p className="text-sm text-muted">
                  已选 {rows.length} 条单据
                  {mode === 'print' ? '，将生成 PDF 预览' : '，将下载填充后的 xlsx'}
                </p>
                {jobError && <p className="text-sm text-danger">{jobError}</p>}
                {loadingList ? (
                  <p className="text-sm">加载模板…</p>
                ) : templates.length === 0 ? (
                  <p className="text-sm text-danger">无可用模板，请先到系统管理上传</p>
                ) : (
                  <div className="flex flex-col gap-1">
                    <Label>打印模板</Label>
                    <Select selectedKey={templateId} onSelectionChange={(key) => setTemplateId(String(key))} aria-label="打印模板">
                      <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
                      <Select.Popover>
                        <ListBox>
                          {templates.map((template) => (
                            <ListBox.Item key={template.id} id={template.id} textValue={template.name}>
                              {template.name}{template.isDefault ? '（默认）' : ''}
                              <ListBox.ItemIndicator />
                            </ListBox.Item>
                          ))}
                        </ListBox>
                      </Select.Popover>
                    </Select>
                  </div>
                )}
              </>
            )}
          </Modal.Body>
          <Modal.Footer>
            <Button variant="secondary" onPress={() => setOpen(false)}>关闭</Button>
            {!working && (
              <Button
                variant="primary"
                isDisabled={!templateId || loading || templates.length === 0}
                isPending={loading}
                onPress={() => void confirm()}
              >
                {mode === 'print' ? '打印' : '导出'}
              </Button>
            )}
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  )

  return { start, dialog }
}
