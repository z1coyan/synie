"use node"

import {
  DeleteObjectCommand,
  GetObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { synieError } from '../lib/errors'

export function requiredS3Env(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw synieError('internal', '产品文件存储尚未配置')
  return value
}

export function productBucket(): string {
  return process.env.SYNIE_PRODUCT_FILES_BUCKET?.trim() || 'synie-product-files'
}

export function productS3Client(endpoint: string): S3Client {
  return new S3Client({
    region: process.env.SYNIE_S3_REGION?.trim() || 'us-east-1',
    endpoint,
    forcePathStyle: true,
    credentials: {
      accessKeyId: requiredS3Env('SYNIE_S3_ACCESS_KEY_ID'),
      secretAccessKey: requiredS3Env('SYNIE_S3_SECRET_ACCESS_KEY'),
    },
  })
}

export function internalProductS3Client(): S3Client {
  return productS3Client(requiredS3Env('SYNIE_S3_INTERNAL_ENDPOINT'))
}

export function publicProductS3Client(): S3Client {
  return productS3Client(requiredS3Env('SYNIE_S3_PUBLIC_ENDPOINT'))
}

export async function readProductObject(objectKey: string, maxBytes: number): Promise<Uint8Array> {
  const client = internalProductS3Client()
  try {
    const result = await client.send(new GetObjectCommand({ Bucket: productBucket(), Key: objectKey }))
    if ((result.ContentLength ?? maxBytes + 1) > maxBytes) throw synieError('validation', '文件超过当前处理上限')
    const bytes = await result.Body?.transformToByteArray()
    if (!bytes) throw synieError('validation', '文件内容不存在')
    if (bytes.byteLength > maxBytes) throw synieError('validation', '文件超过当前处理上限')
    return bytes
  } finally {
    client.destroy()
  }
}

export async function deleteProductObject(objectKey: string): Promise<void> {
  const client = internalProductS3Client()
  try {
    await client.send(new DeleteObjectCommand({ Bucket: productBucket(), Key: objectKey }))
  } finally {
    client.destroy()
  }
}
