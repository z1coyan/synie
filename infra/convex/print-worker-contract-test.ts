import { createHash, createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import {
  PRINT_WORKER_SIGNATURE_HEADER,
  PRINT_WORKER_TIMESTAMP_HEADER,
  decodeConvertResponseV1,
  printWorkerSignaturePayload,
  type ConvertRequestV1,
  type PrintWorkerErrorCode,
} from '@synie/shared'
import { root } from './lib.ts'

export interface PrintWorkerContractOptions {
  workerBaseUrl: string
  workerSecret: string
  s3IoEndpoint: string
  s3SignedEndpoint: string
  region: string
  accessKeyId: string
  secretAccessKey: string
  bucket: string
  fixturePath: string
}

export interface PrintWorkerContractReport {
  version: 1
  checks: string[]
  converterVersion: string
  inputBytes: number
  outputBytes: number
  firstDurationMs: number
  replayDurationMs: number
}

function invariant(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}

function digest(bytes: Uint8Array): { hex: string; base64: string } {
  const value = createHash('sha256').update(bytes).digest()
  return { hex: value.toString('hex'), base64: value.toString('base64') }
}

function client(options: PrintWorkerContractOptions, endpoint: string): S3Client {
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

function endpoint(options: PrintWorkerContractOptions, jobId: string): string {
  return `${options.workerBaseUrl.replace(/\/+$/, '')}/api/internal/print-worker/v1/jobs/${encodeURIComponent(jobId)}/execute`
}

function signedHeaders(
  secret: string,
  rawBody: string,
  timestamp = String(Date.now()),
): Record<string, string> {
  const bodyDigest = createHash('sha256').update(rawBody).digest('hex')
  const signature = createHmac('sha256', secret)
    .update(printWorkerSignaturePayload(timestamp, bodyDigest))
    .digest('hex')
  return {
    'content-type': 'application/json',
    [PRINT_WORKER_TIMESTAMP_HEADER]: timestamp,
    [PRINT_WORKER_SIGNATURE_HEADER]: signature,
  }
}

async function expectError(
  response: Response,
  status: number,
  code: PrintWorkerErrorCode,
): Promise<void> {
  const value = await response.json() as { version?: number; error?: { code?: string } }
  invariant(response.status === status, `Worker 错误状态不匹配：预期 ${status}，实际 ${response.status}`)
  invariant(value.version === 1 && value.error?.code === code, `Worker 错误码不匹配：预期 ${code}`)
}

/**
 * Implementation-neutral acceptance suite. It only knows the public v1 wire
 * contract and S3; it deliberately imports neither Convex nor Web Worker code.
 */
export async function verifyPrintWorkerContract(
  options: PrintWorkerContractOptions,
): Promise<PrintWorkerContractReport> {
  invariant(Buffer.byteLength(options.workerSecret) >= 32, 'Worker HMAC secret 必须至少 32 bytes')
  const io = client(options, options.s3IoEndpoint)
  const signer = client(options, options.s3SignedEndpoint)
  const prefix = `print-tmp/contract/${crypto.randomUUID()}`
  const inputKey = `${prefix}/input.xlsx`
  const outputKey = `${prefix}/output.pdf`
  const keys = [inputKey, outputKey]
  const input = new Uint8Array(readFileSync(options.fixturePath))
  const inputDigest = digest(input)
  const checks: string[] = []

  try {
    await io.send(new PutObjectCommand({
      Bucket: options.bucket,
      Key: inputKey,
      Body: input,
      ContentLength: input.byteLength,
      ContentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      ChecksumSHA256: inputDigest.base64,
      Metadata: { sha256: inputDigest.hex },
    }))

    const [getUrl, putUrl] = await Promise.all([
      getSignedUrl(
        signer,
        new GetObjectCommand({ Bucket: options.bucket, Key: inputKey }),
        { expiresIn: 300 },
      ),
      getSignedUrl(
        signer,
        new PutObjectCommand({
          Bucket: options.bucket,
          Key: outputKey,
          ContentType: 'application/pdf',
        }),
        { expiresIn: 300, signableHeaders: new Set(['content-type']) },
      ),
    ])

    const jobId = `contract_${crypto.randomUUID().replaceAll('-', '')}`
    const request: ConvertRequestV1 = {
      version: 1,
      jobId,
      attempt: 1,
      deadlineAt: Date.now() + 150_000,
      input: {
        getUrl,
        size: input.byteLength,
        sha256: inputDigest.hex,
      },
      output: {
        putUrl,
        headers: { 'content-type': 'application/pdf' },
      },
    }
    const rawBody = JSON.stringify(request)

    await expectError(
      await fetch(endpoint(options, jobId), {
        method: 'POST',
        body: rawBody,
        headers: {
          ...signedHeaders(options.workerSecret, rawBody),
          [PRINT_WORKER_SIGNATURE_HEADER]: '0'.repeat(64),
        },
      }),
      401,
      'unauthorized',
    )
    const stale = String(Date.now() - 61_000)
    await expectError(
      await fetch(endpoint(options, jobId), {
        method: 'POST', body: rawBody,
        headers: signedHeaders(options.workerSecret, rawBody, stale),
      }),
      401,
      'unauthorized',
    )
    await expectError(
      await fetch(endpoint(options, `${jobId}_other`), {
        method: 'POST', body: rawBody,
        headers: signedHeaders(options.workerSecret, rawBody),
      }),
      400,
      'bad_request',
    )
    const unknownBody = JSON.stringify({ ...request, unknown: true })
    await expectError(
      await fetch(endpoint(options, jobId), {
        method: 'POST', body: unknownBody,
        headers: signedHeaders(options.workerSecret, unknownBody),
      }),
      400,
      'bad_request',
    )
    checks.push('hmac-timestamp-path-schema')

    const firstStarted = performance.now()
    const firstResponse = await fetch(endpoint(options, jobId), {
      method: 'POST', body: rawBody,
      headers: signedHeaders(options.workerSecret, rawBody),
    })
    const firstDurationMs = Math.round(performance.now() - firstStarted)
    if (!firstResponse.ok) {
      throw new Error(`Worker 转换失败：HTTP ${firstResponse.status} ${await firstResponse.text()}`)
    }
    invariant((firstResponse.headers.get('content-type') ?? '').startsWith('application/json'), 'Worker 响应不是 JSON')
    const first = decodeConvertResponseV1(await firstResponse.json())
    invariant(first.jobId === jobId, 'Worker response jobId 不匹配')

    const head = await io.send(new HeadObjectCommand({
      Bucket: options.bucket,
      Key: outputKey,
      ChecksumMode: 'ENABLED',
    }))
    invariant(head.ContentLength === first.output.size, '输出 HEAD size 与响应不匹配')
    invariant(head.ContentType === 'application/pdf', '输出 HEAD content-type 不匹配')
    invariant(head.ChecksumSHA256 === Buffer.from(first.output.sha256, 'hex').toString('base64'), 'S3 未验证输出 SHA-256 checksum')

    const object = await io.send(new GetObjectCommand({ Bucket: options.bucket, Key: outputKey }))
    const output = new Uint8Array(await object.Body!.transformToByteArray())
    invariant(new TextDecoder().decode(output.slice(0, 5)) === '%PDF-', '输出不是 PDF magic')
    invariant(digest(output).hex === first.output.sha256, '输出 bytes SHA-256 不匹配')
    checks.push('presigned-get-put-head-checksum')

    const replayStarted = performance.now()
    const replayResponse = await fetch(endpoint(options, jobId), {
      method: 'POST', body: rawBody,
      headers: signedHeaders(options.workerSecret, rawBody),
    })
    const replayDurationMs = Math.round(performance.now() - replayStarted)
    invariant(replayResponse.ok, `Worker 重放失败：HTTP ${replayResponse.status}`)
    const replay = decodeConvertResponseV1(await replayResponse.json())
    invariant(replay.jobId === first.jobId, '重放 jobId 不匹配')
    const replayHead = await io.send(new HeadObjectCommand({
      Bucket: options.bucket,
      Key: outputKey,
      ChecksumMode: 'ENABLED',
    }))
    invariant(replayHead.ContentLength === replay.output.size, '重放后的输出 size 不匹配')
    invariant(
      replayHead.ChecksumSHA256 === Buffer.from(replay.output.sha256, 'hex').toString('base64'),
      '重放后的输出 checksum 不匹配',
    )
    const listed = await io.send(new ListObjectsV2Command({ Bucket: options.bucket, Prefix: prefix }))
    invariant(listed.KeyCount === 2, `重放产生了额外对象：${listed.KeyCount ?? 0}`)
    checks.push('idempotent-replay-single-output')

    return {
      version: 1,
      checks,
      converterVersion: first.converter.version,
      inputBytes: input.byteLength,
      outputBytes: first.output.size,
      firstDurationMs,
      replayDurationMs,
    }
  } finally {
    await Promise.all(keys.map((key) => io.send(new DeleteObjectCommand({
      Bucket: options.bucket,
      Key: key,
    })).catch(() => undefined)))
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
  verifyPrintWorkerContract({
    workerBaseUrl: required('PRINT_WORKER_TEST_URL'),
    workerSecret: required('PRINT_WORKER_HMAC_SECRET'),
    s3IoEndpoint: required('SYNIE_S3_IO_ENDPOINT'),
    s3SignedEndpoint: required('SYNIE_S3_SIGNED_ENDPOINT'),
    region: process.env.SYNIE_S3_REGION?.trim() || 'us-east-1',
    accessKeyId: required('SYNIE_S3_ACCESS_KEY_ID'),
    secretAccessKey: required('SYNIE_S3_SECRET_ACCESS_KEY'),
    bucket: process.env.SYNIE_PRODUCT_FILES_BUCKET?.trim() || 'synie-product-files',
    fixturePath: resolve(root, process.env.PRINT_WORKER_FIXTURE?.trim() || 'web/e2e/fixtures/matrix_template.xlsx'),
  }).then((report) => {
    console.log(JSON.stringify(report, null, 2))
  }).catch((error) => {
    console.error('[synie:print-worker-contract] 失败:', error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
