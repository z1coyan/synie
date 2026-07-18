/** 外观模式:本机色阶偏好(白天/系统/黑夜)。见 docs/glossary.md */

export type AppearanceMode = 'light' | 'dark' | 'system'
export type ResolvedAppearance = 'light' | 'dark'

export const APPEARANCE_STORAGE_KEY = 'synie.appearance'
export const APPEARANCE_EVENT = 'synie-appearance'

export const APPEARANCE_LABELS: Record<AppearanceMode, string> = {
  light: '白天',
  system: '系统',
  dark: '黑夜',
}

export const APPEARANCE_MODES: AppearanceMode[] = ['light', 'system', 'dark']

export function isAppearanceMode(value: unknown): value is AppearanceMode {
  return value === 'light' || value === 'dark' || value === 'system'
}

export function readAppearanceMode(): AppearanceMode {
  if (typeof window === 'undefined') return 'system'
  try {
    const raw = localStorage.getItem(APPEARANCE_STORAGE_KEY)
    return isAppearanceMode(raw) ? raw : 'system'
  } catch {
    return 'system'
  }
}

export function resolveAppearance(mode: AppearanceMode): ResolvedAppearance {
  if (mode === 'light' || mode === 'dark') return mode
  if (typeof window === 'undefined') return 'light'
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

/** 把解析后的色阶挂到 documentElement(class + data-theme + color-scheme) */
export function applyResolvedAppearance(resolved: ResolvedAppearance): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  root.classList.toggle('dark', resolved === 'dark')
  root.dataset.theme = resolved
  root.style.colorScheme = resolved
}

export function setAppearanceMode(mode: AppearanceMode): void {
  try {
    localStorage.setItem(APPEARANCE_STORAGE_KEY, mode)
  } catch {
    // private mode / quota — still apply in-session
  }
  applyResolvedAppearance(resolveAppearance(mode))
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(APPEARANCE_EVENT, { detail: mode }))
  }
}

/**
 * 阻塞式防闪脚本:在 React hydrate 前读本机键并挂 class/data-theme。
 * 必须与 APPEARANCE_STORAGE_KEY / resolve 语义保持一致。
 */
export const APPEARANCE_FOUC_SCRIPT = `(function(){try{var k=${JSON.stringify(APPEARANCE_STORAGE_KEY)};var m=localStorage.getItem(k);if(m!=="light"&&m!=="dark"&&m!=="system")m="system";var r=m==="system"?(matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"):m;var el=document.documentElement;if(r==="dark")el.classList.add("dark");else el.classList.remove("dark");el.setAttribute("data-theme",r);el.style.colorScheme=r}catch(e){}})();`
