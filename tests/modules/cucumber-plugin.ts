// Bun test preload: registers the Gherkin loader so feature files under
// tests/modules/features/ compile to bun:test suites, with step definitions
// resolved from the sibling *.steps.ts files.
import { plugin } from 'bun'
import { bunTestCucumber } from '@aboviq/bun-test-cucumber'

await plugin(
  bunTestCucumber({
    stepDefinitionsPattern: 'tests/modules/**/*.steps.ts',
  }),
)
