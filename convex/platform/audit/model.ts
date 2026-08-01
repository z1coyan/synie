export const AUDIT_MAX_BYTES = 64 * 1024
const REDACTED = '[REDACTED]'

function sensitiveKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase()
  return (
    normalized.includes('password') ||
    normalized.includes('secret') ||
    normalized.includes('token') ||
    normalized.includes('credential') ||
    normalized === 'email' ||
    normalized.endsWith('email')
  )
}

export function redactAuditValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value)) return '[CIRCULAR]'
  seen.add(value)
  if (Array.isArray(value)) return value.map((item) => redactAuditValue(item, seen))
  const result: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    result[key] = sensitiveKey(key) ? REDACTED : redactAuditValue(child, seen)
  }
  return result
}

export function changedFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Record<string, { before: unknown; after: unknown }> {
  const result: Record<string, { before: unknown; after: unknown }> = {}
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (!Object.is(before[key], after[key])) result[key] = { before: before[key], after: after[key] }
  }
  return result
}

export function boundedAuditChanges(changes: unknown): { changes: unknown; truncated: boolean } {
  const redacted = redactAuditValue(changes)
  const encoded = JSON.stringify(redacted)
  if (new TextEncoder().encode(encoded).byteLength <= AUDIT_MAX_BYTES) {
    return { changes: redacted, truncated: false }
  }
  const fields =
    redacted && typeof redacted === 'object' && !Array.isArray(redacted)
      ? Object.keys(redacted as Record<string, unknown>).sort()
      : []
  return {
    changes: { summary: '审计变更超过单文档安全阈值', fields, originalBytes: encoded.length },
    truncated: true,
  }
}
