import { describe, expect, test } from 'bun:test'
import {
  type ConvertRequestV1,
  decodeConvertRequestV1,
  decodeConvertResponseV1,
  printWorkerSignaturePayload,
} from './print-worker'

const request = {
  version: 1,
  jobId: 'job_123',
  attempt: 2,
  deadlineAt: 1_900_000_000_000,
  input: { getUrl: 'http://minio:9000/input', size: 12, sha256: 'a'.repeat(64) },
  output: { putUrl: 'http://minio:9000/output', headers: { 'content-type': 'application/pdf' } },
} satisfies ConvertRequestV1

describe('print worker v1 contract', () => {
  test('strictly decodes the shared request and response fixtures', () => {
    expect(decodeConvertRequestV1(request)).toEqual(request)
    expect(decodeConvertResponseV1({
      version: 1,
      jobId: 'job_123',
      output: { size: 9, sha256: 'b'.repeat(64), contentType: 'application/pdf' },
      converter: { engine: 'libreoffice', version: '25.8' },
    }).jobId).toBe('job_123')
  })

  test('rejects unknown fields and malformed hashes', () => {
    expect(() => decodeConvertRequestV1({ ...request, unexpected: true })).toThrow('未知字段')
    expect(() => decodeConvertRequestV1({
      ...request,
      input: { ...request.input, sha256: 'not-a-hash' },
    })).toThrow('sha256')
  })

  test('freezes the signature payload shape', () => {
    expect(printWorkerSignaturePayload('1700000000000', 'c'.repeat(64)))
      .toBe(`1700000000000\n${'c'.repeat(64)}`)
  })
})
