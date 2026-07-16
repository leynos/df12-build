// Schema contract tests by direct import (decomposition milestone 1). The
// schemas are cross-agent contracts: enums must match the documented
// classifications, `additionalProperties` must be false wherever downstream
// JavaScript iterates keys, and `required` must cover exactly what the
// control loop dereferences without optional chaining.
import { describe, expect, test } from 'bun:test'

import {
  ASSESSMENT_CLASSIFICATIONS,
  ASSESSMENT_SCHEMA,
  AUDIT_SCHEMA,
  DESIGN_VERDICT_SCHEMA,
  FIX_SCHEMA,
  IMPL_SCHEMA,
  INTEGRATE_SCHEMA,
  PLAN_SCHEMA,
  REVIEW_SCHEMA,
} from '../../src/workflows/df12-build-odw/schemas.ts'

const ALL_SCHEMAS = {
  PLAN_SCHEMA,
  DESIGN_VERDICT_SCHEMA,
  IMPL_SCHEMA,
  REVIEW_SCHEMA,
  FIX_SCHEMA,
  INTEGRATE_SCHEMA,
  AUDIT_SCHEMA,
  ASSESSMENT_SCHEMA,
} as const

describe('agent schema contracts', () => {
  test('every schema is a closed object whose required fields exist', () => {
    for (const [name, schema] of Object.entries(ALL_SCHEMAS)) {
      expect(schema.type, name).toBe('object')
      expect(schema.additionalProperties, name).toBe(false)
      const propertyNames = Object.keys(schema.properties)
      for (const required of schema.required) {
        expect(propertyNames, `${name}.required`).toContain(required)
      }
    }
  })

  test('assessment classification enum matches the ADR 002 contract', () => {
    expect(ASSESSMENT_SCHEMA.properties.classification.enum).toEqual(ASSESSMENT_CLASSIFICATIONS)
    expect(ASSESSMENT_CLASSIFICATIONS).toEqual([
      'adopt-complete',
      'adopt-partial',
      'continue-manual',
      'discard',
    ])
  })

  test('assessment schema requires every property it declares', () => {
    expect([...ASSESSMENT_SCHEMA.required].sort()).toEqual(
      Object.keys(ASSESSMENT_SCHEMA.properties).sort(),
    )
  })

  test('dirtyState stays mock-satisfiable: the healthy value is enum[0]', () => {
    // ODW's schema-satisfying mock agent generates enum[0]; recovery e2e
    // tests rely on a mocked assessment reading as a clean worktree.
    expect(ASSESSMENT_SCHEMA.properties.dirtyState.enum[0]).toBe('clean')
  })

  test('review and fix rounds carry the fields the control loop dereferences', () => {
    expect(REVIEW_SCHEMA.properties.verdict.enum).toEqual(['pass', 'changes-requested'])
    expect(REVIEW_SCHEMA.required).toEqual(['verdict', 'blocking', 'summary'])
    expect(FIX_SCHEMA.required).toEqual(['gatesGreen', 'summary'])
    expect(IMPL_SCHEMA.required).toEqual(['ok', 'execplanPath', 'gatesGreen', 'summary'])
    expect(INTEGRATE_SCHEMA.required).toEqual(['ok', 'roadmapMarkedDone', 'rebased', 'squashMerged', 'pushed', 'summary'])
    expect(PLAN_SCHEMA.required).toEqual(['execplanPath', 'workItems', 'summary'])
    expect(DESIGN_VERDICT_SCHEMA.required).toEqual(['satisfied', 'blocking'])
    expect(AUDIT_SCHEMA.required).toEqual(['findings', 'summary'])
  })
})
