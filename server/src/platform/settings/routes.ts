/**
 * 设置 REST：挂载于 /settings。
 *
 * 逐端点挂 `guard(资源, 动作)`（requireAuth 之后），handler 用 `permitOf(c)` 取凭证。
 * 四张单行设置各是独立资源（salSettings/mfgSettings/accSettings/sysSettings），
 * 动作码唯一事实源是各自 meta 的 actions（read/update）。
 * OCR 是否已配置只判「已登录」（无独立权限码，对齐 Go requireActor），故不挂 guard。
 */
import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import { isDecimalString } from '@synie/shared'
import { requireAuth } from '../auth/middleware.ts'
import type { AuthService } from '../auth/service.ts'
import type { AuthzEnforcer } from '../authz/enforce.ts'
import { permitOf } from '../authz/enforce.ts'
import type { AppEnv } from '../http/context.ts'
import { ApiError } from '../http/errors.ts'
import { validationHook } from '../http/zod.ts'
import { SYS_RESOURCE_NAME } from './meta.ts'
import type { SettingsService } from './service.ts'

/** 业务域设置资源名（platform 不 import modules，故由组合根注入） */
export interface SettingsResourceNames {
  sales: string
  manufacturing: string
  accounting: string
}

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
    moldCategoryId: z.string().uuid().nullable().optional(),
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

export function settingsRoutes(deps: {
  auth: AuthService
  authz: AuthzEnforcer
  settings: SettingsService
  resources: SettingsResourceNames
}) {
  const { auth, authz, settings, resources } = deps
  const guard = (resource: string, action: string) => authz.guard(resource, action)

  return new Hono<AppEnv>()
    .use('*', requireAuth(auth))
    .get('/supply-chain', guard(resources.sales, 'read'), async (c) => {
      const value = await settings.getSales(permitOf(c))
      return c.json(salesDto(value))
    })
    .patch(
      '/supply-chain',
      guard(resources.sales, 'update'),
      zValidator('json', salesUpdateSchema, validationHook),
      async (c) => {
        const value = await settings.updateSales(permitOf(c), c.req.valid('json'))
        return c.json(salesDto(value))
      },
    )
    .get('/production', guard(resources.manufacturing, 'read'), async (c) => {
      const value = await settings.getManufacturing(permitOf(c))
      return c.json(mfgDto(value))
    })
    .patch(
      '/production',
      guard(resources.manufacturing, 'update'),
      zValidator('json', mfgUpdateSchema, validationHook),
      async (c) => {
        const value = await settings.updateManufacturing(permitOf(c), c.req.valid('json'))
        return c.json(mfgDto(value))
      },
    )
    .get('/finance', guard(resources.accounting, 'read'), async (c) => {
      const value = await settings.getAccounting(permitOf(c))
      return c.json(accDto(value))
    })
    .patch(
      '/finance',
      guard(resources.accounting, 'update'),
      zValidator('json', accUpdateSchema, validationHook),
      async (c) => {
        const raw = (await c.req.json()) as Record<string, unknown>
        const body = c.req.valid('json')
        const value = await settings.updateAccounting(permitOf(c), {
          ocrAccessKeyId: body.ocrAccessKeyId,
          ocrAccessKeyIdPresent: Object.prototype.hasOwnProperty.call(raw, 'ocrAccessKeyId'),
          ocrAccessKeySecret: body.ocrAccessKeySecret,
        })
        return c.json(accDto(value))
      },
    )
    .get('/finance/ocr-configured', async (c) => {
      // 任意已登录用户可查（对齐 Go requireActor）
      if (!c.get('actor')) throw new ApiError('unauthorized', '未登录或登录状态已失效')
      return c.json({ configured: await settings.ocrConfigured() })
    })
    .get('/system', guard(SYS_RESOURCE_NAME, 'read'), async (c) => {
      const value = await settings.getSystem(permitOf(c))
      return c.json(sysDto(value))
    })
    .patch(
      '/system',
      guard(SYS_RESOURCE_NAME, 'update'),
      zValidator('json', sysUpdateSchema, validationHook),
      async (c) => {
        const value = await settings.updateSystem(permitOf(c), c.req.valid('json'))
        return c.json(sysDto(value))
      },
    )
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
    moldCategoryId: v.moldCategoryId,
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
