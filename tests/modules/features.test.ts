// Bun's test glob only matches .ts/.js files, so feature files are loaded
// explicitly (see the bun-test-cucumber README); the preload plugin in
// cucumber-plugin.ts turns each one into a bun:test suite.
import { loadFeatures } from '@aboviq/bun-test-cucumber'

await loadFeatures('tests/modules/features/*.feature')
