import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Chip, Popover } from '@heroui/react'
import { FkLink } from '../synie-record-drawer/fk-preview'
import type { MobileRole } from './card-fields'
import type { EnumChipColor, GridColumnMeta, Row } from './types'

export interface GridImageOverride {
  /** 解析该行的 sys_file id;返回空值回退默认单元格渲染(非图片行)。缺省:列值即 file id */
  fileId?: (row: Row) => string | null | undefined
  /** 预览/下载用文件名;缺省取行上 filename 字段(字符串时) */
  filename?: (row: Row) => string | null | undefined
  /** 缩略图旁保留默认文本渲染(文件名列等);纯 file id 列默认只显示缩略图 */
  keepText?: boolean
}

export interface ColumnOverride {
  render?: (value: unknown, row: Row) => ReactNode
  label?: string
  /** Pro DataGrid 是 auto 布局,th 定宽不生效;此值实际作为文本列 ClampCell 的内容上限(px),
   *  内容收窄列宽即跟着收窄。数值/enum/fk 列暂不受它约束 */
  width?: number
  /** 不传时数值列(integer/decimal)默认右对齐 */
  align?: 'start' | 'center' | 'end'
  /** enum 列胶囊配色,按枚举值(大写 token)映射;未配的值用 default 灰 */
  enumColors?: Record<string, EnumChipColor>
  /** 卡片模式(<lg)下该列的角色;缺省按位置约定(第 1 列标题、第 2 列副标题、第 3-5 列摘要) */
  mobileRole?: MobileRole
  /** 图片列:单元格渲染缩略图,点击全屏预览(SyniePreview),同列图片循环切换;true 即列值为 sys_file id */
  image?: true | GridImageOverride
}

/** 超宽文本单元格:截断收起,溢出时点击弹 Popover 看全文;未溢出就是普通文本。
 * maxWidth 覆盖默认 320px 上限(Pro DataGrid auto 布局下列宽随内容,收内容即收列宽) */
function ClampCell({ text, maxWidth }: { text: string; maxWidth?: number }) {
  const ref = useRef<HTMLSpanElement>(null)
  const [overflow, setOverflow] = useState(false)
  useLayoutEffect(() => {
    const el = ref.current
    if (el) setOverflow(el.scrollWidth > el.clientWidth)
  }, [text])
  const clamp = `block truncate text-start${maxWidth == null ? ' max-w-80' : ''}`
  const style = maxWidth == null ? undefined : { maxWidth }
  if (!overflow) {
    return (
      <span ref={ref} className={clamp} style={style}>
        {text}
      </span>
    )
  }
  return (
    <Popover>
      <Popover.Trigger aria-label="查看完整内容" className={`${clamp} cursor-pointer`} style={style}>
        <span ref={ref} className={clamp} style={style}>
          {text}
        </span>
      </Popover.Trigger>
      <Popover.Content className="max-w-96">
        <Popover.Dialog>
          <p className="whitespace-pre-wrap break-words text-[13px]">{text}</p>
        </Popover.Dialog>
      </Popover.Content>
    </Popover>
  )
}

/** 默认单元格渲染(SynieEditableTable 复用,保持两处表格视觉一致);clampWidth 收窄文本列内容上限 */
export function defaultCell(
  col: GridColumnMeta,
  value: unknown,
  row: Row,
  enumColors?: Record<string, EnumChipColor>,
  clampWidth?: number
): ReactNode {
  // fk 列:link 点开速览抽屉(无 join 时组件内按 id 反查标签);CSV/打印仍走 cellText 纯文本
  if (col.type === 'fk' && col.ref) {
    return <FkLink col={col} row={row} />
  }
  if (value == null || value === '') return <span className="text-muted">—</span>
  switch (col.type) {
    case 'boolean':
      return <Chip size="sm" color={value ? 'success' : 'default'}>{value ? '是' : '否'}</Chip>
    case 'datetime':
      // 日期短且已全表 nowrap,不进 ClampCell,永不截断
      return new Date(String(value)).toLocaleString('zh-CN', { hour12: false })
    case 'integer':
    case 'decimal':
      // 数值短,不进 ClampCell:其 block+text-start 会盖掉 td 因 align:'end' 继承的右对齐
      return String(value)
    case 'enum':
      // enum 默认胶囊展示;配色经 override.enumColors 按值定制,未配的值灰胶囊
      return (
        <Chip size="sm" className="whitespace-nowrap" color={enumColors?.[String(value)] ?? 'default'}>
          {col.enumOptions?.find((o) => o.value === value)?.label ?? String(value)}
        </Chip>
      )
    case 'enumArray': {
      // 枚举数组(如参保类型):胶囊组平铺换行;空数组与空值同显 —
      const tokens = Array.isArray(value) ? (value as string[]) : []
      if (tokens.length === 0) return <span className="text-muted">—</span>
      return (
        <div className="flex flex-wrap gap-1">
          {tokens.map((v) => (
            <Chip key={v} size="sm" className="whitespace-nowrap" color={enumColors?.[v] ?? 'default'}>
              {col.enumOptions?.find((o) => o.value === v)?.label ?? v}
            </Chip>
          ))}
        </div>
      )
    }
    default:
      return <ClampCell text={String(value)} maxWidth={clampWidth} />
  }
}

/** 列内容渲染:override.render 优先,否则 defaultCell;表格/卡片/编辑表三处同口径 */
export function cellContent(
  col: GridColumnMeta,
  row: Row,
  override: ColumnOverride | undefined
): ReactNode {
  return (
    override?.render?.(row[col.name], row) ??
    defaultCell(col, row[col.name], row, override?.enumColors, override?.width)
  )
}
