Feature: Deterministic roadmap selection

  selectRoadmapTask reads the canonical roadmap text and picks the earliest
  unblocked work: normal tasks whose declared dependencies are complete, or
  an addendum pass when a completed parent still has open sub-tasks. The
  selection never re-opens taken ids, and a taskId filter narrows the run to
  one task.

  Scenario: selects the earliest unblocked task
    Given the roadmap
      """
      - [x] 1.1. Bootstrap the project.
      - [ ] 1.2. Add the parser.
      - [ ] 1.3. Add the emitter.
      """
    When a task is selected
    Then task "1.2" is selected as a normal task
    And the remaining unblocked list is "1.3"

  Scenario: a task with an incomplete dependency is blocked
    Given the roadmap
      """
      - [ ] 2.1. Design the store.
      - [ ] 2.2. Implement the store.
        - Requires 2.1.
      """
    When a task is selected
    Then task "2.1" is selected as a normal task
    And the blocked summary mentions "2.2 requires 2.1"

  Scenario: a completed dependency unblocks its dependant
    Given the roadmap
      """
      - [x] 2.1. Design the store.
      - [ ] 2.2. Implement the store.
        - Requires 2.1.
      """
    When a task is selected
    Then task "2.2" is selected as a normal task

  Scenario: a step range in a Requires line expands to every step
    Given the roadmap
      """
      - [x] 3.1. Step one.
      - [ ] 3.2. Step two.
      - [ ] 4.1. Integration.
        - Requires steps 3.1-3.2.
      """
    When a task is selected
    Then task "3.2" is selected as a normal task
    And the blocked summary mentions "4.1 requires 3.2"

  Scenario: a completed parent with open sub-tasks becomes an addendum pass
    Given the roadmap
      """
      - [x] 5.1. Ship the feature.
        - [ ] 5.1.1. Follow-up hardening.
      """
    When a task is selected
    Then task "5.1" is selected as an addendum pass
    And the addendum covers sub-task "5.1.1"

  Scenario: taken ids are never re-selected
    Given the roadmap
      """
      - [ ] 6.1. First task.
      - [ ] 6.2. Second task.
      """
    And task "6.1" is already taken as a normal task
    When a task is selected
    Then task "6.2" is selected as a normal task

  Scenario: the taskId filter selects exactly the named task
    Given the roadmap
      """
      - [ ] 7.1. First task.
      - [ ] 7.2. Second task.
      """
    And the run is limited to task "7.2"
    When a task is selected
    Then task "7.2" is selected as a normal task

  Scenario: the taskId filter reports when the named task is blocked
    Given the roadmap
      """
      - [ ] 8.1. First task.
      - [ ] 8.2. Second task.
        - Requires 8.1.
      """
    And the run is limited to task "8.2"
    When a task is selected
    Then no task is selected
    And the blocked summary mentions "Task 8.2 is not currently unblocked"
