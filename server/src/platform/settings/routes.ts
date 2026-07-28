import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import { isDecimalString } from '@synie/shared'
import { requireAuth } from '../auth/middleware.ts'
import type { AuthService } from '../auth/service.ts'
import type { AppEnv } from '../http/context.ts'
import { ApiError } from '../http/errors.ts'
import { validationHook } from '../http/zod.ts'
import type { SettingsService } from './service.ts'

const decimalString = z.string().refine(isDecimalString, { message: '必须是十进制字符串' })

const salesUpdateSchema = z
  .object({
    sampleItemMaxQty: z.number().int().optional(),
    deliveryOvershipRatio: decimalString.optional(),
    spotItemMaxQty: z.number().int().optional(),
    receiptOverreceiveRatio: decimalString.optional(),
    demandOverorderRatio: decimalString.optional(),
  })
  .strict()

const mfgUpdateSchema = z
  .object({
    outputOverreceiveRatio: decimalString.optional(),
  })
  .strict()

const accUpdateSchema = z
  .object({
    ocrAccessKeyId: z.string().nullable().optional(),
    ocrAccessKeySecret: z.string().optional(),
  })
  .strict()

const sysUpdateSchema = z
  .object({
    marketFetchScheduleEnabled: z.boolean().optional(),
    marketFetchLastIntervalMinutes: z.number().int().optional(),
    marketFetchSettlementEnabled: z.boolean().optional(),
  })
  .strict()

export function settingsRoutes(deps: { auth: AuthService; settings: SettingsService }) {
  const { auth, settings } = deps

  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .get('/supply-chain', async (c) => {
      const value = await settings.getSales(c.get('actor'))
      return c.json(salesDto(value))
    })
    .patch('/supply-chain', zValidator('json', salesUpdateSchema, validationHook), async (c) => {
      const value = await settings.updateSales(c.get('actor'), c.req.valid('json'))
      return c.json(salesDto(value))
    })
    .get('/production', async (c) => {
      const value = await settings.getManufacturing(c.get('actor'))
      return c.json(mfgDto(value))
    })
    .patch('/production', zValidator('json', mfgUpdateSchema, validationHook), async (c) => {
      const value = await settings.updateManufacturing(c.get('actor'), c.req.valid('json'))
      return c.json(mfgDto(value))
    })
    .get('/finance', async (c) => {
      const value = await settings.getAccounting(c.get('actor'))
      return c.json(accDto(value))
    })
    .patch('/finance', zValidator('json', accUpdateSchema, validationHook), async (c) => {
      const raw = (await c.req.json()) as Record<string, unknown>
      const body = c.req.valid('json')
      const value = await settings.updateAccounting(c.get('actor'), {
        ocrAccessKeyId: body.ocrAccessKeyId,
        ocrAccessKeyIdPresent: Object.prototype.hasOwnProperty.call(raw, 'ocrAccessKeyId'),
        ocrAccessKeySecret: body.ocrAccessKeySecret,
      })
      return c.json(accDto(value))
    })
    .get('/finance/ocr-configured', async (c) => {
      // 任意已登录用户可查（对齐 Go requireActor）
      if (!c.get('actor')) throw new ApiError('unauthorized', '未登录或登录状态已失效')
      return c.json({ configured: await settings.ocrConfigured() })
    })
    .get('/system', async (c) => {
      const value = await settings.getSystem(c.get('actor'))
      return c.json(sysDto(value))
    })
    .patch('/system', zValidator('json', sysUpdateSchema, validationHook), async (c) => {
      const value = await settings.updateSystem(c.get('actor'), c.req.valid('json'))
      return c.json(sysDto(value))
    })
}

function salesDto(v: Awaited<ReturnType<SettingsService['getSales']>>) {
  return {
    id: v.id,
    sampleItemMaxQty: v.sampleItemMaxQty,
    deliveryOvershipRatio: v.deliveryOvershipRatio,
    spotItemMaxQty: v.spotItemMaxQty,
    receiptOverreceiveRatio: v.receiptOverreceiveRatio,
    demandOverorderRatio: v.demandOverorderRatio,
    insertedAt: v.insertedAt.toISOString(),
    updatedAt: v.updatedAt.toISOString(),
  }
}

function mfgDto(v: Awaited<ReturnType<SettingsService['getManufacturing']>>) {
  return {
    id: v.id,
    outputOverreceiveRatio: v.outputOverreceiveRatio,
    insertedAt: v.insertedAt.toISOString(),
    updatedAt: v.updatedAt.toISOString(),
  }
}

function accDto(v: Awaited<ReturnType<SettingsService['getAccounting']>>) {
  return {
    id: v.id,
    ocrAccessKeyId: v.ocrAccessKeyId,
    insertedAt: v.insertedAt.toISOString(),
    updatedAt: v.updatedAt.toISOString(),
  }
}

function sysDto(v: Awaited<ReturnType<SettingsService['getSystem']>>) {
  return {
    id: v.id,
    marketFetchScheduleEnabled: v.marketFetchScheduleEnabled,
    marketFetchLastIntervalMinutes: v.marketFetchLastIntervalMinutes,
    marketFetchSettlementEnabled: v.marketFetchSettlementEnabled,
    marketFetchLastRunAt: v.marketFetchLastRunAt?.toISOString() ?? null,
    marketFetchLastSummary: v.marketFetchLastSummary,
    insertedAt: v.insertedAt.toISOString(),
    updatedAt: v.updatedAt.toISOString(),
  }
}
