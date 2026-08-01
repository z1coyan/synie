import { v } from 'convex/values'
import type { PaginationResult } from 'convex/server'
import type { Doc, Id } from '../../_generated/dataModel'
import type { QueryCtx } from '../../_generated/server'
import { permissionedMutation, permissionedQuery } from '../../lib/auth'
import { canAccessCompany } from '../../lib/companyScope'
import { asDomainMutationCtx } from '../../lib/mutationContext'
import { synieError, validationError } from '../../lib/errors'
import { paginationOptions, rejectSearch, requireSearchTerm, resourcePage } from '../../lib/pagination'
import { changedFields } from '../../platform/audit/model'
import { writeAudit } from '../../platform/audit/write'
import accountTemplates from './accountTemplates.json'
import type { Actor } from '../../lib/actor'
import type { DomainMutationCtx } from '../../lib/mutationContext'

export const ACCOUNT_ROLES = [
  'unbilled_receivable',
  'receivable',
  'advance_received',
  'unbilled_payable',
  'payable',
  'other_payable',
  'advance_paid',
  'travel',
  'office',
  'entertainment',
  'transport',
  'other_expense',
] as const
type AccountRole = (typeof ACCOUNT_ROLES)[number]
const ROLES = new Set<string>(ACCOUNT_ROLES)
const accountRole = v.union(
  v.literal('unbilled_receivable'),
  v.literal('receivable'),
  v.literal('advance_received'),
  v.literal('unbilled_payable'),
  v.literal('payable'),
  v.literal('other_payable'),
  v.literal('advance_paid'),
  v.literal('travel'),
  v.literal('office'),
  v.literal('entertainment'),
  v.literal('transport'),
  v.literal('other_expense'),
)
function requireCompanyAccess(actor: Parameters<typeof canAccessCompany>[0], companyId: string): void { if (!canAccessCompany(actor, companyId)) throw synieError('forbidden', '无权访问该公司') }
export function presentAccount(row: Doc<'accounts'>) { return { id: row._id, code: row.code, name: row.name, direction: row.direction, isGroup: row.isGroup, active: row.active, role: row.role?.toLocaleUpperCase() ?? null, parentId: row.parentId, companyId: row.companyId, currencyId: row.currencyId, insertedAt: row.insertedAt, updatedAt: row.updatedAt } }
function normalize(args: { code: string; name: string; direction: string; isGroup?: boolean; active?: boolean; role?: string | null }) {
  const code = args.code.trim(); const name = args.name.trim(); const direction = args.direction.trim().toUpperCase()
  if (!code || code.length > 32 || !name || name.length > 128 || !['DEBIT','CREDIT'].includes(direction)) throw synieError('validation', '会计科目参数不合法')
  let role = args.role?.trim().toLocaleLowerCase() || null
  if (args.isGroup) role = null
  if (role && !ROLES.has(role)) throw validationError('会计科目参数不合法', { role: ['未知科目角色'] })
  return { code, codeKey: code.toLocaleLowerCase(), name, direction: direction as 'DEBIT' | 'CREDIT', isGroup: args.isGroup ?? false, active: args.active ?? true, role }
}
async function relations(ctx: { db: any }, companyId: Id<'companies'>, parentId: Id<'accounts'> | null, currencyId: Id<'currencies'> | null, self?: Id<'accounts'>) {
  if (!(await ctx.db.get(companyId))) throw synieError('validation', '公司不存在')
  if (currencyId && !(await ctx.db.get(currencyId))) throw synieError('validation', '币种不存在')
  let cursor = parentId
  for (let depth = 0; cursor; depth += 1) {
    if (depth >= 100 || cursor === self) throw synieError('validation', '上级科目形成循环')
    const parent = await ctx.db.get(cursor) as Doc<'accounts'> | null
    if (!parent || parent.companyId !== companyId) throw synieError('validation', '上级科目不存在或不属于同一公司')
    cursor = parent.parentId
  }
}
export const get = permissionedQuery('base.account:read')({ args: { id: v.id('accounts') }, returns: v.any(), handler: async (ctx,args) => { const row=await ctx.db.get(args.id); if (!row) return null; requireCompanyAccess(ctx.actor,row.companyId); return presentAccount(row) } })

type AccountListArgs = {
  profile: 'default' | 'lookup' | 'treeChildren' | 'search'
  numItems: number
  cursor?: string | null
  search?: string
  companyId: Id<'companies'>
  parentId?: Id<'accounts'> | null
  active?: boolean
  isGroup?: boolean
  role?: AccountRole
}

