/**
 * 待办查询与用户痕迹（已读/个人忽略）。
 * 生产者在对账 confirm / 发票结单接缝；本服务只负责消费侧 API。
 */
import { decimal, toDecimalString, type ListQuery } from '@synie/shared'
import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import { buildListQuery } from '~/db/filterbuild.ts'
import { withTx, type DbHandle } from '~/db/tx.ts'
import type { DB as Database } from '~/db/types.ts'
import {
  companyFilter,
  hasPermission,
  type Actor,
} from '~/platform/authz/actor.ts'
import { ApiError } from '~/platform/http/errors.ts'
import type { ResourceMeta } from '~/platform/meta/types.ts'

export type TodoTab = 'active' | 'history' | 'recent'

export interface TodoListQuery extends Partial<ListQuery> {
  tab?: TodoTab | string
  includeDismissed?: boolean
}

export interface TodoCompany {
  id: string
  name: string
  shortName: string | null
}

export interface TodoUser {
  id: string
  username: string
  name: string | null
}

export interface Todo {
  id: string
  type: string
  sourceType: string
  sourceId: string
  sourceNo: string
  partyType: string
  partyId: string
  partyName: string
  amount: string
  status: string
  closedReason: string | null
  sourceChangedAt: string
  closedAt: string | null
  insertedAt: string
  updatedAt: string
  companyId: string
  company: TodoCompany | null
  createdById: string | null
  createdBy: TodoUser | null
  draftInvoiceLinked: boolean
  myReadAt: string | null
  myDismissedAt: string | null
  dismissed: boolean
}

/** filterbuild 内部 Meta（不注册进公开 Registry） */
function todoQueryMeta(): ResourceMeta {
  return {
    name: '_sysTodosInternal',
    permissionPrefix: 'sys.todo',
    permissionLabel: '待办',
    table: 'sys_todo',
    fields: [
      {
        name: 'id',
        apiName: 'id',
        dbColumn: 'id',
        type: 'uuid',
        label: 'id',
        readonly: true,
        sortable: true,
      },
      {
        name: 'type',
        apiName: 'type',
        dbColumn: 'type',
        type: 'enum',
        label: '待办类型',
        readonly: true,
        filterable: true,
        sortable: true,
        enumOptions: [
          { value: 'ISSUE_INVOICE', label: '开票' },
          { value: 'RECEIVE_INVOICE', label: '收票' },
        ],
      },
      {
        name: 'source_type',
        apiName: 'sourceType',
        dbColumn: 'source_type',
        type: 'string',
        label: '源单据类型',
        readonly: true,
        filterable: true,
        sortable: true,
      },
      {
        name: 'source_id',
        apiName: 'sourceId',
        dbColumn: 'source_id',
        type: 'uuid',
        label: '源单据',
        readonly: true,
        filterable: true,
        sortable: true,
      },
      {
        name: 'source_no',
        apiName: 'sourceNo',
        dbColumn: 'source_no',
        type: 'string',
        label: '源单据号',
        readonly: true,
        filterable: true,
        sortable: true,
      },
      {
        name: 'party_type',
        apiName: 'partyType',
        dbColumn: 'party_type',
        type: 'string',
        label: '对手类型',
        readonly: true,
        filterable: true,
        sortable: true,
      },
      {
        name: 'party_id',
        apiName: 'partyId',
        dbColumn: 'party_id',
        type: 'uuid',
        label: '对手',
        readonly: true,
        filterable: true,
        sortable: true,
      },
      {
        name: 'amount',
        apiName: 'amount',
        dbColumn: 'amount',
        type: 'decimal',
        label: '金额',
        readonly: true,
        filterable: true,
        sortable: true,
      },
      {
        name: 'status',
        apiName: 'status',
        dbColumn: 'status',
        type: 'enum',
        label: '状态',
        readonly: true,
        filterable: true,
        sortable: true,
        enumOptions: [
          { value: 'ACTIVE', label: '活跃' },
          { value: 'CLOSED', label: '已关闭' },
        ],
      },
      {
        name: 'closed_reason',
        apiName: 'closedReason',
        dbColumn: 'closed_reason',
        type: 'enum',
        label: '关闭原因',
        readonly: true,
        filterable: true,
        sortable: true,
        enumOptions: [
          { value: 'UNCONFIRM', label: '撤回确认' },
          { value: 'INVOICE_AUDIT', label: '发票审核结单' },
        ],
      },
      {
        name: 'source_changed_at',
        apiName: 'sourceChangedAt',
        dbColumn: 'source_changed_at',
        type: 'datetime',
        label: '源单变化时间',
        readonly: true,
        filterable: true,
        sortable: true,
      },
      {
        name: 'closed_at',
        apiName: 'closedAt',
        dbColumn: 'closed_at',
        type: 'datetime',
        label: '关闭时间',
        readonly: true,
        filterable: true,
        sortable: true,
      },
      {
        name: 'inserted_at',
        apiName: 'insertedAt',
        dbColumn: 'inserted_at',
        type: 'datetime',
        label: '产生时间',
        readonly: true,
        filterable: true,
        sortable: true,
      },
      {
        name: 'updated_at',
        apiName: 'updatedAt',
        dbColumn: 'updated_at',
        type: 'datetime',
        label: '更新时间',
        readonly: true,
        filterable: true,
        sortable: true,
      },
      {
        name: 'company_id',
        apiName: 'companyId',
        dbColumn: 'company_id',
        type: 'uuid',
        label: '公司',
        readonly: true,
        filterable: true,
        sortable: true,
      },
      {
        name: 'created_by_id',
        apiName: 'createdById',
        dbColumn: 'created_by_id',
        type: 'uuid',
        label: '触发操作人',
        readonly: true,
        filterable: true,
        sortable: true,
      },
    ],
    actions: [],
  }
}

