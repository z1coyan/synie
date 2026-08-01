import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { ioMigrationManifest } from './ioManifest'

describe('external I/O migration inventory', () => {
  test('every legacy side-effect root has one explicit destination', () => {
    expect(new Set(ioMigrationManifest.map((entry) => entry.legacySource)).size).toBe(ioMigrationManifest.length)
    expect(ioMigrationManifest.every((entry) => entry.status === 'convex-verified')).toBe(true)
    for (const entry of ioMigrationManifest) {
      for (const target of entry.target.split(' + ')) {
        const path = target.replace(/\{actions,s3,maintenance\}/, 'actions').replace(/ \(.*$/, '')
        expect(existsSync(path), `${entry.operation}: ${path}`).toBe(true)
      }
      expect(entry.idempotency.length).toBeGreaterThan(3)
      expect(entry.retry.length).toBeGreaterThan(3)
    }
  })
})
