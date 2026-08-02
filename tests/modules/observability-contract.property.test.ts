/**
 * @file Property tests for the workflow observability contract schemas
 * (roadmap task 5.1.1).
 *
 * Responsibilities: check the range invariants the schemas under
 * `schemas/observability/` encode — UUIDv7 identifiers, W3C traceparent
 * values, signed 64-bit nanosecond timestamps, collector endpoints, binding
 * source-to-confidence mapping, and the logical node key grammar — over
 * generated input rather than the fixed cases in
 * `observability-contract.test.ts`.
 *
 * Why both suites exist: the fixture suite pins each named rule of
 * `docs/workflow-observability-contract.md` to a readable example; this module
 * decides accept/reject with an oracle computed independently of the schema
 * pattern, so a pattern that is subtly wrong in the middle of its range fails
 * here even when every fixture still passes. The bounded-timestamp pattern in
 * particular is generated rather than hand-authored, so it needs a check that
 * does not simply restate it.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import fc from 'fast-check'
import Ajv2020 from 'ajv/dist/2020'

const SCHEMA_DIR = path.join(import.meta.dir, '..', '..', 'schemas', 'observability')

function loadSchema(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(SCHEMA_DIR, name), 'utf8'))
}

const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true })
const contextSchema = loadSchema('workflow-observability-context.v1.json')
const bindingSchema = loadSchema('telemetry-binding.v1.json')
const eventSchema = loadSchema('agent-event-extensions.v1.json')

const validateContext = ajv.compile(contextSchema)
const validateBinding = ajv.compile(bindingSchema)
const validateEvent = ajv.compile(eventSchema)

// Sub-schema validators, so a property can target one field rather than
// asserting through a whole envelope.
const defs = contextSchema.$defs as Record<string, unknown>
const validateUuid = ajv.compile(defs.uuidv7 as object)
const validateTraceparent = ajv.compile(defs.traceparent as object)
const validateNs = ajv.compile(
  (bindingSchema.$defs as Record<string, unknown>).nanosecondTimestamp as object,
)

const CORRELATION_ID = '0198e5a1-0000-7000-8000-000000000001'
const I64_MAX = 9223372036854775807n

const HEX = '0123456789abcdef'
const LOWER_ALNUM = 'abcdefghijklmnopqrstuvwxyz0123456789'
const DIGITS = '0123456789'

/** An arbitrary single character drawn from `alphabet`. */
function charOf(alphabet: string): fc.Arbitrary<string> {
  return fc.constantFrom(...alphabet.split(''))
}

/**
 * An arbitrary string of `min`..`max` characters drawn from `alphabet`.
 *
 * Built from character primitives rather than `fc.stringMatching`, so the
 * generators stay independent of the regular expressions under test.
 */
function stringOf(alphabet: string, min: number, max: number = min): fc.Arbitrary<string> {
  return fc
    .array(charOf(alphabet), { minLength: min, maxLength: max })
    .map((characters) => characters.join(''))
}

const hexString = (length: number) => stringOf(HEX, length)

/** Assembles a UUIDv7 from its five groups. */
function uuid(a: string, b: string, version: string, variant: string, d: string, e: string): string {
  return `${a}-${b}-${version}${d.slice(0, 3)}-${variant}${d.slice(3, 6)}-${e}`
}

const uuidV7Arb = fc
  .tuple(hexString(8), hexString(4), fc.constantFrom('8', '9', 'a', 'b'), hexString(6), hexString(12))
  .map(([a, b, variant, d, e]) => uuid(a, b, '7', variant, d, e))

describe('uuidv7 identifier shape', () => {
  test('accepts any well-formed lower-case UUIDv7', () => {
    fc.assert(
      fc.property(uuidV7Arb, (value) => {
        expect(validateUuid(value), value).toBe(true)
      }),
    )
  })

  test('rejects a wrong version nibble, wrong variant, or upper case', () => {
    const badVersion = fc
      .tuple(hexString(8), hexString(4), charOf('012345689abcdef'), fc.constantFrom('8', '9', 'a', 'b'), hexString(6), hexString(12))
      .map(([a, b, v, variant, d, e]) => uuid(a, b, v, variant, d, e))
    const badVariant = fc
      .tuple(hexString(8), hexString(4), fc.constantFrom('c', 'd', 'e', 'f', '0', '7'), hexString(6), hexString(12))
      .map(([a, b, variant, d, e]) => uuid(a, b, '7', variant, d, e))

    fc.assert(fc.property(badVersion, (v) => expect(validateUuid(v), v).toBe(false)))
    fc.assert(fc.property(badVariant, (v) => expect(validateUuid(v), v).toBe(false)))
    // Casing is normative: these values are exact string join keys, so an
    // upper-case spelling of the same identifier must not validate.
    fc.assert(
      fc.property(
        uuidV7Arb.filter((v) => /[a-f]/.test(v)),
        (v) => expect(validateUuid(v.toUpperCase()), v).toBe(false),
      ),
    )
  })

  test('rejects any single-character deletion or non-hex substitution', () => {
    fc.assert(
      fc.property(uuidV7Arb, fc.nat(35), (value, rawIndex) => {
        const index = rawIndex % value.length
        expect(validateUuid(value.slice(0, index) + value.slice(index + 1))).toBe(false)
      }),
    )
    fc.assert(
      fc.property(
        uuidV7Arb,
        fc.nat(35),
        fc.constantFrom('g', 'z', ' ', '_', '.'),
        (value, rawIndex, ch) => {
          const index = rawIndex % value.length
          expect(validateUuid(value.slice(0, index) + ch + value.slice(index + 1))).toBe(false)
        },
      ),
    )
  })
})

