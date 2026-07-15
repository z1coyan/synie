import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Button, toast } from '@heroui/react'
import { gqlFetch } from '~/lib/graphql'
import { uploadFile } from '~/lib/files'

/**
 * 票据 OCR 按钮:选图 → 上传裸文件(暂不挂宿主)→ 调 OCR mutation → 识别字段交调用方回填。
 * 文件 id 一并交回,调用方在单据保存成功后用 attachFile 补挂为附件。
 * 未配置凭证(accOcrConfigured=false)时禁用并就地提示(禁用态没有 hover 事件,不用 Tooltip)。
 */
export interface SynieOcrButtonProps {
  /** OCR mutation 字符串,约定单变量 $input(内含 fileId) */
  mutation: string
  /** 响应字段名,如 'ocrAccVatInvoice' */
  resultKey: string
  /** 文件选择器 accept,如 'image/*,.pdf'(发票)或 'image/*'(承兑) */
  accept: string
  onRecognized: (fields: Record<string, unknown>, fileId: string) => void
}

const OCR_CONFIGURED = `query { accOcrConfigured }`

export function SynieOcrButton({ mutation, resultKey, accept, onRecognized }: SynieOcrButtonProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  // 识别在途中抽屉被关(组件卸载)后 promise 才 resolve 的竞态守卫:
  // 卸载后不再调 onRecognized/setBusy/弹 toast,防止把旧 fileId/字段写进下一张单据
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const configured = useQuery({
    queryKey: ['accOcrConfigured'],
    queryFn: () =>
      gqlFetch<{ accOcrConfigured: boolean }>(OCR_CONFIGURED).then((d) => d.accOcrConfigured),
  })

  const handleFile = async (files: FileList | null) => {
    const file = files?.[0]
    if (!file) return
    setBusy(true)
    const toastId = toast('正在识别…', { isLoading: true, timeout: 0 })
    try {
      const { file: uploaded } = await uploadFile(file)
      const data = await gqlFetch<Record<string, unknown>>(mutation, { input: { fileId: uploaded.id } })
      if (!mountedRef.current) return
      // :map 返回按 JSON 标量下发;防御性兼容字符串形态(同 items json_string 先例)
      const raw = data[resultKey]
      const fields = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Record<string, unknown> | null
      if (!fields || Object.keys(fields).length === 0) {
        toast.warning('未识别出票面内容,请人工录入')
        return
      }
      onRecognized(fields, uploaded.id)
      toast.success('识别完成,请核对回填内容')
    } catch (e) {
      if (!mountedRef.current) return
      toast.danger('识别失败', { description: (e as Error).message })
    } finally {
      toast.close(toastId)
      if (!mountedRef.current) return
      setBusy(false)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  const disabled = configured.data === false
  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* 文件选择必须走原生 input,隐藏后由 Button 代理触发(同 SynieAttachmentPanel) */}
      <input ref={inputRef} type="file" accept={accept} hidden onChange={(e) => handleFile(e.target.files)} />
      <Button
        size="sm"
        variant="secondary"
        isPending={busy}
        isDisabled={disabled}
        onPress={() => inputRef.current?.click()}
      >
        <ScanIcon />
        上传识别
      </Button>
      {disabled && (
        <span className="text-xs text-muted">未配置 OCR 凭证,请到「系统管理→财务设置」配置</span>
      )}
    </div>
  )
}

// 项目无图标库,与 SynieAttachmentPanel 同款手写内联 SVG
function ScanIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
      <path d="M2 5V3.5A1.5 1.5 0 0 1 3.5 2H5M11 2h1.5A1.5 1.5 0 0 1 14 3.5V5M14 11v1.5a1.5 1.5 0 0 1-1.5 1.5H11M5 14H3.5A1.5 1.5 0 0 1 2 12.5V11M2 8h12" />
    </svg>
  )
}
