Feature: Fresh-run recovery decision tables

  The review-mode table (recoveryDecision) and the continue-mode table
  (recoveryContinueDecision) route surviving roadmap task branches on a
  fresh run. Both fail closed: anything unproven is reported for the
  operator instead of resumed.

  Background:
    Given a clean recovery candidate with committed work

  Scenario: assess mode only ever reports
    Given the assessment classifies the branch as "adopt-complete"
    When the review-mode decision runs in "assess" mode
    Then the decision action is "report"
    And the decision does not skip

  Scenario: review mode resumes an eligible adopt-complete branch
    Given the assessment classifies the branch as "adopt-complete"
    When the review-mode decision runs in "review" mode
    Then the decision action is "resume"
    And the decision does not skip

  Scenario: review mode never resumes a non-adopt-complete classification
    Given the assessment classifies the branch as "continue-manual"
    When the review-mode decision runs in "review" mode
    Then the decision action is "report"
    And the decision does not skip

  Scenario: an ineligible adopt-complete branch downgrades to continue-manual
    Given the assessment classifies the branch as "adopt-complete"
    But the worktree is dirty
    When the review-mode decision runs in "review" mode
    Then the decision action is "report"
    And the decision classification is "continue-manual"
    And the decision skips with reason "dirty-worktree"

  Scenario: advisory residual risk alone does not block an adopt-complete resume
    Given the assessment classifies the branch as "adopt-complete"
    But the assessment carries advisory residual risk
    When the review-mode decision runs in "review" mode
    Then the decision action is "resume"
    And the decision does not skip

  Scenario: blocking missing evidence still downgrades an adopt-complete branch
    Given the assessment classifies the branch as "adopt-complete"
    But the assessment reports blocking missing evidence
    When the review-mode decision runs in "review" mode
    Then the decision action is "report"
    And the decision classification is "continue-manual"
    And the decision skips with reason "missing-validation-evidence"

  Scenario: dry-run reports instead of resuming
    Given the assessment classifies the branch as "adopt-complete"
    When the review-mode decision runs in "review" mode with dry-run
    Then the decision action is "report"
    And the decision skips with reason "dry-run"

  Scenario: continue mode dispatches an approved plan to implementation
    Given the committed ExecPlan says "Status: APPROVED"
    When the continue-mode decision runs
    Then the decision action is "resume"
    And the dispatch stage is "implement"

  Scenario: continue mode dispatches an in-progress plan to implementation
    Given the committed ExecPlan says "Status: IN PROGRESS"
    When the continue-mode decision runs
    Then the decision action is "resume"
    And the dispatch stage is "implement"

  Scenario: continue mode dispatches a complete plan to review
    Given the committed ExecPlan says "Status: COMPLETE"
    When the continue-mode decision runs
    Then the decision action is "resume"
    And the dispatch stage is "review"

  Scenario: continue mode re-enters planning for a draft plan
    Given the committed ExecPlan says "Status: DRAFT"
    When the continue-mode decision runs
    Then the decision action is "resume"
    And the dispatch stage is "plan"

  Scenario: continue mode re-enters planning for an unfilled skeleton
    Given the committed ExecPlan says "Status: DRAFT | APPROVED | COMPLETE"
    When the continue-mode decision runs
    Then the decision action is "resume"
    And the dispatch stage is "plan"

  Scenario: continue mode reports a blocked plan for the operator
    Given the committed ExecPlan says "Status: BLOCKED"
    When the continue-mode decision runs
    Then the decision action is "report"
    And the decision skips with reason "plan-blocked"

  Scenario: continue mode never reviews a branch without committed work
    Given the committed ExecPlan says "Status: COMPLETE"
    But the branch has no committed work
    When the continue-mode decision runs
    Then the decision action is "report"
    And the decision skips with reason "no-committed-work"

  Scenario: continue mode reports an addendum branch
    Given the committed ExecPlan says "Status: APPROVED"
    But the candidate is an addendum branch
    When the continue-mode decision runs
    Then the decision action is "report"
    And the decision skips with reason "addendum-branch"
