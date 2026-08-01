import { createHmac } from 'node:crypto'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

export const ERR_OBJECT_NOT_FOUND = Symbol('object_not_found')
export const ERR_PRESIGN_UNSUPPORTED = Symbol('presign_unsupported')

export interface ObjectStorage {
  put(key: string, sourcePath: string): Promise<void>
  read(key: string): Promise<Uint8Array>
  delete(key: string): Promise<void>
  /** 不支持时 reject ERR_PRESIGN_UNSUPPORTED */
  presignedGet(key: string, ttlMs: number): Promise<string>
}

export function createLocalStorage(root: string): ObjectStorage {
  return {
    async put(key, sourcePath) {
      const destination = localPath(root, key)
      await mkdir(dirname(destination), { recursive: true, mode: 0o750 })
      const data = await readFile(sourcePath)
      try {
        await writeFile(destination, data, { mode: 0o640 })
      } catch (err) {
        await unlink(destination).catch(() => undefined)
        throw err
      }
    },
    async read(key) {
      const path = localPath(root, key)
      try {
        return await readFile(path)
      } catch (err) {
        if (isNotFound(err)) throw ERR_OBJECT_NOT_FOUND
        throw err
      }
    },
    async delete(key) {
      const path = localPath(root, key)
      try {
        await unlink(path)
      } catch (err) {
        if (isNotFound(err)) return
        throw err
      }
    },
    async presignedGet() {
      throw ERR_PRESIGN_UNSUPPORTED
    },
  }
}

export function createS3Storage(input: {
  endpoint: string
  region: string
  bucket: string
  prefix: string
  accessKeyId: string
  secretAccessKey: string
  kind: string
}): ObjectStorage {
  const parsed = new URL(input.endpoint)
  if (!parsed.host || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
    throw new Error('invalid S3 endpoint')
  }
  const secure = parsed.protocol === 'https:'
  const host = parsed.host
  const region = input.region || 'us-east-1'
  const bucket = input.bucket
  const prefix = input.prefix.replace(/^\/+|\/+$/g, '')
  const accessKeyId = input.accessKeyId
  const secretAccessKey = input.secretAccessKey
  const virtualHosted = input.kind.toLowerCase() === 'oss'

  function fullKey(key: string): string {
    const cleaned = key.replace(/^\/+/, '')
    return prefix ? `${prefix}/${cleaned}` : cleaned
  }

  function objectUrl(objectKey: string): { url: string; hostHeader: string; canonicalUri: string } {
    const encodedKey = encodeS3Path(objectKey)
    if (virtualHosted) {
      const vhHost = `${bucket}.${host}`
      return {
        url: `${secure ? 'https' : 'http'}://${vhHost}/${encodedKey}`,
        hostHeader: vhHost,
        canonicalUri: `/${encodedKey}`,
      }
    }
    return {
      url: `${secure ? 'https' : 'http'}://${host}/${bucket}/${encodedKey}`,
      hostHeader: host,
      canonicalUri: `/${bucket}/${encodedKey}`,
    }
  }

  async function signedRequest(
    method: string,
    objectKey: string,
    body?: Uint8Array,
  ): Promise<Response> {
    const { url, hostHeader, canonicalUri } = objectUrl(objectKey)
    const now = new Date()
    const amzDate = toAmzDate(now)
    const dateStamp = amzDate.slice(0, 8)
    const payloadHash = sha256Hex(body ?? new Uint8Array())
    const headers: Record<string, string> = {
      host: hostHeader,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
    }
    if (body) {
      headers['content-length'] = String(body.byteLength)
    }
    const authorization = signV4({
      method,
      canonicalUri,
      canonicalQuerystring: '',
      headers,
      payloadHash,
      amzDate,
      dateStamp,
      region,
      accessKeyId,
      secretAccessKey,
      service: 's3',
    })
    headers.authorization = authorization
    return fetch(url, { method, headers, body: body ? Buffer.from(body) : undefined })
  }

  return {
    async put(key, sourcePath) {
      const objectKey = fullKey(key)
      const body = await readFile(sourcePath)
      const res = await signedRequest('PUT', objectKey, body)
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`S3 PutObject failed: ${res.status} ${text}`)
      }
    },
    async read(key) {
      const objectKey = fullKey(key)
      const res = await signedRequest('GET', objectKey)
      if (res.status === 404) throw ERR_OBJECT_NOT_FOUND
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        if (text.includes('NoSuchKey') || text.includes('NoSuchObject')) throw ERR_OBJECT_NOT_FOUND
        throw new Error(`S3 GetObject failed: ${res.status} ${text}`)
      }
      return new Uint8Array(await res.arrayBuffer())
    },
    async delete(key) {
      const objectKey = fullKey(key)
      const res = await signedRequest('DELETE', objectKey)
      if (res.status === 404) return
      if (!res.ok && res.status !== 204) {
        const text = await res.text().catch(() => '')
        throw new Error(`S3 DeleteObject failed: ${res.status} ${text}`)
      }
    },
    async presignedGet(key, ttlMs) {
      const objectKey = fullKey(key)
      const { url, hostHeader, canonicalUri } = objectUrl(objectKey)
      const now = new Date()
      const amzDate = toAmzDate(now)
      const dateStamp = amzDate.slice(0, 8)
      const expires = Math.max(1, Math.floor(ttlMs / 1000))
      const credential = `${accessKeyId}/${dateStamp}/${region}/s3/aws4_request`
      const signedHeaders = 'host'
      const query: Record<string, string> = {
        'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
        'X-Amz-Credential': credential,
        'X-Amz-Date': amzDate,
        'X-Amz-Expires': String(expires),
        'X-Amz-SignedHeaders': signedHeaders,
      }
      const canonicalQuerystring = Object.keys(query)
        .sort()
        .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(query[k]!)}`)
        .join('&')
      const canonicalHeaders = `host:${hostHeader}\n`
      const canonicalRequest = [
        'GET',
        canonicalUri,
        canonicalQuerystring,
        canonicalHeaders,
        signedHeaders,
        'UNSIGNED-PAYLOAD',
      ].join('\n')
      const stringToSign = [
        'AWS4-HMAC-SHA256',
        amzDate,
        `${dateStamp}/${region}/s3/aws4_request`,
        sha256Hex(canonicalRequest),
      ].join('\n')
      const signature = hmacHex(signingKey(secretAccessKey, dateStamp, region, 's3'), stringToSign)
      return `${url}?${canonicalQuerystring}&X-Amz-Signature=${signature}`
    },
  }
}

export function localPath(root: string, key: string): string {
  if (!root.trim() || !key.trim()) {
    throw new Error('storage root and key are required')
  }
  const absoluteRoot = resolve(root)
  const path = resolve(absoluteRoot, ...key.split('/').filter(Boolean))
  const rel = relative(absoluteRoot, path)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error('invalid object key')
  }
  return path
}

/** 对齐 Go filepath.Ext + 白名单正则 */
export function safeExtension(filename: string): string {
  // Go filepath.Ext 只看最终路径段中最后一个 '.' 之后
  let base = filename
  for (let i = filename.length - 1; i >= 0; i--) {
    const ch = filename[i]!
    if (ch === '/' || ch === '\\') {
      base = filename.slice(i + 1)
      break
    }
  }
  let ext = ''
  for (let i = base.length - 1; i >= 0; i--) {
    if (base[i] === '.') {
      ext = base.slice(i).toLowerCase()
      break
    }
  }
  return /^\.[a-z0-9]{1,10}$/.test(ext) ? ext : ''
}

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code: string }).code === 'ENOENT'
}

function encodeS3Path(key: string): string {
  return key
    .split('/')
    .map((segment) =>
      encodeURIComponent(segment).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`),
    )
    .join('/')
}

