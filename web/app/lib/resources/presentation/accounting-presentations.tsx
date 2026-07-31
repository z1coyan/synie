import type { ResourceBinding } from '../catalog/types'
import {
  presentationFromDefinitions,
  type PresentationDefinition,
} from './group'
import type { PresentationExtension } from './types'
import { SynieAttachmentPanel } from '~/components/synie-attachment-panel/SynieAttachmentPanel'

export const ACCOUNTING_PRESENTATION_RESOURCES = ['accBills'] as const

type AccountingPresentationResource =
  (typeof ACCOUNTING_PRESENTATION_RESOURCES)[number]

const DEFINITIONS = {
  accBills: {
    label: '承兑票据',
    contentClassName: 'w-full lg:w-[760px]',
    exclude: ['faceAmount'],
    fields: {
      billNo: { order: -1, edit: 'readOnly' },
      billKind: { order: 0, cols: 6 },
      transferable: { order: 1, cols: 6 },
      issueDate: { order: 2, cols: 6 },
      acceptanceDate: { order: 3, cols: 6 },
      dueDate: { order: 4 },
      drawerName: {
        order: 6,
        cols: 6,
        label: '出票人名称',
      },
      drawerAccount: {
        order: 7,
        cols: 6,
        label: '出票人账号',
      },
      drawerBankName: {
        order: 8,
        cols: 6,
        label: '出票人开户行',
      },
      drawerBankNo: {
        order: 9,
        cols: 6,
        label: '出票人开户行联行号',
      },
      payeeName: {
        order: 10,
        cols: 6,
        label: '收款人名称',
      },
      payeeAccount: {
        order: 11,
        cols: 6,
        label: '收款人账号',
      },
      payeeBankName: {
        order: 12,
        cols: 6,
        label: '收款人开户行',
      },
      payeeBankNo: {
        order: 13,
        cols: 6,
        label: '收款人开户行联行号',
      },
      acceptorName: {
        order: 14,
        cols: 6,
        label: '承兑人名称',
      },
      acceptorAccount: {
        order: 15,
        cols: 6,
        label: '承兑人账号',
      },
      acceptorBankName: {
        order: 16,
        cols: 6,
        label: '承兑人开户行',
      },
      acceptorBankNo: {
        order: 17,
        cols: 6,
        label: '承兑人开户行联行号',
      },
      remarks: { order: 18 },
    },
    extraContent: (mode, row) => (
      <SynieAttachmentPanel
        ownerType="acc_bill"
        ownerId={row?.id as string | undefined}
        category="original"
        readonly={mode === 'view'}
      />
    ),
  },
} satisfies Record<AccountingPresentationResource, PresentationDefinition>

export function createAccountingPresentation(
  binding: ResourceBinding,
): PresentationExtension {
  return presentationFromDefinitions(binding, DEFINITIONS, '财务资源')
}
