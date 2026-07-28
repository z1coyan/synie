/**
 * 密码哈希：Bun 原生 argon2id（KD17 定案，无 Node 依赖）。
 * 输出为 PHC 字符串（$argon2id$v=19$m=...,t=...$...），与 server-go 的
 * x/crypto/argon2 输出格式互通——存量 Go 种子用户可直接校验通过。
 */
export async function hashPassword(password: string): Promise<string> {
  if (!password) {
    throw new Error('密码不能为空')
  }
  return Bun.password.hash(password, {
    algorithm: 'argon2id',
    memoryCost: 65536,
    timeCost: 3,
  })
}

export async function verifyPassword(encodedHash: string, password: string): Promise<boolean> {
  try {
    return await Bun.password.verify(password, encodedHash)
  } catch {
    // 格式非法的存量哈希视为校验失败，不抛出
    return false
  }
}
