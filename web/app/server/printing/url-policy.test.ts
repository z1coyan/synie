import { afterEach, describe, expect, test } from 'bun:test'
import { assertPrintObjectUrl } from './url-policy'

const originalAllowedHosts = process.env.PRINT_WORKER_ALLOWED_HOSTS

afterEach(() => {
  if (originalAllowedHosts === undefined) delete process.env.PRINT_WORKER_ALLOWED_HOSTS
  else process.env.PRINT_WORKER_ALLOWED_HOSTS = originalAllowedHosts
})

describe('print worker object URL policy', () => {
  test('allows only an explicitly configured container HTTP host', async () => {
    process.env.PRINT_WORKER_ALLOWED_HOSTS = 'minio'
    await expect(assertPrintObjectUrl('http://minio:9000/bucket/object?signature=secret'))
      .resolves.toBeInstanceOf(URL)
    await expect(assertPrintObjectUrl('http://other:9000/bucket/object'))
      .rejects.toThrow('host')
  })

  test('rejects loopback, metadata, private and IPv4-mapped addresses', async () => {
    process.env.PRINT_WORKER_ALLOWED_HOSTS = ''
    for (const url of [
      'https://127.0.0.1/object',
      'https://169.254.169.254/latest/meta-data',
      'https://10.0.0.1/object',
      'https://[::1]/object',
      'https://[::ffff:127.0.0.1]/object',
    ]) {
      await expect(assertPrintObjectUrl(url)).rejects.toThrow()
    }
  })

  test('rejects credentials and non-HTTP schemes before resolution', async () => {
    await expect(assertPrintObjectUrl('https://user:password@example.com/object')).rejects.toThrow()
    await expect(assertPrintObjectUrl('file:///etc/passwd')).rejects.toThrow()
  })
})
