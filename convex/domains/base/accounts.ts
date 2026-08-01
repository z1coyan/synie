import { v } from 'convex/values'
import type { Doc, Id } from '../../_generated/dataModel'
import { permissionedMutation, permissionedQuery } from '../../lib/auth'
import { canAccessCompany } from '../../lib/companyScope'
import { asDomainMutationCtx } from '../../lib/mutationContext'
import { synieError, validationError } from '../../lib/errors'
import { paginationOptions, requireSearchTerm, resourcePage } from '../../lib/pagination'
import { changedFields } from '../../platform/audit/model'
import { writeAudit } from '../../platform/audit/write'
import accountTemplates from './accountTemplates.json'

const ROLES = new Set(['unbilled_receivable','receivable','advance_received','unbilled_payable','payable','other_payable','advance_paid','travel','office','entertainment','transport','other_expense'])
function requireCompanyAccess(actor: Parameters<typeof canAccessCompany>[0], companyId: string): void { if (!canAccessCompany(actor, companyId)) throw synieError('forbidden', '无权访问该公司') }
function present(row: Doc<'accounts'>) { return { id: row._id, code: row.code, name: row.name, direction: row.direction, isGroup: row.isGroup, active: row.active, role: row.role, parentId: row.parentId, companyId: row.companyId, currencyId: row.currencyId, insertedAt: row.insertedAt, updatedAt: row.updatedAt } }
function normalize(args: { code: string; name: string; direction: string; isGroup?: boolean; active?: boolean; role?: string | null }) {
  const code = args.code.trim(); const name = args.name.trim(); const direction = args.direction.trim().toUpperCase()
  if (!code || code.length > 32 || !name || name.length > 128 || !['DEBIT','CREDIT'].includes(direction)) throw synieError('validation', '会计科目参数不合法')
  let role = args.role?.trim() || null
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
export const get = permissionedQuery('base.account:read')({ args: { id: v.id('accounts') }, returns: v.any(), handler: async (ctx,args) => { const row=await ctx.db.get(args.id); if (!row) return null; requireCompanyAccess(ctx.actor,row.companyId); return present(row) } })
export const list = permissionedQuery('base.account:read')({
  args: { profile:v.union(v.literal('default'),v.literal('treeChildren'),v.literal('search')),numItems:v.number(),cursor:v.optional(v.union(v.string(),v.null())),search:v.optional(v.string()),companyId:v.id('companies'),parentId:v.optional(v.union(v.id('accounts'),v.null())) }, returns:v.any(),
  handler: async(ctx,args)=>{ requireCompanyAccess(ctx.actor,args.companyId); const o=paginationOptions(args); const page=args.profile==='search'
    ? await ctx.db.query('accounts').withSearchIndex('search_text',q=>q.search('searchText',requireSearchTerm(args.search)).eq('companyId',args.companyId)).paginate(o)
    : args.profile==='treeChildren'
      ? await ctx.db.query('accounts').withIndex('by_company_parent_code_key',q=>q.eq('companyId',args.companyId).eq('parentId',args.parentId??null)).paginate(o)
      : await ctx.db.query('accounts').withIndex('by_company_code_key',q=>q.eq('companyId',args.companyId)).paginate(o); return resourcePage({...page,page:page.page.map(present)}) }
})
export const create = permissionedMutation('base.account:create')({
  args:{code:v.string(),name:v.string(),direction:v.string(),isGroup:v.optional(v.boolean()),active:v.optional(v.boolean()),role:v.optional(v.union(v.string(),v.null())),parentId:v.optional(v.union(v.id('accounts'),v.null())),companyId:v.id('companies'),currencyId:v.optional(v.union(v.id('currencies'),v.null()))},returns:v.any(),
  handler:async(ctx,args)=>{requireCompanyAccess(ctx.actor,args.companyId);const n=normalize(args);if(await ctx.db.query('accounts').withIndex('by_company_code_key',q=>q.eq('companyId',args.companyId).eq('codeKey',n.codeKey)).unique())throw synieError('conflict','同一公司内科目编码不能重复');await relations(ctx,args.companyId,args.parentId??null,args.currencyId??null);const now=Date.now();const id=await ctx.db.insert('accounts',{...n,parentId:args.parentId??null,companyId:args.companyId,currencyId:args.currencyId??null,searchText:`${n.code} ${n.name}`.toLocaleLowerCase(),insertedAt:now,updatedAt:now});const row=(await ctx.db.get(id))!;await writeAudit(asDomainMutationCtx(ctx),ctx.actor,{resource:'basAccounts',recordId:id,recordLabel:row.name,companyId:row.companyId,action:'create',changes:present(row)});return present(row)}
})
export const update = permissionedMutation('base.account:update')({args:{id:v.id('accounts'),name:v.optional(v.string()),direction:v.optional(v.string()),isGroup:v.optional(v.boolean()),active:v.optional(v.boolean()),role:v.optional(v.union(v.string(),v.null())),parentId:v.optional(v.union(v.id('accounts'),v.null())),currencyId:v.optional(v.union(v.id('currencies'),v.null()))},returns:v.any(),handler:async(ctx,args)=>{const row=await ctx.db.get(args.id);if(!row)throw synieError('not_found','会计科目不存在');requireCompanyAccess(ctx.actor,row.companyId);const before=present(row);const n=normalize({code:row.code,name:args.name??row.name,direction:args.direction??row.direction,isGroup:args.isGroup??row.isGroup,active:args.active??row.active,role:args.role===undefined?row.role:args.role});const parentId=args.parentId===undefined?row.parentId:args.parentId;const currencyId=args.currencyId===undefined?row.currencyId:args.currencyId;await relations(ctx,row.companyId,parentId,currencyId,row._id);await ctx.db.patch(row._id,{...n,parentId,currencyId,searchText:`${n.code} ${n.name}`.toLocaleLowerCase(),updatedAt:Date.now()});const after=present((await ctx.db.get(row._id))!);const changes=changedFields(before,after);if(Object.keys(changes).length)await writeAudit(asDomainMutationCtx(ctx),ctx.actor,{resource:'basAccounts',recordId:row._id,recordLabel:after.name,companyId:row.companyId,action:'update',changes});return after}})
export const remove = permissionedMutation('base.account:delete')({args:{id:v.id('accounts')},returns:v.null(),handler:async(ctx,args)=>{const row=await ctx.db.get(args.id);if(!row)throw synieError('not_found','会计科目不存在');requireCompanyAccess(ctx.actor,row.companyId);if(await ctx.db.query('accounts').withIndex('by_parent',q=>q.eq('parentId',row._id)).first())throw synieError('conflict','存在子科目，不能删除');const fact=await ctx.db.query('glEntries').withIndex('by_company_account_date',q=>q.eq('companyId',row.companyId).eq('accountId',row._id)).first();if(fact)throw synieError('conflict','会计科目已被引用，不能删除');await ctx.db.delete(row._id);await writeAudit(asDomainMutationCtx(ctx),ctx.actor,{resource:'basAccounts',recordId:row._id,recordLabel:row.name,companyId:row.companyId,action:'destroy',changes:present(row)});return null}})

type TemplateEntry = { code:string; name:string; parent:string|null; direction:string; role:string|null; is_group:boolean }
const templates = accountTemplates as Record<string,TemplateEntry[]>

export const initializeTemplate = permissionedMutation('base.account:create')({
  args:{companyId:v.id('companies'),template:v.string()},returns:v.object({createdCount:v.number()}),
  handler:async(ctx,args)=>{
    requireCompanyAccess(ctx.actor,args.companyId)
    const entries=templates[args.template.trim().toLocaleLowerCase()]
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
      await writeAudit(asDomainMutationCtx(ctx),ctx.actor,{resource:'basAccounts',recordId:id,recordLabel:entry.name,companyId:args.companyId,action:'init_from_template',changes:{code:entry.code,name:entry.name,direction:entry.direction,isGroup:entry.is_group,role:entry.role,parentId}})
    }
    return{createdCount:entries.length}
  }
})
