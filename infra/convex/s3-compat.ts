import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

export interface S3CompatibilityOptions {
  internalEndpoint: string
  publicEndpoint: string
  region: string
  accessKeyId: string
  secretAccessKey: string
  bucket: string
  corsOrigin: string
}

export interface S3CompatibilityReport {
  provider: 's3-compatible'
  bucket: string
  checkedAt: string
  checks: string[]
}

function invariant(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}

function s3Client(options: S3CompatibilityOptions, endpoint: string): S3Client {
  return new S3Client({
    endpoint,
    region: options.region,
    forcePathStyle: true,
    credentials: {
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
    },
  })
}

async function sha256(bytes: Uint8Array): Promise<{ hex: string; base64: string }> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return {
    hex: Buffer.from(digest).toString('hex'),
    base64: Buffer.from(digest).toString('base64'),
  }
}

function compatBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size)
  for (let index = 0; index < size; index += 1) bytes[index] = (index * 31 + 17) & 0xff
  return bytes
}

function copySource(bucket: string, key: string): string {
  return encodeURIComponent(`${bucket}/${key}`).replaceAll('%2F', '/')
}

async function signedPut(input: {
  options: S3CompatibilityOptions
  signer: S3Client
  key: string
  bytes: Uint8Array
  contentType: string
  checksum: string
}): Promise<Response> {
  const url = await getSignedUrl(input.signer, new PutObjectCommand({
    Bucket: input.options.bucket,
    Key: input.key,
    ContentLength: input.bytes.byteLength,
    ContentType: input.contentType,
    ChecksumSHA256: input.checksum,
    Metadata: { sha256: Buffer.from(input.checksum, 'base64').toString('hex') },
  }), {
    expiresIn: 600,
    signableHeaders: new Set(['content-type']),
    unhoistableHeaders: new Set(['x-amz-checksum-sha256', 'x-amz-meta-sha256']),
  })
  const parsed = new URL(url)
  invariant(parsed.pathname.startsWith(`/${input.options.bucket}/`), 'presigned URL 未使用 path-style bucket 路径')
  invariant(parsed.searchParams.get('X-Amz-Algorithm') === 'AWS4-HMAC-SHA256', 'presigned URL 未使用 SigV4')
  return fetch(url, {
    method: 'PUT',
    headers: {
      'content-type': input.contentType,
      'content-length': String(input.bytes.byteLength),
      'x-amz-checksum-sha256': input.checksum,
      'x-amz-meta-sha256': Buffer.from(input.checksum, 'base64').toString('hex'),
      origin: input.options.corsOrigin,
    },
    body: input.bytes,
  })
}