function toAmzDate(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, '')
}

function sha256Hex(data: string | Uint8Array): string {
  const hasher = new Bun.CryptoHasher('sha256')
  hasher.update(data)
  return hasher.digest('hex')
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest()
}

function hmacHex(key: Buffer, data: string): string {
  return createHmac('sha256', key).update(data, 'utf8').digest('hex')
}

function signingKey(secret: string, dateStamp: string, region: string, service: string): Buffer {
  const kDate = hmac(`AWS4${secret}`, dateStamp)
  const kRegion = hmac(kDate, region)
  const kService = hmac(kRegion, service)
  return hmac(kService, 'aws4_request')
}

function signV4(input: {
  method: string
  canonicalUri: string
  canonicalQuerystring: string
  headers: Record<string, string>
  payloadHash: string
  amzDate: string
  dateStamp: string
  region: string
  accessKeyId: string
  secretAccessKey: string
  service: string
}): string {
  const headerNames = Object.keys(input.headers)
    .map((h) => h.toLowerCase())
    .sort()
  const canonicalHeaders = headerNames
    .map((name) => {
      const original = Object.keys(input.headers).find((k) => k.toLowerCase() === name)!
      const value = input.headers[original]!
      return `${name}:${value.trim().replace(/\s+/g, ' ')}`
    })
    .join('\n')
  const signedHeaders = headerNames.join(';')
  const canonicalRequest = [
    input.method,
    input.canonicalUri,
    input.canonicalQuerystring,
    `${canonicalHeaders}\n`,
    signedHeaders,
    input.payloadHash,
  ].join('\n')
  const credentialScope = `${input.dateStamp}/${input.region}/${input.service}/aws4_request`
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    input.amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n')
  const signature = hmacHex(
    signingKey(input.secretAccessKey, input.dateStamp, input.region, input.service),
    stringToSign,
  )
  return `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
}
