import type { ResourceBinding } from '../catalog/types'
import {
  presentationFromDefinitions,
  type PresentationDefinition,
} from './group'
import type { PresentationExtension } from './types'

export const SYSTEM_PRESENTATION_RESOURCES = ['sysRoles'] as const

type SystemPresentationResource = (typeof SYSTEM_PRESENTATION_RESOURCES)[number]

const DEFINITIONS = {
  sysRoles: {
    label: '角色',
    exclude: ['enabled'],
    fields: {
      code: {
        required: true,
        edit: 'createOnly',
        placeholder: '如 purchaser',
      },
      name: {
        required: true,
        placeholder: '如 采购管理员',
      },
      builtin: { visible: () => false },
    },
  },
} satisfies Record<SystemPresentationResource, PresentationDefinition>

export function createSystemPresentation(
  binding: ResourceBinding,
): PresentationExtension {
  return presentationFromDefinitions(binding, DEFINITIONS, '系统资源')
}
