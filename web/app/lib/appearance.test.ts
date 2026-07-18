import { describe, expect, test } from 'bun:test'
import {
  APPEARANCE_FOUC_SCRIPT,
  APPEARANCE_STORAGE_KEY,
  isAppearanceMode,
  resolveAppearance,
} from './appearance'

describe('appearance', () => {
  test('isAppearanceMode accepts only three values', () => {
    expect(isAppearanceMode('light')).toBe(true)
    expect(isAppearanceMode('dark')).toBe(true)
    expect(isAppearanceMode('system')).toBe(true)
    expect(isAppearanceMode('auto')).toBe(false)
    expect(isAppearanceMode(null)).toBe(false)
  })

  test('resolveAppearance keeps forced modes', () => {
    expect(resolveAppearance('light')).toBe('light')
    expect(resolveAppearance('dark')).toBe('dark')
  })

  test('FOUC script embeds storage key and tri-state', () => {
    expect(APPEARANCE_FOUC_SCRIPT).toContain(APPEARANCE_STORAGE_KEY)
    expect(APPEARANCE_FOUC_SCRIPT).toContain('light')
    expect(APPEARANCE_FOUC_SCRIPT).toContain('dark')
    expect(APPEARANCE_FOUC_SCRIPT).toContain('system')
    expect(APPEARANCE_FOUC_SCRIPT).toContain('prefers-color-scheme')
  })
})