describe('w3c traceparent', () => {
  const versionArb = hexString(2).filter((v) => v !== 'ff')
  const traceIdArb = hexString(32).filter((v) => /[1-9a-f]/.test(v))
  const spanIdArb = hexString(16).filter((v) => /[1-9a-f]/.test(v))

  test('accepts a well-formed traceparent with non-zero ids', () => {
    fc.assert(
      fc.property(versionArb, traceIdArb, spanIdArb, hexString(2), (ver, trace, span, flags) => {
        expect(validateTraceparent(`${ver}-${trace}-${span}-${flags}`)).toBe(true)
      }),
    )
  })

  test('rejects the reserved ff version and all-zero trace or parent ids', () => {
    fc.assert(
      fc.property(traceIdArb, spanIdArb, hexString(2), (trace, span, flags) => {
        expect(validateTraceparent(`ff-${trace}-${span}-${flags}`)).toBe(false)
      }),
    )
    fc.assert(
      fc.property(versionArb, spanIdArb, hexString(2), (ver, span, flags) => {
        expect(validateTraceparent(`${ver}-${'0'.repeat(32)}-${span}-${flags}`)).toBe(false)
      }),
    )
    fc.assert(
      fc.property(versionArb, traceIdArb, hexString(2), (ver, trace, flags) => {
        expect(validateTraceparent(`${ver}-${trace}-${'0'.repeat(16)}-${flags}`)).toBe(false)
      }),
    )
  })

  test('rejects wrong field widths', () => {
    fc.assert(
      fc.property(
        versionArb,
        hexString(31),
        spanIdArb,
        hexString(2),
        (ver, shortTrace, span, flags) => {
          expect(validateTraceparent(`${ver}-${shortTrace}-${span}-${flags}`)).toBe(false)
        },
      ),
    )
  })
})

describe('nanosecond timestamp bound', () => {
  // The oracle is computed with BigInt comparison, independently of the
  // generated pattern, so a pattern wrong anywhere in its range fails here.
  const accepts = (value: string): boolean =>
    /^[0-9]+$/.test(value) && (value === '0' || !value.startsWith('0')) && BigInt(value) <= I64_MAX

  test('agrees with a BigInt oracle across the whole magnitude range', () => {
    const digits = stringOf(DIGITS, 1, 25)
    fc.assert(
      fc.property(digits, (value) => {
        expect(validateNs(value), value).toBe(accepts(value))
      }),
      { numRuns: 2000 },
    )
  })

  test('agrees with the oracle in the dense band either side of the maximum', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: -100000n, max: 100000n }), (delta) => {
        const value = (I64_MAX + delta).toString()
        expect(validateNs(value), value).toBe(accepts(value))
      }),
      { numRuns: 2000 },
    )
  })

  test('accepts the maximum exactly and rejects one past it', () => {
    expect(validateNs(I64_MAX.toString())).toBe(true)
    expect(validateNs((I64_MAX + 1n).toString())).toBe(false)
  })

  test('rejects any zero-padded spelling of an otherwise valid value', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: I64_MAX }), fc.integer({ min: 1, max: 6 }), (v, pad) => {
        expect(validateNs('0'.repeat(pad) + v.toString())).toBe(false)
      }),
    )
  })
})

