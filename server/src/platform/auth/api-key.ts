/**
 * 个人 API 密钥：签发、哈希查找、撤销。
 * 明文永不回读；认证热路径按 token_hash 唯一索引点查。
 */
import { createHash } from 'node:crypto'
import { sql, type Kysely } from 'kysely'
import { withTx } from '~/db/tx.ts'
import type { DB as Database } from '~/db/types.ts'
import { ApiError } from '../http/errors.ts'

export const API_KEY_PREFIX = 'synie_ak_'
export const API_KEY_RESOURCE = 'sysUserApiKeys'
export const API_KEY_MAX_PER_USER = 10

export type RequestAuthMethod = 'session' | 'jwt' | 'api_key'
const HINT_SECRET_CHARS = 8

export interface UserApiKeyDto {
  id: string
  name: string
  tokenHint: string
  expiresAt: string | null
  lastUsedAt: string | null
  insertedAt: string
}

export interface CreatedUserApiKey extends UserApiKeyDto {
  token: string
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function generateToken(): { token: string; hint: string } {
  const secret = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')
  const token = `${API_KEY_PREFIX}${secret}`
  return { token, hint: token.slice(0, API_KEY_PREFIX.length + HINT_SECRET_CHARS) }
}

function isoOrNull(value: Date | null): string | null {
  return value ? value.toISOString() : null
}

function toDto(row: {
  id: string
  name: string
  token_hint: string
  expires_at: Date | null
  last_used_at: Date | null
  inserted_at: Date
}): UserApiKeyDto {
  return {
    id: row.id,
    name: row.name,
    tokenHint: row.token_hint,
    expiresAt: isoOrNull(row.expires_at),
    lastUsedAt: isoOrNull(row.last_used_at),
    insertedAt: row.inserted_at.toISOString(),
  }
}

function normalizeName(name: string): string {
  const trimmed = name.trim()
  if (!trimmed || trimmed.length > 64) {
    throw ApiError.validation('名称须为 1–64 个字符', { name: ['名称须为 1–64 个字符'] })
  }
  return trimmed
}

export function parseApiKeyExpiry(raw: string | null | undefined): Date | null {
  if (raw == null || raw.trim() === '') return null
  const value = raw.trim()
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  const parsed = dateOnly ? new Date(`${value}T23:59:59.999Z`) : new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    throw ApiError.validation('过期时间格式无效', { expiresAt: ['过期时间格式无效'] })
  }
  if (parsed.getTime() <= Date.now()) {
    throw ApiError.validation('过期时间必须晚于现在', { expiresAt: ['过期时间必须晚于现在'] })
  }
  return parsed
}

export function createUserApiKeyStore(db: Kysely<Database>) {
  async function listByUser(userId: string): Promise<UserApiKeyDto[]> {
    const rows = await db
      .selectFrom('sys_user_api_key')
      .select(['id', 'name', 'token_hint', 'expires_at', 'last_used_at', 'inserted_at'])
      .where('user_id', '=', userId)
      .orderBy('inserted_at', 'desc')
      .execute()
    return rows.map(toDto)
  }

  async function create(input: {
    userId: string
    name: string
    expiresAt: Date | null
  }): Promise<CreatedUserApiKey> {
    const name = normalizeName(input.name)
    const { token, hint } = generateToken()
    const row = await withTx(db, async (trx) => {
      const owner = await trx
        .selectFrom('sys_user')
        .select('id')
        .where('id', '=', input.userId)
        .forUpdate()
        .executeTakeFirst()
      if (!owner) throw new ApiError('not_found', '用户不存在')
      const counted = await trx
        .selectFrom('sys_user_api_key')
        .select(trx.fn.countAll<string>().as('count'))
        .where('user_id', '=', input.userId)
        .executeTakeFirstOrThrow()
      if (Number(counted.count) >= API_KEY_MAX_PER_USER) {
        throw new ApiError('conflict', '最多保存 10 个个人 API 密钥，请先撤销不用的')
      }
      return trx
        .insertInto('sys_user_api_key')
        .values({
          user_id: input.userId,
          name,
          token_hash: hashToken(token),
          token_hint: hint,
          expires_at: input.expiresAt,
        })
        .returning(['id', 'name', 'token_hint', 'expires_at', 'last_used_at', 'inserted_at'])
        .executeTakeFirstOrThrow()
    })
    return { ...toDto(row), token }
  }

  async function revoke(userId: string, id: string): Promise<UserApiKeyDto> {
    const row = await db
      .deleteFrom('sys_user_api_key')
      .where('id', '=', id)
      .where('user_id', '=', userId)
      .returning(['id', 'name', 'token_hint', 'expires_at', 'last_used_at', 'inserted_at'])
      .executeTakeFirst()
    if (!row) throw new ApiError('not_found', '密钥不存在')
    return toDto(row)
  }

  /** 前缀不对返回 null；过期/未命中返回 null。命中则节流更新 last_used_at。 */
  async function authenticate(raw: string): Promise<string | null> {
    if (!raw.startsWith(API_KEY_PREFIX)) return null
    const row = await db
      .selectFrom('sys_user_api_key')
      .select(['id', 'user_id', 'expires_at'])
      .where('token_hash', '=', hashToken(raw))
      .executeTakeFirst()
    if (!row) return null
    if (row.expires_at && row.expires_at.getTime() <= Date.now()) return null
    await db
      .updateTable('sys_user_api_key')
      .set({ last_used_at: sql`(now() AT TIME ZONE 'utc')` })
      .where('id', '=', row.id)
      .where(
        sql<boolean>`(last_used_at is null or last_used_at < (now() AT TIME ZONE 'utc') - interval '5 minutes')`,
      )
      .execute()
    return row.user_id
  }

  return { listByUser, create, revoke, authenticate }
}

export type UserApiKeyStore = ReturnType<typeof createUserApiKeyStore>
