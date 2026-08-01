import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Button, toast } from '@heroui/react'
import { uploadFile, type UploadedFile } from '~/lib/files'
import { getAccountingOCRConfigured } from '~/lib/resources/settings'

interface Props {
  recognize: (fileId: string) => Promise<Record<string, unknown>>
  accept: string
  label?: string
  variant?: 'primary' | 'secondary'
  onRecognized: (
    fields: Record<string, unknown>,
    file: UploadedFile,
  ) => void
}

export function FinanceOcrButton({
  recognize,
  accept,
  label = '上传识别',
  variant = 'secondary',
  onRecognized,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const mountedRef = useRef(true)
  const [busy, setBusy] = useState(false)
  const configured = useQuery({
    queryKey: ['accOcrConfigured'],
    queryFn: () => getAccountingOCRConfigured().then((result) => result.configured),
  })

  useEffect(
    () => () => {
      mountedRef.current = false
    },
    [],
  )

  const handleFile = async (files: FileList | null) => {
    const file = files?.[0]
    if (!file) return
    setBusy(true)
    const toastId = toast('正在识别…', { isLoading: true, timeout: 0 })
    try {
      const { file: uploaded } = await uploadFile(file)
      const fields = await recognize(uploaded.id)
      if (!mountedRef.current) return
      if (Object.keys(fields).length === 0) {
        toast.warning('未识别出票面内容,请人工录入')
        return
      }
      onRecognized(fields, uploaded)
      toast.success('识别完成,请核对回填内容')
    } catch (error) {
      if (mountedRef.current) {
        toast.danger('识别失败', {
          description: (error as Error).message,
        })
      }
    } finally {
      toast.close(toastId)
      if (mountedRef.current) {
        setBusy(false)
        if (inputRef.current) inputRef.current.value = ''
      }
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        hidden
        onChange={(event) => void handleFile(event.target.files)}
      />
      <Button
        size="sm"
        variant={variant}
        isPending={busy}
        isDisabled={configured.data === false}
        onPress={() => inputRef.current?.click()}
      >
        {label}
      </Button>
      {configured.data === false && (
        <span className="text-xs text-muted">
          未配置 OCR 凭证,请到「财务→财务设置」配置
        </span>
      )}
    </div>
  )
}