describe('collector endpoint', () => {
  const labelArb = stringOf(LOWER_ALNUM, 1, 8)
  const hostArb = fc
    .tuple(labelArb, fc.array(labelArb, { maxLength: 3 }))
    .map(([head, rest]) => [head, ...rest].join('.'))
  const endpoint = (value: string) => ({
    schemaVersion: 1,
    correlationId: CORRELATION_ID,
    sink: { kind: 'otlp-http', endpoint: value, protocol: 'http/json' },
  })

  test('accepts a scheme with a well-formed authority, optional port and path', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('otlp+http', 'otlp+https'),
        hostArb,
        fc.option(fc.integer({ min: 1, max: 65535 }), { nil: undefined }),
        fc.option(fc.constantFrom('/v1/traces', '/ingest', '/'), { nil: undefined }),
        (scheme, host, port, suffix) => {
          const value = `${scheme}://${host}${port === undefined ? '' : `:${port}`}${suffix ?? ''}`
          expect(validateContext(endpoint(value)), value).toBe(true)
        },
      ),
    )
  })

  test('rejects userinfo, so a credential cannot ride in the authority', () => {
    fc.assert(
      fc.property(
        hostArb,
        stringOf(LOWER_ALNUM, 1, 10),
        fc.option(stringOf(LOWER_ALNUM, 1, 10), { nil: undefined }),
        (host, user, secret) => {
          const userinfo = secret === undefined ? user : `${user}:${secret}`
          const value = `otlp+http://${userinfo}@${host}:4318`
          expect(validateContext(endpoint(value)), value).toBe(false)
        },
      ),
    )
  })

  test('rejects an empty authority and any embedded whitespace', () => {
    fc.assert(
      fc.property(fc.constantFrom('otlp+http', 'otlp+https'), (scheme) => {
        expect(validateContext(endpoint(`${scheme}://`))).toBe(false)
      }),
    )
    fc.assert(
      fc.property(hostArb, fc.constantFrom(' ', '\t', '\n', '\r'), fc.nat(3), (host, ws, where) => {
        const value =
          where === 0
            ? `otlp+http://${ws}${host}:4318`
            : where === 1
              ? `otlp+http://${host}${ws}:4318`
              : where === 2
                ? `otlp+http://${host}:4318${ws}`
                : `otlp+http://${host.slice(0, 1)}${ws}${host.slice(1)}:4318`
        expect(validateContext(endpoint(value)), JSON.stringify(value)).toBe(false)
      }),
    )
  })

  test('rejects any scheme other than otlp+http and otlp+https', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('http', 'https', 'file', 'sqlite', 'otlp+unix', 'otlp', 'otlp+grpc'),
        hostArb,
        (scheme, host) => {
          expect(validateContext(endpoint(`${scheme}://${host}:4318`))).toBe(false)
        },
      ),
    )
  })
})

describe('binding source to confidence mapping', () => {
  const CONFIDENCES = ['exact', 'derived', 'heuristic'] as const
  const SOURCES = ['trace-context', 'otlp-header', 'provider-event', 'events-jsonl'] as const

  // Oracle stated directly from contract section 9, not read from the schema.
  const permitted = (source: string, confidence: string): boolean => {
    if (source === 'trace-context' || source === 'otlp-header') return confidence === 'exact'
    if (source === 'events-jsonl') return confidence === 'heuristic'
    return true
  }

  test('permits exactly the documented source and confidence combinations', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...SOURCES),
        fc.constantFrom(...CONFIDENCES),
        uuidV7Arb,
        fc.bigInt({ min: 0n, max: I64_MAX }),
        (source, confidence, invocationId, ns) => {
          const binding = {
            binding_type: 'claude.session.id',
            binding_value: 'sess_abcdef',
            agent_invocation_id: invocationId,
            source,
            confidence,
            first_seen_ns: ns.toString(),
            last_seen_ns: ns.toString(),
          }
          expect(validateBinding(binding), `${source}/${confidence}`).toBe(
            permitted(source, confidence),
          )
        },
      ),
    )
  })

  test('requires a dotted, namespaced binding_type', () => {
    fc.assert(
      fc.property(
        stringOf(LOWER_ALNUM + '_', 1, 14),
        (word) => {
          const binding = {
            binding_type: word,
            binding_value: 'v',
            agent_invocation_id: CORRELATION_ID,
            source: 'otlp-header',
            confidence: 'exact',
            first_seen_ns: '1',
            last_seen_ns: '1',
          }
          // A single undotted segment is never a valid namespaced key.
          expect(validateBinding(binding)).toBe(false)
        },
      ),
    )
  })
})