const DETAIL_SELECT = sql`
  todo.id, todo.type, todo.source_type, todo.source_id, todo.source_no,
  todo.party_type, todo.party_id,
  CASE todo.party_type
    WHEN 'customer' THEN COALESCE((SELECT c.name FROM sal_customers c WHERE c.id=todo.party_id),'')
    WHEN 'supplier' THEN COALESCE((SELECT s.name FROM pur_supplier s WHERE s.id=todo.party_id),'')
    ELSE ''
  END AS party_name,
  todo.amount, todo.status, todo.closed_reason, todo.source_changed_at, todo.closed_at,
  todo.inserted_at, todo.updated_at, todo.company_id,
  company.id AS company_row_id, company.name AS company_name, company.short_name AS company_short_name,
  todo.created_by_id,
  created_by.id AS created_by_row_id, created_by.username AS created_by_username,
  created_by.name AS created_by_name,
  CASE todo.source_type
    WHEN 'sales.reconciliation' THEN EXISTS(
      SELECT 1 FROM acc_vat_invoice invoice
      WHERE invoice.sal_reconciliation_id=todo.source_id AND invoice.status='draft')
    WHEN 'purchase.reconciliation' THEN EXISTS(
      SELECT 1 FROM acc_vat_invoice invoice
      WHERE invoice.pur_reconciliation_id=todo.source_id AND invoice.status='draft')
    ELSE false
  END AS draft_invoice_linked,
  state.read_at, state.dismissed_at,
  (state.dismissed_at IS NOT NULL AND state.reset_basis_at IS NOT NULL
   AND state.reset_basis_at=todo.source_changed_at) AS dismissed`

export type TodoService = ReturnType<typeof createTodoService>

