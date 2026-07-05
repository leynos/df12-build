// Step definitions for roadmap-selection.feature, driving selectRoadmapTask
// by direct import (decomposition milestone 2).
import { expect } from 'bun:test'
import { withState } from '@aboviq/bun-test-cucumber'

import { selectRoadmapTask } from '../../src/workflows/df12-build-odw/roadmap.ts'

type Selection = ReturnType<typeof selectRoadmapTask>

interface RoadmapState {
  roadmapText: string
  taken: { normal: string[]; addendum: string[] }
  onlyTask: string | null
  selection: Selection | null
}

const { Before, Given, When, Then } = withState<RoadmapState>()

Before((state) => ({
  ...state,
  roadmapText: '',
  taken: { normal: [], addendum: [] },
  onlyTask: null,
  selection: null,
}))

Given('the roadmap', (state, _, argument) => ({
  ...state,
  // The third step argument is the Gherkin pickle argument; doc strings
  // arrive as { docString: { content } }.
  roadmapText: (argument as { docString?: { content?: string } } | undefined)?.docString?.content ?? '',
}))

Given('task {string} is already taken as a normal task', (state, [id]) => ({
  ...state,
  taken: { ...state.taken, normal: [...state.taken.normal, id] },
}))

Given('the run is limited to task {string}', (state, [id]) => ({
  ...state,
  onlyTask: id,
}))

When('a task is selected', (state) => ({
  ...state,
  selection: selectRoadmapTask(state.roadmapText, state.taken, state.onlyTask),
}))

Then('task {string} is selected as a normal task', (state, [id]) => {
  expect(state.selection?.hasTask).toBe(true)
  expect(state.selection?.task?.id).toBe(id)
  expect(state.selection?.task?.isAddendum).toBe(false)
  return state
})

Then('task {string} is selected as an addendum pass', (state, [id]) => {
  expect(state.selection?.hasTask).toBe(true)
  expect(state.selection?.task?.id).toBe(id)
  expect(state.selection?.task?.isAddendum).toBe(true)
  return state
})

Then('the addendum covers sub-task {string}', (state, [subtaskId]) => {
  expect(state.selection?.task?.subtasks).toContain(subtaskId)
  return state
})

Then('the remaining unblocked list is {string}', (state, [ids]) => {
  expect(state.selection?.remainingUnblocked).toEqual(ids.split(',').map((id: string) => id.trim()))
  return state
})

Then('the blocked summary mentions {string}', (state, [fragment]) => {
  expect(state.selection?.blockedSummary).toContain(fragment)
  return state
})

Then('no task is selected', (state) => {
  expect(state.selection?.hasTask).toBe(false)
  return state
})
