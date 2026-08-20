/** 打印目录前缀（非权限码）；模板列表 / render 用。 */
export const AR_AP_PRINT_RESOURCE = 'acc.ar_ap'
/** ResourceDocument 资源名；导出/打印能力走文档投影。 */
export const AR_AP_RESOURCE_NAME = 'accArAp'

export function arApOutputActions(caps: { has: (action: string) => boolean }): {
  canExport: boolean
  canPrint: boolean
} {
  return {
    canExport: caps.has('export'),
    canPrint: caps.has('print'),
  }
}
