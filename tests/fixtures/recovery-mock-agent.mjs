#!/usr/bin/env node
/**
 * Deterministic mock adapter for the recovery smoke test (odw-testing skill,
 * layer 6). Reads the prompt from stdin, extracts the JSON Schema the ODW
 * bridge appends, and switches on schema fingerprints — never prompt prose:
 *
 *   classification  -> an eligible ADR 002 assessment (clean, scoped, valid)
 *   verdict         -> a passing review
 *   roadmapMarkedDone -> a successful integration claim
 *   anything else   -> a minimal valid instance / stub text
 *
 * The integration reply is a claim only; the smoke test asserts on which
 * agents were ATTEMPTED (events.jsonl), not on real pushes.
 */

import { writeFileSync } from 'node:fs'

import { probeDetailsFromPrompt } from './recovery-repo.mjs'

let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  input += chunk
})
process.stdin.on('end', () => {
  const schema = extractSchema(input)
  const value = schema ? replyFor(schema, input) : 'mock reply'
  process.stdout.write(typeof value === 'string' ? value : JSON.stringify(value))
})

function replyFor(schema, prompt) {
  const properties = schema.properties || {}
  if (properties.ok && properties.detail && !properties.roadmapMarkedDone) {
    // Writable-root probe: behave as a compliant sandbox by honouring the
    // requested write, so the host verification finds the token on disk.
    const details = probeDetailsFromPrompt(prompt)
    if (details) {
      try {
        writeFileSync(details.file, details.token, 'utf8')
        return { ok: true, detail: '' }
      } catch (error) {
        return { ok: false, detail: String(error) }
      }
    }
    return { ok: false, detail: 'probe prompt carried no PROBE_FILE/PROBE_TOKEN lines' }
  }
  if (properties.classification) {
    return {
      classification: 'adopt-complete',
      branchName: '',
      worktreePath: '',
      baseCommit: '',
      currentCommit: '',
      dirtyState: 'clean',
      changedFiles: [],
      taskScoped: true,
      execPlan: 'ExecPlan complete with retrospective',
      roadmap: 'task unchecked',
      validation: 'make all green at HEAD',
      missingEvidence: [],
      residualRisk: [],
      risks: [],
      rationale: 'mock assessment for smoke testing',
      recommendation: 'review and integrate',
      nextActions: [],
    }
  }
  if (properties.verdict) {
    return { verdict: 'pass', blocking: [], advisory: [], summary: 'mock review pass' }
  }
  if (properties.roadmapMarkedDone) {
    return {
      ok: true,
      roadmapMarkedDone: true,
      rebased: true,
      squashMerged: true,
      mergeSha: 'feedfeedfeedfeedfeedfeedfeedfeedfeedfeed',
      pushed: true,
      conflicts: '',
      summary: 'mock integration claim',
    }
  }
  return generate(schema)
}

function extractSchema(text) {
  const marker = 'JSON Schema:'
  const at = text.lastIndexOf(marker)
  if (at === -1) return null
  const rest = text.slice(at + marker.length)
  const start = rest.indexOf('{')
  if (start === -1) return null
  let depth = 0
  let quote = null
  let escaped = false
  for (let i = start; i < rest.length; i++) {
    const ch = rest[i]
    if (quote) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") quote = ch
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        try {
          return JSON.parse(rest.slice(start, i + 1))
        } catch {
          return null
        }
      }
    }
  }
  return null
}

function generate(schema) {
  if (Array.isArray(schema.enum)) return schema.enum[0]
  switch (schema.type) {
    case 'object': {
      const out = {}
      for (const [key, sub] of Object.entries(schema.properties || {})) out[key] = generate(sub)
      return out
    }
    case 'array': {
      const count = schema.minItems || 0
      const items = schema.items || { type: 'string' }
      return Array.from({ length: count }, () => generate(items))
    }
    case 'number':
      return 0.5
    case 'integer':
      return 1
    case 'boolean':
      return false
    case 'string':
    default:
      return 'mock'
  }
}
