import { decodeResourceDocument, type FieldDocument, type ResourceDocument } from '@synie/shared'
import type { Actor } from '../lib/actor'
import { hasPermission } from '../lib/permissions'
import generated from './generatedDocuments.json'
import { pilotResourceDocuments } from './pilots'

const rawDocuments = generated as Record<string, ResourceDocument>

export const allResourceDocuments: Readonly<Record<string, ResourceDocument>> = Object.freeze({
  ...rawDocuments,
  ...pilotResourceDocuments,
})

export const allResourceNames = Object.freeze(Object.keys(allResourceDocuments).sort())

for (const name of allResourceNames) {
  const document = decodeResourceDocument(allResourceDocuments[name])
  if (document.name !== name) throw new Error(`${name}: generated Catalog key 漂移`)
  if (!document.queryProfiles?.length) throw new Error(`${name}: 缺少 Convex query profile`)
}

function projectField(field: FieldDocument, actor: Actor): FieldDocument {
  if (field.kind === 'reference') {
    const target = allResourceDocuments[field.targetResource]
    if (!target || !hasPermission(actor, `${target.permissionPrefix}:read`)) {
      return { ...field, targetUnavailable: true }
    }
  }
  if (field.kind === 'polymorphicReference') {
    const variants = field.variants.filter((variant) => {
      const target = allResourceDocuments[variant.resource]
      return target && hasPermission(actor, `${target.permissionPrefix}:read`)
    })
    if (!variants.length) return { ...field, variants: [], targetUnavailable: true }
    if (variants.length !== field.variants.length) return { ...field, variants }
  }
  return field
}

export function projectResource(name: string, actor: Actor): ResourceDocument {
  const document = allResourceDocuments[name]
  if (!document) throw new Error(`未知的 Catalog 资源: ${name}`)
  return {
    ...document,
    capabilities: document.capabilities.filter((capability) =>
      hasPermission(actor, `${document.permissionPrefix}:${capability}`),
    ),
    commands: document.commands.filter((command) =>
      hasPermission(actor, `${document.permissionPrefix}:${command.requiredCapability}`),
    ),
    fields: document.fields.map((field) => projectField(field, actor)),
  }
}