function hasLookupFilters(args: AccountListArgs): boolean {
  return args.active !== undefined || args.isGroup !== undefined || args.role !== undefined
}

/** Indexed query seam kept separate so profile/cursor behavior is testable without bypassing auth. */
export async function paginateAccountDocs(
  db: QueryCtx['db'],
  args: AccountListArgs,
): Promise<PaginationResult<Doc<'accounts'>>> {
  const options = paginationOptions(args)

  if (args.profile === 'search') {
    if (args.parentId !== undefined) throw synieError('validation', 'search profile 不接受 parentId 参数')
    const term = requireSearchTerm(args.search)
    if (args.active !== undefined && args.isGroup !== undefined && args.role !== undefined) {
      return db.query('accounts').withSearchIndex('search_text', (query) => query
        .search('searchText', term)
        .eq('companyId', args.companyId)
        .eq('active', args.active!)
        .eq('isGroup', args.isGroup!)
        .eq('role', args.role!)).paginate(options)
    }
    if (args.active !== undefined && args.isGroup !== undefined) {
      return db.query('accounts').withSearchIndex('search_text', (query) => query
        .search('searchText', term)
        .eq('companyId', args.companyId)
        .eq('active', args.active!)
        .eq('isGroup', args.isGroup!)).paginate(options)
    }
    if (args.active !== undefined && args.role !== undefined) {
      return db.query('accounts').withSearchIndex('search_text', (query) => query
        .search('searchText', term)
        .eq('companyId', args.companyId)
        .eq('active', args.active!)
        .eq('role', args.role!)).paginate(options)
    }
    if (args.isGroup !== undefined && args.role !== undefined) {
      return db.query('accounts').withSearchIndex('search_text', (query) => query
        .search('searchText', term)
        .eq('companyId', args.companyId)
        .eq('isGroup', args.isGroup!)
        .eq('role', args.role!)).paginate(options)
    }
    if (args.active !== undefined) {
      return db.query('accounts').withSearchIndex('search_text', (query) => query
        .search('searchText', term)
        .eq('companyId', args.companyId)
        .eq('active', args.active!)).paginate(options)
    }
    if (args.isGroup !== undefined) {
      return db.query('accounts').withSearchIndex('search_text', (query) => query
        .search('searchText', term)
        .eq('companyId', args.companyId)
        .eq('isGroup', args.isGroup!)).paginate(options)
    }
    if (args.role !== undefined) {
      return db.query('accounts').withSearchIndex('search_text', (query) => query
        .search('searchText', term)
        .eq('companyId', args.companyId)
        .eq('role', args.role!)).paginate(options)
    }
    return db.query('accounts').withSearchIndex('search_text', (query) => query
      .search('searchText', term)
      .eq('companyId', args.companyId)).paginate(options)
  }

  rejectSearch(args.search)
  if (args.profile === 'treeChildren') {
    if (hasLookupFilters(args)) throw synieError('validation', 'treeChildren profile 不接受候选筛选参数')
    return db.query('accounts')
      .withIndex('by_company_parent_code_key', (query) => query
        .eq('companyId', args.companyId)
        .eq('parentId', args.parentId ?? null))
      .order('asc')
      .paginate(options)
  }
  if (args.parentId !== undefined) throw synieError('validation', `${args.profile} profile 不接受 parentId 参数`)
  if (args.profile === 'default') {
    if (hasLookupFilters(args)) throw synieError('validation', 'default profile 不接受候选筛选参数')
    return db.query('accounts')
      .withIndex('by_company_code_key', (query) => query.eq('companyId', args.companyId))
      .order('asc')
      .paginate(options)
  }

  if (args.active !== undefined && args.isGroup !== undefined && args.role !== undefined) {
    return db.query('accounts')
      .withIndex('by_company_active_is_group_role_code_key', (query) => query
        .eq('companyId', args.companyId)
        .eq('active', args.active!)
        .eq('isGroup', args.isGroup!)
        .eq('role', args.role!))
      .order('asc')
      .paginate(options)
  }
  if (args.active !== undefined && args.isGroup !== undefined) {
    return db.query('accounts')
      .withIndex('by_company_active_is_group_code_key', (query) => query
        .eq('companyId', args.companyId)
        .eq('active', args.active!)
        .eq('isGroup', args.isGroup!))
      .order('asc')
      .paginate(options)
  }
  if (args.active !== undefined && args.role !== undefined) {
    return db.query('accounts')
      .withIndex('by_company_active_role_code_key', (query) => query
        .eq('companyId', args.companyId)
        .eq('active', args.active!)
        .eq('role', args.role!))
      .order('asc')
      .paginate(options)
  }
  if (args.isGroup !== undefined && args.role !== undefined) {
    return db.query('accounts')
      .withIndex('by_company_is_group_role_code_key', (query) => query
        .eq('companyId', args.companyId)
        .eq('isGroup', args.isGroup!)
        .eq('role', args.role!))
      .order('asc')
      .paginate(options)
  }
  if (args.active !== undefined) {
    return db.query('accounts')
      .withIndex('by_company_active_code_key', (query) => query
        .eq('companyId', args.companyId)
        .eq('active', args.active!))
      .order('asc')
      .paginate(options)
  }
  if (args.isGroup !== undefined) {
    return db.query('accounts')
      .withIndex('by_company_is_group_code_key', (query) => query
        .eq('companyId', args.companyId)
        .eq('isGroup', args.isGroup!))
      .order('asc')
      .paginate(options)
  }
  if (args.role !== undefined) {
    return db.query('accounts')
      .withIndex('by_company_role_code_key', (query) => query
        .eq('companyId', args.companyId)
        .eq('role', args.role!))
      .order('asc')
      .paginate(options)
  }
  return db.query('accounts')
    .withIndex('by_company_code_key', (query) => query.eq('companyId', args.companyId))
    .order('asc')
    .paginate(options)
}

