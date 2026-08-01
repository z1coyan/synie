import { v } from 'convex/values'
import { permissionedQuery } from '../../lib/auth'
import { canAccessCompany } from '../../lib/companyScope'
import { synieError } from '../../lib/errors'
import { paginationOptions, resourcePage } from '../../lib/pagination'

export const listRoles = permissionedQuery('sys.role:read')({args:{numItems:v.number(),cursor:v.optional(v.union(v.string(),v.null()))},returns:v.any(),handler:async(ctx,args)=>{const page=await ctx.db.query('iamRoles').withIndex('by_code').paginate(paginationOptions(args));return resourcePage({...page,page:page.page.map(row=>({id:row._id,code:row.code,name:row.name,enabled:row.enabled,builtin:row.builtin}))})}})
export const getRole = permissionedQuery('sys.role:read')({args:{id:v.id('iamRoles')},returns:v.any(),handler:async(ctx,args)=>{const row=await ctx.db.get(args.id);return row?{id:row._id,code:row.code,name:row.name,enabled:row.enabled,builtin:row.builtin}:null}})
export const listUsers = permissionedQuery('sys.user:read')({args:{numItems:v.number(),cursor:v.optional(v.union(v.string(),v.null()))},returns:v.any(),handler:async(ctx,args)=>{const page=await ctx.db.query('appUsers').withIndex('by_username_key').paginate(paginationOptions(args));return resourcePage({...page,page:page.page.map(row=>({id:row._id,username:row.username,name:row.name,enabled:row.enabled,superAdmin:row.superAdmin,allCompanies:row.allCompanies}))})}})
export const getUser = permissionedQuery('sys.user:read')({args:{id:v.id('appUsers')},returns:v.any(),handler:async(ctx,args)=>{const row=await ctx.db.get(args.id);return row?{id:row._id,username:row.username,name:row.name,enabled:row.enabled,superAdmin:row.superAdmin,allCompanies:row.allCompanies}:null}})
export const getUserAccess = permissionedQuery('sys.user:read')({args:{id:v.id('appUsers')},returns:v.any(),handler:async(ctx,args)=>{
  const user=await ctx.db.get(args.id);if(!user)throw synieError('not_found','用户不存在')
  const [roleLinks,companyLinks]=await Promise.all([
    ctx.db.query('iamUserRoles').withIndex('by_user',q=>q.eq('userId',user._id)).collect(),
    ctx.db.query('iamUserCompanies').withIndex('by_user',q=>q.eq('userId',user._id)).collect(),
  ])
  const roles=[] as Array<{id:string;name:string}>
  for(const link of roleLinks){const role=await ctx.db.get(link.roleId);if(role)roles.push({id:role._id,name:role.name})}
  const companies=[] as Array<{id:string;name:string}>
  for(const link of companyLinks){const company=await ctx.db.get(link.companyId as any);if(company&&'name'in company)companies.push({id:String(company._id),name:String(company.name)})}
  return{roles,companies}
}})
export const listRolePermissions = permissionedQuery('sys.role_permission:read')({args:{numItems:v.number(),cursor:v.optional(v.union(v.string(),v.null())),roleId:v.id('iamRoles')},returns:v.any(),handler:async(ctx,args)=>{const page=await ctx.db.query('iamRolePermissions').withIndex('by_role',q=>q.eq('roleId',args.roleId)).paginate(paginationOptions(args));return resourcePage({...page,page:page.page.map(row=>({id:row._id,roleId:row.roleId,permission:row.permission}))})}})
export const listAudit = permissionedQuery('sys.audit_log:read')({
  args: {
    numItems: v.number(),
    cursor: v.optional(v.union(v.string(), v.null())),
    companyId: v.optional(v.union(v.string(), v.null())),
    resource: v.optional(v.string()),
    recordId: v.optional(v.string()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    if (args.companyId && !canAccessCompany(ctx.actor, args.companyId)) {
      throw synieError('forbidden', '无权访问该公司')
    }
    if (args.recordId && !args.resource) throw synieError('validation', '按记录查询审计时必须指定资源')
    if (args.resource && !args.recordId) throw synieError('validation', '按资源查询审计时必须指定记录')
    const options = paginationOptions(args)
    const page = args.resource && args.recordId
      ? await ctx.db.query('auditLogs').withIndex('by_resource_record', (q) =>
          q.eq('resource', args.resource!).eq('recordId', args.recordId!),
        ).order('desc').paginate(options)
      : args.companyId !== undefined
        ? await ctx.db.query('auditLogs').withIndex('by_company_time', (q) =>
            q.eq('companyId', args.companyId ?? null),
          ).order('desc').paginate(options)
        : await ctx.db.query('auditLogs').withIndex('by_time').order('desc').paginate(options)
    const visible = page.page.filter((row) => !row.companyId || canAccessCompany(ctx.actor, row.companyId))
    return resourcePage({
      ...page,
      page: visible.map((row) => ({
        id: row._id,
        resource: row.resource,
        recordId: row.recordId,
        recordLabel: row.recordLabel,
        actorUserId: row.actorUserId,
        actorUsername: row.actorUsername,
        companyId: row.companyId,
        actionType: row.action,
        actionName: row.action,
        changes: row.changes,
        truncated: row.truncated,
        insertedAt: row.occurredAt,
      })),
    })
  },
})
export const getAudit = permissionedQuery('sys.audit_log:read')({args:{id:v.id('auditLogs')},returns:v.any(),handler:async(ctx,args)=>{const row=await ctx.db.get(args.id);if(!row)return null;if(row.companyId&&!canAccessCompany(ctx.actor,row.companyId))throw synieError('not_found','审计日志不存在');return{id:row._id,resource:row.resource,recordId:row.recordId,recordLabel:row.recordLabel,actorUserId:row.actorUserId,actorUsername:row.actorUsername,companyId:row.companyId,actionType:row.action,actionName:row.action,changes:row.changes,truncated:row.truncated,insertedAt:row.occurredAt}}})
export const listNumberingRules = permissionedQuery('sys.numbering_rule:read')({args:{numItems:v.number(),cursor:v.optional(v.union(v.string(),v.null()))},returns:v.any(),handler:async(ctx,args)=>{const page=await ctx.db.query('numberingRules').withIndex('by_resource_name').paginate(paginationOptions(args));return resourcePage({...page,page:page.page.map(row=>({id:row._id,resource:row.resource,name:row.name,segments:row.segments,perCompany:row.perCompany,enabled:row.enabled,insertedAt:row.insertedAt,updatedAt:row.updatedAt}))})}})
export const getNumberingRule = permissionedQuery('sys.numbering_rule:read')({args:{id:v.id('numberingRules')},returns:v.any(),handler:async(ctx,args)=>{const row=await ctx.db.get(args.id);return row?{id:row._id,resource:row.resource,name:row.name,segments:row.segments,perCompany:row.perCompany,enabled:row.enabled,insertedAt:row.insertedAt,updatedAt:row.updatedAt}:null}})
export const listNumberingCounters = permissionedQuery('sys.numbering_rule:read')({args:{numItems:v.number(),cursor:v.optional(v.union(v.string(),v.null()))},returns:v.any(),handler:async(ctx,args)=>{const page=await ctx.db.query('numberingCounters').withIndex('by_rule_scope').paginate(paginationOptions(args));return resourcePage({...page,page:page.page.map(row=>({id:row._id,ruleId:row.ruleId,scopeKey:row.scopeKey,value:Number(row.value),updatedAt:row.updatedAt}))})}})
