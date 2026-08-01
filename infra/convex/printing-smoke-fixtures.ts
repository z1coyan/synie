type PersistedFixture = { id: string }

const PRINT_BATCH_LIMIT = 100

export async function preparePrintBaseline(
  initial: readonly PersistedFixture[],
  create: () => Promise<PersistedFixture>,
): Promise<string[]> {
  if (initial.length > PRINT_BATCH_LIMIT) {
    throw new Error('100 条打印基线 fixture 超过批量上限')
  }

  const fixtures = [...initial]
  while (fixtures.length < PRINT_BATCH_LIMIT) fixtures.push(await create())

  const ids = fixtures.map(({ id }) => id)
  if (new Set(ids).size !== PRINT_BATCH_LIMIT) {
    throw new Error('100 条打印基线 fixture 必须互不重复')
  }
  return ids
}
