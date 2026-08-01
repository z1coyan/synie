/** Stable operation keys are caller-owned; facts never infer idempotency from labels. */
export function operationKey(resource: string, recordId: string, operation: string): string {
  for (const value of [resource, recordId, operation]) {
    if (!value.trim() || value.includes('\u0000')) throw new TypeError('operation key 参数不合法')
  }
  return `${resource}\u0000${recordId}\u0000${operation}`
}