export const list = permissionedQuery('base.account:read')({
  args: {
    profile: v.union(v.literal('default'), v.literal('lookup'), v.literal('treeChildren'), v.literal('search')),
    numItems: v.number(),
    cursor: v.optional(v.union(v.string(), v.null())),
    search: v.optional(v.string()),
    companyId: v.id('companies'),
    parentId: v.optional(v.union(v.id('accounts'), v.null())),
    active: v.optional(v.boolean()),
    isGroup: v.optional(v.boolean()),
    role: v.optional(accountRole),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireCompanyAccess(ctx.actor, args.companyId)
    const page = await paginateAccountDocs(ctx.db, args)
    return resourcePage({ ...page, page: page.page.map(presentAccount) })
  },
})
export const create = permissionedMutation('base.account:create')({
  args:{code:v.string(),name:v.string(),direction:v.string(),isGroup:v.optional(v.boolean()),active:v.optional(v.boolean()),role:v.optional(v.union(v.string(),v.null())),parentId:v.optional(v.union(v.id('accounts'),v.null())),companyId:v.id('companies'),currencyId:v.optional(v.union(v.id('currencies'),v.null()))},returns:v.any(),
  handler:async(ctx,args)=>{requireCompanyAccess(ctx.actor,args.companyId);const n=normalize(args);if(await ctx.db.query('accounts').withIndex('by_company_code_key',q=>q.eq('companyId',args.companyId).eq('codeKey',n.codeKey)).unique())throw synieError('conflict','同一公司内科目编码不能重复');await relations(ctx,args.companyId,args.parentId??null,args.currencyId??null);const now=Date.now();const id=await ctx.db.insert('accounts',{...n,parentId:args.parentId??null,companyId:args.companyId,currencyId:args.currencyId??null,searchText:`${n.code} ${n.name}`.toLocaleLowerCase(),insertedAt:now,updatedAt:now});const row=(await ctx.db.get(id))!;await writeAudit(asDomainMutationCtx(ctx),ctx.actor,{resource:'basAccounts',recordId:id,recordLabel:row.name,companyId:row.companyId,action:'create',changes:presentAccount(row)});return presentAccount(row)}
})
export const update = permissionedMutation('base.account:update')({args:{id:v.id('accounts'),name:v.optional(v.string()),direction:v.optional(v.string()),isGroup:v.optional(v.boolean()),active:v.optional(v.boolean()),role:v.optional(v.union(v.string(),v.null())),parentId:v.optional(v.union(v.id('accounts'),v.null())),currencyId:v.optional(v.union(v.id('currencies'),v.null()))},returns:v.any(),handler:async(ctx,args)=>{const row=await ctx.db.get(args.id);if(!row)throw synieError('not_found','会计科目不存在');requireCompanyAccess(ctx.actor,row.companyId);const before=presentAccount(row);const n=normalize({code:row.code,name:args.name??row.name,direction:args.direction??row.direction,isGroup:args.isGroup??row.isGroup,active:args.active??row.active,role:args.role===undefined?row.role:args.role});const parentId=args.parentId===undefined?row.parentId:args.parentId;const currencyId=args.currencyId===undefined?row.currencyId:args.currencyId;await relations(ctx,row.companyId,parentId,currencyId,row._id);await ctx.db.patch(row._id,{...n,parentId,currencyId,searchText:`${n.code} ${n.name}`.toLocaleLowerCase(),updatedAt:Date.now()});const after=presentAccount((await ctx.db.get(row._id))!);const changes=changedFields(before,after);if(Object.keys(changes).length)await writeAudit(asDomainMutationCtx(ctx),ctx.actor,{resource:'basAccounts',recordId:row._id,recordLabel:after.name,companyId:row.companyId,action:'update',changes});return after}})
export const remove = permissionedMutation('base.account:delete')({args:{id:v.id('accounts')},returns:v.null(),handler:async(ctx,args)=>{const row=await ctx.db.get(args.id);if(!row)throw synieError('not_found','会计科目不存在');requireCompanyAccess(ctx.actor,row.companyId);if(await ctx.db.query('accounts').withIndex('by_parent',q=>q.eq('parentId',row._id)).first())throw synieError('conflict','存在子科目，不能删除');const fact=await ctx.db.query('glEntries').withIndex('by_company_account_date',q=>q.eq('companyId',row.companyId).eq('accountId',row._id)).first();if(fact)throw synieError('conflict','会计科目已被引用，不能删除');await ctx.db.delete(row._id);await writeAudit(asDomainMutationCtx(ctx),ctx.actor,{resource:'basAccounts',recordId:row._id,recordLabel:row.name,companyId:row.companyId,action:'destroy',changes:presentAccount(row)});return null}})

