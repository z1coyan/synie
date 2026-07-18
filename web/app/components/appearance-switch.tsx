import {
  APPEARANCE_LABELS,
  APPEARANCE_MODES,
  type AppearanceMode,
} from '~/lib/appearance'
import { useAppearance } from '~/lib/use-appearance'

type AppearanceSwitchProps = {
  /** sm:登录/向导弱入口; md:用户菜单 */
  size?: 'sm' | 'md'
  className?: string
}

/**
 * 外观模式三选一(白天 / 系统 / 黑夜)。
 * 本机持久化,无后端。
 */
export function AppearanceSwitch({
  size = 'md',
  className = '',
}: AppearanceSwitchProps) {
  const { mode, setMode } = useAppearance()
  const compact = size === 'sm'

  return (
    <div
      role="radiogroup"
      aria-label="外观模式"
      className={`inline-flex rounded-lg border border-ink-900/12 p-0.5 ${className}`}
    >
      {APPEARANCE_MODES.map((m) => (
        <AppearanceOption
          key={m}
          mode={m}
          selected={mode === m}
          compact={compact}
          onSelect={setMode}
        />
      ))}
    </div>
  )
}

function AppearanceOption({
  mode,
  selected,
  compact,
  onSelect,
}: {
  mode: AppearanceMode
  selected: boolean
  compact: boolean
  onSelect: (mode: AppearanceMode) => void
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={() => onSelect(mode)}
      className={[
        'rounded-md font-medium transition-colors',
        compact ? 'px-2 py-0.5 text-[11px]' : 'px-2.5 py-1 text-xs',
        selected
          ? 'bg-ink-900 text-porcelain shadow-sm'
          : 'text-ink-500 hover:text-ink-900',
      ].join(' ')}
    >
      {APPEARANCE_LABELS[mode]}
    </button>
  )
}
