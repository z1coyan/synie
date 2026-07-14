import { useEffect, useState } from 'react'
import { toast } from '@heroui/react'
import { DropZone } from '@heroui-pro/react'
import { gqlFetch } from '~/lib/graphql'
import { uploadFile } from '~/lib/files'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import { RemoteSelect } from '~/components/synie-remote-select/RemoteSelect'
import { CREATE_BANK_IMPORT, throwOnErrors, type ParseResult } from './mutations'

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export interface BankImportCreateDrawerProps {
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  /** 解析(create)成功后回调,页面据此打开导入记录抽屉查看结果 */
  onParsed: (result: ParseResult) => void
}

/**
 * 新增导入抽屉:公司 → 银行账户 → 导入模板(按账户过滤)+ xlsx 文件,
 * 「解析」即提交——后端 create 同步解析入导入行表,成败都落导入记录。
 */
export function BankImportCreateDrawer({ isOpen, onOpenChange, onParsed }: BankImportCreateDrawerProps) {
  const [file, setFile] = useState<File | null>(null)

  // 每次打开清残留的上次选择
  useEffect(() => {
    if (isOpen) setFile(null)
  }, [isOpen])

  const pickFile = (candidate: File) => {
    if (!candidate.name.toLowerCase().endsWith('.xlsx')) {
      toast.danger('仅支持 xlsx 文件', { description: 'xls 请用 Excel 另存为 xlsx 后重试' })
      return
    }
    setFile(candidate)
  }

  return (
    <SynieRecordDrawer
      resource="accBankImports"
      label="流水导入"
      mode="create"
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      contentClassName="w-full lg:w-[720px]"
      submitLabel="解析"
      exclude={['status', 'error', 'importedAt', 'importedById', 'createdById', 'fileId', 'itemCount', 'errorCount']}
      fields={{
        // 公司在前(账户/模板候选依赖它);换公司清空下游选择
        companyId: { required: true, order: -1, effects: () => ({ bankAccountId: null, templateId: null }) },
        bankAccountId: {
          order: 1,
          required: true,
          effects: () => ({ templateId: null }),
          input: ({ value, onChange, isDisabled, values }) => {
            const companyId = (values.companyId ?? null) as string | null
            return (
              <RemoteSelect
                resource="accBankAccounts"
                label="银行账户"
                // 直连资源(非 fk ref 反射),显示字段须显式给(缺省 name 拼出非法查询)
                labelField="alias"
                searchFields={['alias', 'accountNo']}
                placeholder={companyId ? '选择账户…' : '先选择公司'}
                value={value == null ? null : String(value)}
                onChange={(id) => onChange(id)}
                isDisabled={isDisabled || companyId == null}
                filter={`{companyId: {eq: ${JSON.stringify(companyId)}}, active: {eq: true}}`}
              />
            )
          },
        },
        templateId: {
          order: 2,
          required: true,
          input: ({ value, onChange, isDisabled, values }) => {
            const bankAccountId = (values.bankAccountId ?? null) as string | null
            return (
              <RemoteSelect
                resource="accBankImportTemplates"
                label="导入模板"
                labelField="name"
                searchFields={['name']}
                placeholder={bankAccountId ? '选择该账户的导入模板…' : '先选择银行账户'}
                value={value == null ? null : String(value)}
                onChange={(id) => onChange(id)}
                isDisabled={isDisabled || bankAccountId == null}
                filter={`{bankAccountId: {eq: ${JSON.stringify(bankAccountId)}}}`}
              />
            )
          },
        },
      }}
      extraContent={(mode) =>
        mode === 'create' ? (
          <DropZone>
            <DropZone.Area
              onDrop={async (e) => {
                for (const item of e.items) {
                  if (item.kind === 'file') {
                    pickFile(await item.getFile())
                    return
                  }
                }
              }}
            >
              <DropZone.Icon />
              <DropZone.Label>拖拽银行导出文件到此处,或点击选择</DropZone.Label>
              <DropZone.Description>仅支持 xlsx;列布局须与所选导入模板一致</DropZone.Description>
              <DropZone.Trigger>选择文件</DropZone.Trigger>
            </DropZone.Area>
            <DropZone.Input accept=".xlsx" onSelect={(list) => list[0] && pickFile(list[0])} />
            {file && (
              <DropZone.FileList>
                <DropZone.FileItem status="complete">
                  <DropZone.FileFormatIcon color="green" format="XLSX" />
                  <DropZone.FileInfo>
                    <DropZone.FileName>{file.name}</DropZone.FileName>
                    <DropZone.FileMeta>{formatFileSize(file.size)}</DropZone.FileMeta>
                  </DropZone.FileInfo>
                  <DropZone.FileRemoveTrigger aria-label={`移除 ${file.name}`} onPress={() => setFile(null)} />
                </DropZone.FileItem>
              </DropZone.FileList>
            )}
          </DropZone>
        ) : null
      }
      onSubmit={async (values) => {
        if (!file) throw new Error('请上传导入文件(xlsx)')

        // 先传文件字节(REST),拿到 fileId 再建导入记录;create 失败会留下孤儿文件,可接受(spec 跟进项)
        const uploaded = await uploadFile(file)

        const data = await gqlFetch<{
          createAccBankImport: { result: ParseResult | null; errors: { message: string }[] | null }
        }>(CREATE_BANK_IMPORT, { input: { ...values, fileId: uploaded.file.id } })
        throwOnErrors(data.createAccBankImport.errors)

        const result = data.createAccBankImport.result!
        if (result.status === 'FAILED') {
          // 解析失败也算记录建成:不抛错(抛错不关抽屉且暗示可重试),开记录抽屉看原因
          toast.danger('解析失败', { description: result.error ?? '请检查文件与模板配置' })
        } else if (result.errorCount > 0) {
          toast.warning(`解析完成:共 ${result.itemCount} 行,${result.errorCount} 行有错误`, {
            description: '修正或删除错误行后才能导入',
          })
        } else {
          toast.success(`解析完成:共 ${result.itemCount} 行,可以导入`)
        }
        onParsed(result)
      }}
    />
  )
}
