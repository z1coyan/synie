import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

if (typeof window !== 'undefined') throw new Error('print worker URL policy is server-only')

function explicitHosts(): Set<string> {
  return new Set((process.env.PRINT_WORKER_ALLOWED_HOSTS ?? 'minio')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean))
}

function privateAddress(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, '')
  if (normalized.startsWith('::ffff:')) {
    const mapped = normalized.slice('::ffff:'.length)
    const hexadecimal = mapped.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
    if (hexadecimal) {
      const high = Number.parseInt(hexadecimal[1]!, 16)
      const low = Number.parseInt(hexadecimal[2]!, 16)
      return privateAddress(`${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`)
    }
    return privateAddress(mapped)
  }
  if (normalized === '::1' || normalized === '::' || normalized.startsWith('fe80:') || normalized.startsWith('fc') || normalized.startsWith('fd')) return true
  const parts = normalized.split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return false
  return parts[0] === 10 || parts[0] === 127 || parts[0] === 0 ||
    (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) ||
    (parts[0] === 192 && parts[1] === 168) ||
    (parts[0] === 100 && parts[1]! >= 64 && parts[1]! <= 127)
}

export async function assertPrintObjectUrl(raw: string): Promise<URL> {
  let url: URL
  try { url = new URL(raw) } catch { throw new Error('object URL 不合法') }
  if (url.username || url.password || (url.protocol !== 'https:' && url.protocol !== 'http:')) {
    throw new Error('object URL 不合法')
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (explicitHosts().has(host)) return url
  if (url.protocol !== 'https:') throw new Error('object URL host 未授权')
  const addresses = isIP(host)
    ? [{ address: host }]
    : await lookup(host, { all: true, verbatim: true })
  if (!addresses.length || addresses.some(({ address }) => privateAddress(address))) {
    throw new Error('object URL host 未授权')
  }
  return url
}
