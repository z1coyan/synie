const MAX_USERNAME_CODE_POINTS = 64

export function normalizeUsername(value: string): string {
  return value.trim().toLowerCase()
}

export function validateUsername(value: string): string | null {
  const trimmed = value.trim()
  const length = [...trimmed].length
  if (length < 1 || length > MAX_USERNAME_CODE_POINTS) {
    return '不能为空且长度不能超过 64'
  }
  return null
}

export function isValidPluginUsername(value: string): boolean {
  const length = [...value].length
  return value === value.trim() && length >= 1 && length <= MAX_USERNAME_CODE_POINTS
}
