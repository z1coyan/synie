import type { SynieErrorCode, SynieErrorData } from '../lib/errors'

const DETERMINISTIC_FINALIZE_CODES = new Set<SynieErrorCode>([
  'validation',
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
])

function errorData(value: unknown, depth = 0): SynieErrorData | null {
  if (!value || typeof value !== 'object' || depth > 2) return null
  const candidate = value as {
    code?: unknown
    message?: unknown
    data?: unknown
    cause?: unknown
  }
  if (
    typeof candidate.code === 'string' &&
    typeof candidate.message === 'string' &&
    [
      'validation', 'unauthorized', 'forbidden', 'not_found',
      'conflict', 'rate_limited', 'internal',
    ].includes(candidate.code)
  ) {
    return candidate as SynieErrorData
  }
  return errorData(candidate.data, depth + 1) ?? errorData(candidate.cause, depth + 1)
}

function serializedErrorCode(error: unknown): SynieErrorCode | null {
  if (!(error instanceof Error)) return null
  const match = error.message.match(
    /["']code["']\s*:\s*["'](validation|unauthorized|forbidden|not_found|conflict|rate_limited|internal)["']/,
  )
  return (match?.[1] as SynieErrorCode | undefined) ?? null
}

/**
 * A deterministic application rejection means the finalize mutation aborted,
 * so the copied S3 object is safe to remove. Internal/rate-limit failures may
 * have an ambiguous commit result and must retain the object for idempotent retry.
 */
export function isDeterministicFinalizeRejection(error: unknown): boolean {
  const code = errorData(error)?.code ?? serializedErrorCode(error)
  return code !== null && DETERMINISTIC_FINALIZE_CODES.has(code)
}

/** Attempt every exact key; the caller may close the intent only after all
 * deletes succeed. A rejected delete keeps the intent pending for durable
 * expiry cleanup or an idempotent user retry. */
export async function deleteRejectedUploadObjects(
  keys: readonly string[],
  remove: (key: string) => Promise<unknown>,
): Promise<boolean> {
  const uniqueKeys = [...new Set(keys)]
  const results = await Promise.allSettled(uniqueKeys.map((key) => remove(key)))
  return results.every((result) => result.status === 'fulfilled')
}