export async function verifyS3Compatibility(options: S3CompatibilityOptions): Promise<S3CompatibilityReport> {
  const io = s3Client(options, options.internalEndpoint)
  const signer = s3Client(options, options.publicEndpoint)
  const prefix = `compat/${crypto.randomUUID()}`
  const keys = new Set<string>()
  const checks: string[] = []

  try {
    const anonymous = await fetch(`${options.publicEndpoint.replace(/\/$/, '')}/${options.bucket}/${prefix}/private`)
    invariant(anonymous.status === 403 || anonymous.status === 404, `private bucket 匿名读取未拒绝：HTTP ${anonymous.status}`)
    checks.push('private-bucket')

    const cors = await fetch(`${options.publicEndpoint.replace(/\/$/, '')}/${options.bucket}/${prefix}/cors`, {
      method: 'OPTIONS',
      headers: {
        origin: options.corsOrigin,
        'access-control-request-method': 'PUT',
        'access-control-request-headers': 'content-type,x-amz-checksum-sha256,x-amz-meta-sha256',
      },
    })
    invariant(cors.ok, `CORS preflight 失败：HTTP ${cors.status}`)
    invariant(cors.headers.get('access-control-allow-origin') === options.corsOrigin, 'CORS origin 不匹配')
    checks.push('product-only-cors')

    const smallKey = `${prefix}/small.bin`
    keys.add(smallKey)
    const small = compatBytes(4097)
    const smallDigest = await sha256(small)
    const put = await signedPut({
      options, signer, key: smallKey, bytes: small,
      contentType: 'application/octet-stream', checksum: smallDigest.base64,
    })
    invariant(put.ok, `presigned PUT 失败：HTTP ${put.status} ${await put.text()}`)
    invariant(put.headers.get('access-control-allow-origin') === options.corsOrigin, 'PUT response 缺少 product CORS')

    const head = await io.send(new HeadObjectCommand({
      Bucket: options.bucket, Key: smallKey, ChecksumMode: 'ENABLED',
    }))
    invariant(head.ContentLength === small.byteLength, 'HEAD Content-Length 不匹配')
    invariant(head.ContentType === 'application/octet-stream', 'HEAD Content-Type 不匹配')
    invariant(head.ChecksumSHA256 === smallDigest.base64, 'provider 未在 HEAD 返回服务端验证的 SHA-256 checksum')
    invariant(head.Metadata?.sha256 === smallDigest.hex, 'HEAD metadata SHA-256 不匹配')

    const signedHead = await getSignedUrl(signer, new HeadObjectCommand({
      Bucket: options.bucket, Key: smallKey, ChecksumMode: 'ENABLED',
    }), { expiresIn: 300 })
    const publicHead = await fetch(signedHead, { method: 'HEAD', headers: { origin: options.corsOrigin } })
    invariant(publicHead.ok && Number(publicHead.headers.get('content-length')) === small.byteLength, 'presigned HEAD 失败')

    const signedGet = await getSignedUrl(signer, new GetObjectCommand({
      Bucket: options.bucket,
      Key: smallKey,
      ResponseContentType: 'application/octet-stream',
      ResponseContentDisposition: `attachment; filename="compat.bin"`,
    }), { expiresIn: 300 })
    const get = await fetch(signedGet, { headers: { origin: options.corsOrigin } })
    invariant(get.ok, `presigned GET 失败：HTTP ${get.status}`)
    invariant(get.headers.get('content-disposition') === 'attachment; filename="compat.bin"', 'GET Content-Disposition 不匹配')
    invariant(Buffer.from(await get.arrayBuffer()).equals(Buffer.from(small)), 'GET bytes 不匹配')
    checks.push('presigned-put-get-head')

    const copiedKey = `${prefix}/copied.bin`
    keys.add(copiedKey)
    await io.send(new CopyObjectCommand({
      Bucket: options.bucket,
      Key: copiedKey,
      CopySource: copySource(options.bucket, smallKey),
      ChecksumAlgorithm: 'SHA256',
      MetadataDirective: 'REPLACE',
      ContentType: 'application/octet-stream',
      Metadata: { sha256: smallDigest.hex },
    }))
    const copiedHead = await io.send(new HeadObjectCommand({
      Bucket: options.bucket, Key: copiedKey, ChecksumMode: 'ENABLED',
    }))
    invariant(copiedHead.ContentLength === small.byteLength, 'CopyObject Content-Length 不匹配')
    invariant(copiedHead.ContentType === 'application/octet-stream', 'CopyObject Content-Type 不匹配')
    invariant(copiedHead.ChecksumSHA256 === smallDigest.base64, 'CopyObject 未保留 SHA-256 checksum')
    invariant(copiedHead.Metadata?.sha256 === smallDigest.hex, 'CopyObject metadata SHA-256 不匹配')
    checks.push('server-side-copy-checksum')

    const mismatchKey = `${prefix}/checksum-mismatch.bin`
    keys.add(mismatchKey)
    const wrongChecksum = await sha256(compatBytes(small.byteLength + 1))
    const mismatch = await signedPut({
      options, signer, key: mismatchKey, bytes: small,
      contentType: 'application/octet-stream', checksum: wrongChecksum.base64,
    })
    invariant(!mismatch.ok, 'provider 接受了 checksum mismatch PUT')
    checks.push('provider-checksum-rejection')

    const largeKey = `${prefix}/50mb.bin`
    keys.add(largeKey)
    const large = compatBytes(50 * 1024 * 1024)
    const largeDigest = await sha256(large)
    const largePut = await signedPut({
      options, signer, key: largeKey, bytes: large,
      contentType: 'application/octet-stream', checksum: largeDigest.base64,
    })
    invariant(largePut.ok, `50MB presigned PUT 失败：HTTP ${largePut.status} ${await largePut.text()}`)
    const largeHead = await io.send(new HeadObjectCommand({
      Bucket: options.bucket, Key: largeKey, ChecksumMode: 'ENABLED',
    }))
    invariant(largeHead.ContentLength === large.byteLength, '50MB HEAD length 不匹配')
    invariant(largeHead.ChecksumSHA256 === largeDigest.base64, '50MB HEAD checksum 不匹配')
    checks.push('50mb-single-put')

    for (const key of keys) {
      await io.send(new DeleteObjectCommand({ Bucket: options.bucket, Key: key }))
      await io.send(new DeleteObjectCommand({ Bucket: options.bucket, Key: key }))
      let missing = false
      try {
        await io.send(new HeadObjectCommand({ Bucket: options.bucket, Key: key }))
      } catch (error) {
        const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
        missing = status === 404
      }
      invariant(missing, `DELETE 后对象仍存在：${key}`)
    }
    keys.clear()
    checks.push('idempotent-delete-404')

    return {
      provider: 's3-compatible',
      bucket: options.bucket,
      checkedAt: new Date().toISOString(),
      checks,
    }
  } finally {
    await Promise.all([...keys].map((key) =>
      io.send(new DeleteObjectCommand({ Bucket: options.bucket, Key: key })).catch(() => undefined),
    ))
    io.destroy()
    signer.destroy()
  }
}

function required(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`缺少环境变量 ${name}`)
  return value
}

if (import.meta.main) {
  verifyS3Compatibility({
    internalEndpoint: required('SYNIE_S3_INTERNAL_ENDPOINT'),
    publicEndpoint: required('SYNIE_S3_PUBLIC_ENDPOINT'),
    region: process.env.SYNIE_S3_REGION?.trim() || 'us-east-1',
    accessKeyId: required('SYNIE_S3_ACCESS_KEY_ID'),
    secretAccessKey: required('SYNIE_S3_SECRET_ACCESS_KEY'),
    bucket: process.env.SYNIE_PRODUCT_FILES_BUCKET?.trim() || 'synie-product-files',
    corsOrigin: process.env.SYNIE_PRODUCT_FILES_CORS_ORIGIN?.trim() || 'http://localhost:3000',
  }).then((report) => console.log(JSON.stringify(report, null, 2))).catch((error) => {
    console.error('[synie:s3-compat] 失败:', error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
