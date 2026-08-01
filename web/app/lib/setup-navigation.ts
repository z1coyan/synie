export type SetupStatus = {
  initialized: boolean
  hasUsers: boolean
}

/** 空 deployment 进入 /setup；首管理员已存在时保留 /login，以便认证后续做。 */
export function shouldRedirectLoginToSetup(status: SetupStatus): boolean {
  return !status.initialized && !status.hasUsers
}
