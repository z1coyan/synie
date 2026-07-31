import { formatAmount } from '~/lib/amount'
import type { ResourceBinding } from '../catalog/types'
import {
  presentationFromDefinitions,
  type PresentationDefinition,
} from './group'
import type { PresentationExtension } from './types'

export const HR_PRESENTATION_RESOURCES = ['hrPayrolls'] as const

type HrPresentationResource = (typeof HR_PRESENTATION_RESOURCES)[number]

const amount = { render: (value: unknown) => formatAmount(value) }

const DEFINITIONS = {
  hrPayrolls: {
    label: '工资单',
    fields: {
      dailyWage: amount,
      baseAmount: amount,
      allowance: amount,
      bonus: amount,
      fine: amount,
      loanDeduction: amount,
      payable: amount,
      paidTotal: amount,
    },
  },
} satisfies Record<HrPresentationResource, PresentationDefinition>

export function createHrPresentation(
  binding: ResourceBinding,
): PresentationExtension {
  return presentationFromDefinitions(binding, DEFINITIONS, '人力资源')
}