export function createTodoService(db: Kysely<Database>) {
  async function list(
    actor: Actor,
    query: TodoListQuery,
  ): Promise<{ count: number; results: Todo[] }> {
    if (!hasPermission(actor, 'acc.vat_invoice:create')) {
      throw new ApiError('forbidden', '无权限查看待办')
    }
    let limit = query.limit === undefined || query.limit === 0 ? 20 : query.limit
    const offset = query.offset ?? 0
    const tab = (query.tab && query.tab !== '' ? query.tab : 'active').toLowerCase()
    if (tab === 'recent') limit = 8
    if (limit < 1 || limit > 200 || offset < 0) {
      throw ApiError.validation('分页参数不合法', {
        limit: ['必须在 1 到 200 之间且 offset 不能为负数'],
      })
    }

    const listQuery: ListQuery = {
      limit,
      offset,
      search: query.search,
      sort: query.sort,
      filter: query.filter,
    }
    const built = buildListQuery(todoQueryMeta(), listQuery)
    const parts: ReturnType<typeof sql>[] = []
    if (built.where) parts.push(built.where)

    const scope = companyFilter(actor)
    if (!scope.bypass) {
      if (scope.ids.length === 0) {
        parts.push(sql`false`)
      } else {
        parts.push(sql`"company_id"=ANY(${[...scope.ids]}::uuid[])`)
      }
    }

    if (tab === 'active' || tab === 'recent') {
      parts.push(sql`"status"='active'`)
    } else if (tab === 'history') {
      parts.push(sql`"status"='closed'`)
    }

    if ((tab === 'active' || tab === 'recent') && !query.includeDismissed) {
      parts.push(sql`NOT EXISTS (
        SELECT 1 FROM sys_todo_state dismissed_state
        WHERE dismissed_state.todo_id=sys_todo.id
          AND dismissed_state.user_id=${actor.userId}::uuid
          AND dismissed_state.dismissed_at IS NOT NULL
          AND dismissed_state.reset_basis_at=sys_todo.source_changed_at
      )`)
    }

    const whereSql =
      parts.length > 0 ? sql` WHERE ${sql.join(parts, sql` AND `)}` : sql``

    let orderSql = sql` ORDER BY todo.inserted_at DESC, todo.id DESC`
    if (built.orderBy) {
      // filterbuild 产出无表前缀列；CTE 内加 todo. 前缀会歧义，故用默认排序为主路径
      orderSql = sql` ORDER BY todo.inserted_at DESC, todo.id DESC`
    }

    const countRow = await sql<{ count: string }>`
      SELECT count(*)::text AS count FROM sys_todo${whereSql}
    `.execute(db)
    const count = Number(countRow.rows[0]?.count ?? 0)

    const rows = await sql<Record<string, unknown>>`
      WITH visible AS (SELECT * FROM sys_todo${whereSql})
      SELECT ${DETAIL_SELECT}
      FROM visible todo
      JOIN bas_company company ON company.id=todo.company_id
      LEFT JOIN sys_user created_by ON created_by.id=todo.created_by_id
      LEFT JOIN sys_todo_state state
        ON state.todo_id=todo.id AND state.user_id=${actor.userId}::uuid
      ${orderSql}
      LIMIT ${limit} OFFSET ${offset}
    `.execute(db)

    return { count, results: rows.rows.map(mapTodo) }
  }

  async function markRead(actor: Actor, id: string): Promise<Todo> {
    return changeState(actor, id, false)
  }

  async function dismiss(actor: Actor, id: string): Promise<Todo> {
    return changeState(actor, id, true)
  }

  async function changeState(
    actor: Actor,
    id: string,
    doDismiss: boolean,
  ): Promise<Todo> {
    if (!hasPermission(actor, 'acc.vat_invoice:create')) {
      throw new ApiError('forbidden', '无权限操作待办')
    }
    if (!actor.userId) {
      throw new ApiError('forbidden', '待办操作缺少用户身份')
    }
    return withTx(db, async (trx) => {
      const scope = companyFilter(actor)
      const locked = await sql<{ id: string }>`
        SELECT id FROM sys_todo
        WHERE id=${id}::uuid
          AND (${scope.bypass} OR company_id=ANY(${[...scope.ids]}::uuid[]))
        FOR UPDATE
      `.execute(trx)
      if (locked.rows.length === 0) {
        throw new ApiError('not_found', '待办不存在或无权访问')
      }
      if (doDismiss) {
        // reset_basis_at 直接取库内 source_changed_at，避免 JS Date 精度漂移导致 dismissed 判定失败
        await sql`
          INSERT INTO sys_todo_state(todo_id,user_id,read_at,dismissed_at,reset_basis_at)
          SELECT ${id}::uuid, ${actor.userId}::uuid,
            (now() AT TIME ZONE 'utc'),
            (now() AT TIME ZONE 'utc'),
            t.source_changed_at
          FROM sys_todo t WHERE t.id=${id}::uuid
          ON CONFLICT(todo_id,user_id) DO UPDATE SET
            read_at=COALESCE(EXCLUDED.read_at,sys_todo_state.read_at),
            dismissed_at=COALESCE(EXCLUDED.dismissed_at,sys_todo_state.dismissed_at),
            reset_basis_at=COALESCE(EXCLUDED.reset_basis_at,sys_todo_state.reset_basis_at),
            updated_at=(now() AT TIME ZONE 'utc')
        `.execute(trx)
      } else {
        await sql`
          INSERT INTO sys_todo_state(todo_id,user_id,read_at,dismissed_at,reset_basis_at)
          VALUES(
            ${id}::uuid, ${actor.userId}::uuid,
            (now() AT TIME ZONE 'utc'), NULL, NULL
          )
          ON CONFLICT(todo_id,user_id) DO UPDATE SET
            read_at=COALESCE(EXCLUDED.read_at,sys_todo_state.read_at),
            updated_at=(now() AT TIME ZONE 'utc')
        `.execute(trx)
      }
      await sql`
        UPDATE sys_todo SET updated_at=(now() AT TIME ZONE 'utc') WHERE id=${id}::uuid
      `.execute(trx)
      return queryById(trx, id, actor.userId)
    })
  }

  async function unreadCount(actor: Actor): Promise<number> {
    if (!hasPermission(actor, 'acc.vat_invoice:read')) {
      throw new ApiError('forbidden', '无权限查看待办')
    }
    const scope = companyFilter(actor)
    const row = await sql<{ count: string }>`
      SELECT count(*)::text AS count
      FROM sys_todo todo
      LEFT JOIN sys_todo_state state
        ON state.todo_id=todo.id AND state.user_id=${actor.userId}::uuid
      WHERE todo.status='active'
        AND (${scope.bypass} OR todo.company_id=ANY(${[...scope.ids]}::uuid[]))
        AND state.read_at IS NULL
        AND NOT (
          state.dismissed_at IS NOT NULL
          AND state.reset_basis_at IS NOT NULL
          AND state.reset_basis_at=todo.source_changed_at
        )
    `.execute(db)
    return Number(row.rows[0]?.count ?? 0)
  }

  return { list, markRead, dismiss, unreadCount }
}

