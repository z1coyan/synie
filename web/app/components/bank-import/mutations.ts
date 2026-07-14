/** 银行流水导入的 GraphQL 操作与公共错误处理 */

export interface MutationErrors {
  errors: { message: string }[] | null
}

export interface ParseResult {
  id: string
  status: string
  error: string | null
  itemCount: number
  errorCount: number
}

export const CREATE_BANK_IMPORT = `
  mutation ($input: CreateAccBankImportInput!) {
    createAccBankImport(input: $input) {
      result { id status error itemCount errorCount }
      errors { message }
    }
  }
`

export const IMPORT_BANK_IMPORT = `
  mutation ($id: ID!) {
    importAccBankImport(id: $id) { result { id } errors { message } }
  }
`

export const DESTROY_BANK_IMPORT = `
  mutation ($id: ID!) {
    destroyAccBankImport(id: $id) { errors { message } }
  }
`

export const UPDATE_IMPORT_ITEM = `
  mutation ($id: ID!, $input: UpdateAccBankImportItemInput!) {
    updateAccBankImportItem(id: $id, input: $input) { result { id } errors { message } }
  }
`

export const DESTROY_IMPORT_ITEM = `
  mutation ($id: ID!) {
    destroyAccBankImportItem(id: $id) { errors { message } }
  }
`

/** AshGraphql mutation 的业务错误不走异常通道,统一在此抛出交给调用方 toast */
export function throwOnErrors(errors: { message: string }[] | null | undefined): void {
  if (errors && errors.length > 0) throw new Error(errors.map((e) => e.message).join('; '))
}
