import { createCommandAdapter, defineCommand } from './catalog/commands'
import type { CommandAdapter, CommandTarget } from './catalog/types'
import type { ResourceClient } from './types'

export const unavailableResourceOperation = async (): Promise<never> => {
  throw new Error('资源能力尚未由 Convex 应用壳装配')
}

/**
 * Module-level compatibility object for route modules that retain a client.
 * The Convex-only registry mutates this exact object during shell assembly.
 */
export function unboundResourceClient(resource: string): ResourceClient {
  return {
    id: `convex-unbound:${resource}`,
    query: unavailableResourceOperation,
    get: unavailableResourceOperation,
    create: unavailableResourceOperation,
    update: unavailableResourceOperation,
    delete: unavailableResourceOperation,
  }
}

export function unboundCommandAdapter(
  commands: Readonly<Record<
    string,
    CommandTarget | {
      target: CommandTarget
      affectedResources?: readonly string[]
    }
  >>,
): CommandAdapter {
  return createCommandAdapter(Object.fromEntries(
    Object.entries(commands).map(([key, declaration]) => {
      const target = typeof declaration === 'string'
        ? declaration
        : declaration.target
      const affectedResources = typeof declaration === 'string'
        ? undefined
        : declaration.affectedResources
      return [
        key,
        defineCommand(
          target,
          unavailableResourceOperation,
          affectedResources ? { affectedResources } : {},
        ),
      ]
    }),
  ))
}
