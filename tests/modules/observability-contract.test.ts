// Contract tests for the workflow observability fabric (roadmap task 5.1.1).
// These validate the fixtures in tests/fixtures/observability-contract against
// the JSON Schemas under schemas/observability, and check the logical node key
// grammar. They are the machine-readable half of
// docs/workflow-observability-contract.md: every rule the prose states
// normatively is exercised here so a schema regression fails a gate rather
// than silently loosening the contract.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import Ajv2020 from 'ajv/dist/2020'

const SCHEMA_DIR = path.join(import.meta.dir, '..', '..', 'schemas', 'observability')
const FIXTURE_PATH = path.join(
  import.meta.dir,
  '..',
  'fixtures',
  'observability-contract',
  'fixtures.json',
)

// The canonical logical-node-key pattern. This MUST stay identical to the
// regular expression in docs/workflow-observability-contract.md section 10.
const NODE_KEY_PATTERN = /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?(\/[a-z0-9]([a-z0-9._-]*[a-z0-9])?)+$/

function loadJson(filePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(filePath, 'utf8'))
}

function schemaPath(name: string): string {
  return path.join(SCHEMA_DIR, name)
}

interface NamedCase {
  name: string
  value: unknown
}

interface Fixtures {
  contexts: { valid: NamedCase[]; invalid: NamedCase[] }
  bindings: { valid: NamedCase[]; invalid: NamedCase[] }
  agentEvents: { valid: NamedCase[]; invalid: NamedCase[] }
  nodeKeys: { valid: string[]; invalid: string[] }
}

// strict mode catches schema mistakes (unknown keywords, ignored keywords);
// allowUnionTypes permits the scalar union on envelope attribute values.
const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true })
const fixtures = loadJson(FIXTURE_PATH) as unknown as Fixtures

const contextSchema = loadJson(schemaPath('workflow-observability-context.v1.json'))
const bindingSchema = loadJson(schemaPath('telemetry-binding.v1.json'))
const eventSchema = loadJson(schemaPath('agent-event-extensions.v1.json'))

const validateContext = ajv.compile(contextSchema)
const validateBinding = ajv.compile(bindingSchema)
const validateEvent = ajv.compile(eventSchema)

const SCHEMAS = [
  { name: 'workflow-observability-context.v1.json', schema: contextSchema },
  { name: 'telemetry-binding.v1.json', schema: bindingSchema },
  { name: 'agent-event-extensions.v1.json', schema: eventSchema },
] as const

describe('workflow observability context envelope', () => {
  for (const example of fixtures.contexts.valid) {
    test(`accepts ${example.name}`, () => {
      const ok = validateContext(example.value)
      expect(ok, JSON.stringify(validateContext.errors)).toBe(true)
    })
  }

  for (const example of fixtures.contexts.invalid) {
    test(`rejects ${example.name}`, () => {
      expect(validateContext(example.value)).toBe(false)
    })
  }
})

describe('telemetry binding records', () => {
  for (const example of fixtures.bindings.valid) {
    test(`accepts ${example.name}`, () => {
      const ok = validateBinding(example.value)
      expect(ok, JSON.stringify(validateBinding.errors)).toBe(true)
    })
  }

  for (const example of fixtures.bindings.invalid) {
    test(`rejects ${example.name}`, () => {
      expect(validateBinding(example.value)).toBe(false)
    })
  }
})

describe('ODW agent-event extensions', () => {
  for (const example of fixtures.agentEvents.valid) {
    test(`accepts ${example.name}`, () => {
      const ok = validateEvent(example.value)
      expect(ok, JSON.stringify(validateEvent.errors)).toBe(true)
    })
  }

  for (const example of fixtures.agentEvents.invalid) {
    test(`rejects ${example.name}`, () => {
      expect(validateEvent(example.value)).toBe(false)
    })
  }
})

describe('logical node key grammar', () => {
  test('every valid fixture key matches the canonical pattern', () => {
    for (const key of fixtures.nodeKeys.valid) {
      expect(NODE_KEY_PATTERN.test(key), key).toBe(true)
    }
  })

  test('every invalid fixture key fails the canonical pattern', () => {
    for (const key of fixtures.nodeKeys.invalid) {
      expect(NODE_KEY_PATTERN.test(key), key).toBe(false)
    }
  })
})

describe('schema versioning', () => {
  test('every schema is a draft 2020-12 document pinned to version 1', () => {
    for (const { name, schema } of SCHEMAS) {
      expect(schema.$schema, name).toBe('https://json-schema.org/draft/2020-12/schema')
      expect(typeof schema.$id, name).toBe('string')
      expect(schema.$id as string, name).toMatch(/\.v1\.json$/)
    }
  })

  test('the envelope pins schemaVersion to the constant 1', () => {
    const properties = contextSchema.properties as Record<string, { const?: number }>
    expect(properties.schemaVersion.const).toBe(1)
    expect(contextSchema.required as string[]).toContain('schemaVersion')
    expect(contextSchema.required as string[]).toContain('correlationId')
  })
})