describe('identifier enforcement per schema', () => {
  // The three schemas each carry their own copy of the UUIDv7 shape so a
  // consumer can pin one file without resolving the others. The fixture suite
  // checks the copies have not drifted apart; these properties check each
  // schema actually enforces the shape, so relaxing all three copies together
  // still fails rather than passing a drift check unnoticed.
  // Each mutation must be positional. Replacing the first "-7" would sometimes
  // hit the second group's separator and leave the version nibble intact,
  // yielding a valid identifier labelled malformed; likewise an all-digit
  // identifier is unchanged by toUpperCase, so that case is filtered to
  // identifiers that actually contain a letter.
  const VERSION_INDEX = 14
  const malformedId = fc.oneof(
    fc.constant('not-a-uuid'),
    fc.constant(''),
    uuidV7Arb.filter((v) => /[a-f]/.test(v)).map((v) => v.toUpperCase()),
    uuidV7Arb.map((v) => `${v.slice(0, VERSION_INDEX)}4${v.slice(VERSION_INDEX + 1)}`),
    uuidV7Arb.map((v) => v.slice(1)),
    uuidV7Arb.map((v) => v.replace(/-/g, '')),
  )

  test('the binding schema rejects a malformed agent invocation or process id', () => {
    const binding = (over: Record<string, unknown>) => ({
      binding_type: 'claude.session.id',
      binding_value: 'sess_abcdef',
      agent_invocation_id: CORRELATION_ID,
      source: 'otlp-header',
      confidence: 'exact',
      first_seen_ns: '1721000000000000000',
      last_seen_ns: '1721000000000000000',
      ...over,
    })
    fc.assert(
      fc.property(malformedId, (bad) => {
        expect(validateBinding(binding({ agent_invocation_id: bad })), bad).toBe(false)
        expect(validateBinding(binding({ agent_process_id: bad })), bad).toBe(false)
      }),
    )
  })

  test('the agent-event schema rejects a malformed identifier in any field', () => {
    const event = (over: Record<string, unknown>) => ({
      run_id: CORRELATION_ID,
      node_attempt_id: CORRELATION_ID,
      agent_invocation_id: CORRELATION_ID,
      agent_process_id: CORRELATION_ID,
      cli_attempt: 1,
      ...over,
    })
    const fields = ['run_id', 'node_attempt_id', 'agent_invocation_id', 'agent_process_id'] as const
    fc.assert(
      fc.property(malformedId, fc.constantFrom(...fields), (bad, field) => {
        expect(validateEvent(event({ [field]: bad })), `${field}=${bad}`).toBe(false)
      }),
    )
  })

  test('the envelope schema rejects a malformed invocation or parent identifier', () => {
    fc.assert(
      fc.property(malformedId, (bad) => {
        expect(
          validateContext({
            schemaVersion: 1,
            correlationId: CORRELATION_ID,
            workflowInvocationId: bad,
          }),
          bad,
        ).toBe(false)
        expect(
          validateContext({
            schemaVersion: 1,
            correlationId: CORRELATION_ID,
            parent: { workflowInvocationId: CORRELATION_ID, nodeAttemptId: bad },
          }),
          bad,
        ).toBe(false)
      }),
    )
  })
})

describe('agent-event extensions', () => {
  test('requires every identifier to be a UUIDv7 and cli_attempt to start at one', () => {
    fc.assert(
      fc.property(
        fc.tuple(uuidV7Arb, uuidV7Arb, uuidV7Arb, uuidV7Arb),
        fc.integer({ min: -5, max: 5 }),
        ([run, node, invocation, process], attempt) => {
          const event = {
            run_id: run,
            node_attempt_id: node,
            agent_invocation_id: invocation,
            agent_process_id: process,
            cli_attempt: attempt,
          }
          expect(validateEvent(event)).toBe(attempt >= 1)
        },
      ),
    )
  })
})

describe('logical node key grammar', () => {
  // Kept identical to the canonical expression in
  // docs/workflow-observability-contract.md section 10.
  const NODE_KEY = /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?(\/[a-z0-9]([a-z0-9._-]*[a-z0-9])?)+$/

  const segment = fc
    .tuple(charOf(LOWER_ALNUM), stringOf(LOWER_ALNUM + '._-', 0, 8), charOf(LOWER_ALNUM))
    .map(([head, mid, tail]) => `${head}${mid}${tail}`)

  test('accepts any path of two or more well-formed segments', () => {
    fc.assert(
      fc.property(fc.array(segment, { minLength: 2, maxLength: 6 }), (segments) => {
        expect(NODE_KEY.test(segments.join('/')), segments.join('/')).toBe(true)
      }),
    )
  })

  test('rejects a single segment, and leading, trailing, or doubled slashes', () => {
    fc.assert(fc.property(segment, (s) => expect(NODE_KEY.test(s)).toBe(false)))
    fc.assert(
      fc.property(fc.array(segment, { minLength: 2, maxLength: 4 }), (segments) => {
        const key = segments.join('/')
        expect(NODE_KEY.test(`/${key}`)).toBe(false)
        expect(NODE_KEY.test(`${key}/`)).toBe(false)
        expect(NODE_KEY.test(segments.join('//'))).toBe(false)
      }),
    )
  })

  test('rejects an upper-case character or a space anywhere in the key', () => {
    fc.assert(
      fc.property(
        fc.array(segment, { minLength: 2, maxLength: 4 }),
        fc.nat(),
        fc.constantFrom('A', 'Z', ' '),
        (segments, rawIndex, ch) => {
          const key = segments.join('/')
          const index = rawIndex % key.length
          expect(NODE_KEY.test(key.slice(0, index) + ch + key.slice(index + 1))).toBe(false)
        },
      ),
    )
  })
})