type TemplateEntry = { code:string; name:string; parent:string|null; direction:string; role:string|null; is_group:boolean }
export const ACCOUNT_TEMPLATES = accountTemplates as Record<string,TemplateEntry[]>

export async function initializeAccountTemplateInMutation(
  ctx: DomainMutationCtx,
  actor: Actor,
  args: { companyId: Id<'companies'>; template: string },
): Promise<{ createdCount: number }> {
    requireCompanyAccess(actor,args.companyId)
    const entries=ACCOUNT_TEMPLATES[args.template.trim().toLocaleLowerCase()]
    if(!entries)throw validationError('会计科目模板参数不合法',{template:['仅支持 CAS/SMALL/INTL']})
    if(!(await ctx.db.get(args.companyId)))throw validationError('会计科目模板参数不合法',{companyId:['公司不存在']})
    if(await ctx.db.query('accounts').withIndex('by_company_code_key',q=>q.eq('companyId',args.companyId)).first())throw synieError('conflict','该公司已有会计科目，不能重复初始化')
    const parents=new Map<string,Id<'accounts'>>()
    for(const entry of entries){
      const parentId=entry.parent?parents.get(entry.parent)??null:null
      if(entry.parent&&!parentId)throw synieError('internal','会计科目模板父子顺序不合法')
      const now=Date.now(),codeKey=entry.code.toLocaleLowerCase()
      const id=await ctx.db.insert('accounts',{code:entry.code,codeKey,name:entry.name,direction:entry.direction.toUpperCase() as 'DEBIT'|'CREDIT',isGroup:entry.is_group,active:true,role:entry.role?.toLocaleLowerCase()??null,parentId,companyId:args.companyId,currencyId:null,searchText:`${entry.code} ${entry.name}`.toLocaleLowerCase(),insertedAt:now,updatedAt:now})
      parents.set(entry.code,id)
      await writeAudit(ctx,actor,{resource:'basAccounts',recordId:id,recordLabel:entry.name,companyId:args.companyId,action:'init_from_template',changes:{code:entry.code,name:entry.name,direction:entry.direction,isGroup:entry.is_group,role:entry.role,parentId}})
    }
    return{createdCount:entries.length}
}

export const initializeTemplate = permissionedMutation('base.account:create')({
  args:{companyId:v.id('companies'),template:v.string()},returns:v.object({createdCount:v.number()}),
  handler:(ctx,args)=>initializeAccountTemplateInMutation(asDomainMutationCtx(ctx),ctx.actor,args)
})
