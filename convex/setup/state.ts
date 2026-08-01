import type { DatabaseReader } from '../_generated/server'

export async function readSetupPresence(db: DatabaseReader) {
  const [setupState, firstAppUser] = await Promise.all([
    db
      .query('setupState')
      .withIndex('by_key', (query) => query.eq('key', 'singleton'))
      .unique(),
    db.query('appUsers').first(),
  ])

  return {
    setupState,
    firstAppUser,
    initialized: setupState?.completedAt !== undefined,
    hasUsers: firstAppUser !== null,
  }
}