async function queryById(db: DbHandle, id: string, userId: string): Promise<Todo> {
  const rows = await sql<Record<string, unknown>>`
    SELECT ${DETAIL_SELECT}
    FROM sys_todo todo
    JOIN bas_company company ON company.id=todo.company_id
    LEFT JOIN sys_user created_by ON created_by.id=todo.created_by_id
    LEFT JOIN sys_todo_state state
      ON state.todo_id=todo.id AND state.user_id=${userId}::uuid
    WHERE todo.id=${id}::uuid
  `.execute(db)
  if (rows.rows.length === 0) {
    throw new ApiError('not_found', '待办不存在或无权访问')
  }
  return mapTodo(rows.rows[0]!)
}

function mapTodo(row: Record<string, unknown>): Todo {
  const createdById = row.created_by_id != null ? String(row.created_by_id) : null
  const createdByRowId =
    row.created_by_row_id != null ? String(row.created_by_row_id) : null
  const createdByUsername =
    row.created_by_username != null ? String(row.created_by_username) : null
  const closedReason =
    row.closed_reason != null ? String(row.closed_reason).toUpperCase() : null
  return {
    id: String(row.id),
    type: String(row.type).toUpperCase(),
    sourceType: String(row.source_type),
    sourceId: String(row.source_id),
    sourceNo: String(row.source_no),
    partyType: String(row.party_type).toUpperCase(),
    partyId: String(row.party_id),
    partyName: row.party_name != null ? String(row.party_name) : '',
    amount: toDecimalString(decimal(String(row.amount ?? 0))),
    status: String(row.status).toUpperCase(),
    closedReason,
    sourceChangedAt: toIso(row.source_changed_at)!,
    closedAt: toIso(row.closed_at),
    insertedAt: toIso(row.inserted_at)!,
    updatedAt: toIso(row.updated_at)!,
    companyId: String(row.company_id),
    company: {
      id: String(row.company_row_id ?? row.company_id),
      name: String(row.company_name ?? ''),
      shortName: row.company_short_name != null ? String(row.company_short_name) : null,
    },
    createdById,
    createdBy:
      createdByRowId && createdByUsername
        ? {
            id: createdByRowId,
            username: createdByUsername,
            name: row.created_by_name != null ? String(row.created_by_name) : null,
          }
        : null,
    draftInvoiceLinked: Boolean(row.draft_invoice_linked),
    myReadAt: toIso(row.read_at),
    myDismissedAt: toIso(row.dismissed_at),
    dismissed: Boolean(row.dismissed),
  }
}

function toIso(value: unknown): string | null {
  if (value == null) return null
  if (value instanceof Date) return value.toISOString()
  return new Date(String(value)).toISOString()
}
