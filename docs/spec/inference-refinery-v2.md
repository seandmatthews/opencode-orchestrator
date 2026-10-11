# Inference Refinery V2
## A Deterministic Swarm-Orchestration Layer Around OpenCode, Codex, and Evidence Probes

**Status:** V2 architecture specification  
**Primary runtime:** Windows  
**Primary bulk worker:** OpenCode + GLM-5.3-Flash  
**Primary verification / UI worker:** Codex + GPT-6.1 Sol  
**Primary source of truth:** deterministic workflow state + immutable artifacts  
**Primary objective:** turn effectively abundant inference into better software, not merely more software

---

# 1. Executive Summary

Inference Refinery is a local orchestration system for running large, evidence-driven populations of software agents.

It is designed for a world where cheap model inference is abundant enough that it is rational to spend millions of tokens exploring a problem before merging a comparatively small amount of code.

A typical run might:

1. launch 20 independent researchers,
2. distill their outputs hierarchically,
3. create 10 isolated candidate implementations,
4. run deterministic builds, tests, benchmarks, gameplay scenarios, or visual probes,
5. eliminate candidates that fail machine gates,
6. ask specialist evaluators to make evidence-citing observations,
7. distill those observations,
8. produce 5 second-generation candidates,
9. adversarially test them,
10. use GPT-6.1 Sol for deep verification and visual/UI review,
11. prepare one or more integration candidates,
12. stop at an explicit human approval gate.

The defining principle remains:

> **The workflow is deterministic; cognition is stochastic.**

LLMs never decide whether required jobs ran, whether a dependency is complete, whether a candidate passed a deterministic gate, or whether a branch is merged.

The orchestrator controls execution. Models provide research, implementations, observations, critique, synthesis, and proposals.

---

# 2. What Changed From V1

The V1 design had the correct overall shape, but several implementation details were actually architectural requirements. V2 promotes them to first-class concepts.

## 2.1 Feedback Disposition

| Feedback | V2 disposition |
|---|---|
| Context assembly was underspecified | **Accepted and promoted to a core subsystem.** Context budgets, selectors, distillation stages, context packets, and provenance are first-class. |
| LLM judge validity was overstated | **Accepted.** Machine tasks gate; model evaluators advise. Numeric model “confidence” is removed as a decision mechanism. |
| Structured output validation was hand-waved | **Accepted.** Every structured role has a schema, validator, repair attempt, and explicit failure path. |
| Integration / stale worktrees / GC were underspecified | **Accepted.** Candidate base SHA, integration replay, retention tiers, and worktree GC are core concepts. |
| Permission policy lacked enforcement | **Accepted.** Capability restrictions must be enforced outside prompts. |
| Windows runtime issues were ignored | **Accepted.** Windows is a first-class target; jobs are killable and idempotent rather than re-attachable. |
| Prompt versioning, memoization, early stop, approval gates were missing | **Accepted.** All are core domain objects. |
| Godot harness should be a generic probe interface | **Accepted completely.** Probe is now one of the central abstractions. |
| ZCode already has dynamic workflow fan-out | **Accepted with scope clarification.** ZCode can prototype workflow semantics, but persistent lineage, worktree policy, evidence probes, context construction, and cross-runtime execution remain the project. |

Two adjustments are intentional:

1. **Agent evaluators do not promote candidates by score.** They produce evidence-citing observations and comparisons. Machine gates and explicit workflow policy determine survival.
2. **OpenCode is no longer the architecture boundary.** It is a primary worker runtime. Codex, machine probes, ZCode prototypes, CI jobs, and humans are all worker types.

---

# 3. Core Philosophy

## 3.1 Search Broadly, Ship Narrowly

The system should make it cheap to explore many hypotheses and expensive to merge poorly verified code.

A feature that ultimately adds 2,000 lines may reasonably involve 20 research agents, 10 implementations, 50 automated scenarios, 20 evaluation agents, 5 second-generation candidates, 3 deep audits, hundreds of screenshots, and millions of tokens.

That is not waste. That is the search algorithm.

## 3.2 Machine Gates, Agent Advice

A model may observe:

> Candidate B appears to preserve momentum more convincingly than Candidate D in frames 42–67.

A model may not unilaterally decide:

> Candidate B passes.

Candidate survival is driven by explicit policy such as build success, required tests, performance thresholds, fatal-error counts, scenario completion, schema validity, and human checkpoints.

Subjective observations feed synthesis and human judgment. They do not masquerade as calibrated measurements.

## 3.3 Evidence Before Interpretation

Preferred:

```text
candidate
   ↓
probe
   ↓
evidence artifacts
   ↓
evaluation agents
   ↓
structured observations
   ↓
distillation
   ↓
synthesis
```

Avoid:

```text
candidate source
   ↓
agent guesses what runtime behavior probably looks like
```

## 3.4 Context Is Constructed, Not Inherited

No downstream worker receives “everything so far” by default.

Every job gets an explicit **Context Plan** specifying:

- maximum token budget,
- mandatory artifacts,
- selectable artifact classes,
- distillation policy,
- source-preservation requirements,
- exclusions.

Context assembly is part of the workflow. It is observable and reproducible.

## 3.5 Prompts Are Product Assets

Prompts are executable behavior specifications. They require stable IDs, versions, hashes, lineage, test history, and performance metadata.

Changing a role prompt is a versioned system change.

## 3.6 Capability Boundaries Are Enforced Externally

“Do not edit files” is not a security boundary.

A read-only worker should instead receive artifact-only context, a disposable clone, OS-enforced read-only access, a container/VM boundary, or physically restricted tools.

Prompts reinforce policy. They do not implement policy.

---

# 4. High-Level Architecture

```text
                           ┌──────────────────────┐
                           │   Human / API / CLI  │
                           └──────────┬───────────┘
                                      │
                                      ▼
                         ┌────────────────────────┐
                         │    Workflow Compiler   │
                         │ specs → deterministic │
                         │ execution graph        │
                         └───────────┬────────────┘
                                     │
                                     ▼
┌───────────────────────────────────────────────────────────────────┐
│                         CONTROL PLANE                             │
│ Scheduler       Dependency graph       Attempts                   │
│ Phase gates     Approval gates         Retries                    │
│ Budgets         Early-stop rules       Cancellation               │
│ Context plans   Retention policy       Recovery                   │
└────────────┬───────────────────────────────┬──────────────────────┘
             │                               │
             │                               ▼
             │                  ┌─────────────────────────┐
             │                  │      STATE STORE        │
             │                  │ SQLite initially        │
             │                  │ runs/jobs/attempts      │
             │                  │ lineage/checkpoints     │
             │                  └─────────────────────────┘
             │
             ▼
┌───────────────────────────────────────────────────────────────────┐
│                        WORKER ADAPTERS                            │
│ OpenCodeWorker      CodexWorker       MachineWorker              │
│ GLM bulk labor      Sol verification  deterministic commands     │
│ ZCodeWorker*        HumanWorker       Future adapters            │
└────────────┬───────────────┬───────────────────┬──────────────────┘
             │               │                   │
             └───────────────┼───────────────────┘
                             ▼
┌───────────────────────────────────────────────────────────────────┐
│                         ARTIFACT PLANE                            │
│ reports       diffs        commits        screenshots             │
│ video         logs         telemetry      profiler output         │
│ schemas       prompts      context packs  evaluation observations │
│ binaries      models       benchmark data manifests               │
└─────────────────────────────┬─────────────────────────────────────┘
                              │
                              ▼
                     ┌─────────────────┐
                     │ CONTEXT BUILDER │
                     │ select          │
                     │ distill         │
                     │ budget          │
                     │ preserve refs   │
                     └─────────────────┘
```

`ZCodeWorker` is optional in the standalone product. ZCode dynamic workflows are useful for quickly prototyping workflow semantics before those semantics are committed to the standalone engine.

---

# 5. Runtime Strategy

## 5.1 OpenCode + GLM-5.3-Flash

Default use:

- broad research,
- codebase archaeology,
- candidate generation,
- implementation,
- test generation,
- routine fixes,
- fuzz ideas,
- routine review,
- repetitive asset work,
- large fan-out stages.

This is the **massively parallel labor pool**.

## 5.2 Codex + GPT-6.1 Sol

Default use:

- deep verification,
- architecture audits,
- security-sensitive review,
- final code review,
- complex synthesis,
- challenging consensus,
- UI implementation where quality matters,
- UI behavior review,
- visual evaluation from screenshots/contact sheets,
- accessibility review,
- final pre-integration verification.

This is the **scarcer high-quality verification and UI specialist**.

Sol should not automatically be used for every job merely because it is stronger. Its role is to concentrate stronger reasoning at high-leverage fan-in points.

## 5.3 Machine Workers

Machine workers execute deterministic or externally measurable tasks:

- compilation,
- tests,
- static analysis,
- benchmarks,
- game scenarios,
- browser scenarios,
- screenshots,
- telemetry,
- video capture,
- Blender renders,
- profiler capture,
- packaging,
- schema validation,
- Git operations.

Machine outputs can promote or eliminate candidates according to configured gates.

## 5.4 Human Workers

Human checkpoints are modeled as workflow jobs.

Examples:

- approve Generation 2,
- select an unusual candidate for preservation,
- approve access to a sensitive environment,
- approve an integration candidate,
- approve merge.

A paused workflow is a valid persisted state.

---

# 6. Core Domain Model

## 6.1 Goal

```ts
type Goal = {
  id: string
  title: string
  description: string
  successCriteria: string[]
  constraints: string[]
  createdAt: string
}
```

## 6.2 Workflow

```ts
type Workflow = {
  id: string
  version: string
  goalId: string
  phases: PhaseSpec[]
  concurrencyPolicy: ConcurrencyPolicy
  budgetPolicy: BudgetPolicy
  retentionPolicy: RetentionPolicy
}
```

## 6.3 Phase

```ts
type PhaseSpec = {
  id: string
  dependencies: string[]
  jobs: JobTemplate[]
  completion: CompletionPolicy
  earlyStop?: EarlyStopPolicy
  approvalGate?: ApprovalGateSpec
}
```

Possible completion policies:

```text
all
quorum
all-machine-gates
at-least-n
custom deterministic expression
```

## 6.4 Job

```ts
type Job = {
  id: string
  runId: string
  phaseId: string

  worker: WorkerSpec
  role?: RoleRef
  dependencies: string[]

  workspace: WorkspacePolicy
  permissions: PermissionPolicy

  prompt?: PromptRef
  contextPlan?: ContextPlan

  inputArtifacts: ArtifactQuery[]
  expectedOutputs: OutputContract[]

  retryPolicy: RetryPolicy
  timeoutPolicy: TimeoutPolicy
  gatePolicy?: GatePolicy
}
```

## 6.5 Attempt

Jobs and attempts are separate.

```ts
type Attempt = {
  id: string
  jobId: string
  number: number
  state: AttemptState

  startedAt?: string
  endedAt?: string

  processIdentity?: ProcessIdentity
  workerSessionId?: string

  inputContextHash: string
  promptVersion: string | null

  outputArtifacts: string[]
  failure?: FailureRecord
}
```

This supports retrying with a fresh session, alternate model, schema repair, and complete audit history.

## 6.6 Role

Roles are configuration, not classes.

```ts
type RoleSpec = {
  id: string
  version: string

  prompt: PromptRef
  defaultWorker: WorkerSpec

  permissions: PermissionPolicy
  workspace: WorkspacePolicy

  contextPolicy: ContextPlanTemplate
  outputSchema?: SchemaRef
}
```

Example roles:

```text
researcher
builder
code-reviewer
ui-critic
visual-critic
telemetry-analyst
adversary
distiller
synthesizer
integrator
security-auditor
```

## 6.7 Prompt

```ts
type PromptArtifact = {
  id: string
  version: string
  contentHash: string
  content: string
  parentVersion?: string
  changeReason?: string
}
```

Every agent attempt records the exact prompt version used.

## 6.8 Artifact

```ts
type Artifact = {
  id: string
  runId: string
  producerAttemptId: string

  type: ArtifactType
  mediaType: string

  path: string
  contentHash: string
  sizeBytes: number

  lineage: string[]
  metadata: Record<string, unknown>

  retentionClass: RetentionClass
}
```

Examples:

```text
research-report
structured-observation
candidate-commit
diff
test-report
benchmark-report
screenshot
contact-sheet
video
telemetry
log
profiler-capture
blender-model
render
prompt
context-packet
distillation-report
```

---

# 7. Context Assembly — A Core Subsystem

Context construction is one of the primary engineering problems of the project. It must not be delegated to “whatever fits in the prompt.”

## 7.1 Context Plan

```ts
type ContextPlan = {
  maxInputTokens: number

  mandatory: ArtifactQuery[]
  selectable: SelectionRule[]

  distillation?: DistillationPlan

  sourceReferencePolicy: SourceReferencePolicy
  exclusions?: ArtifactQuery[]
}
```

## 7.2 Context Layers

### Layer 1 — Mandatory

Always present:

- goal,
- role prompt,
- project constraints,
- exact candidate under evaluation,
- relevant schemas.

### Layer 2 — Selected Primary Evidence

Chosen by explicit policy:

- evaluation reports for one candidate,
- failing machine probes,
- latest synthesis reports,
- selected diffs,
- specified screenshots.

### Layer 3 — Distilled Evidence

Large populations are reduced before use.

### Layer 4 — Optional Supporting Evidence

Included only while budget remains.

The Context Builder emits a manifest describing exactly what was included and excluded.

## 7.3 Distillation Is a Workflow Stage

```text
20 research reports
      ↓
5 shard distillers
  (4 reports each)
      ↓
5 distilled packets
      ↓
2 cross-shard distillers
      ↓
2 synthesis-ready packets
      ↓
3 independent synthesizers
```

This is preferable to placing 200k+ tokens of raw research into one prompt.

## 7.4 Distillation Preserves Provenance

```json
{
  "claim": "Three researchers identify yaw acceleration as a major contributor to perceived sluggishness.",
  "sources": [
    "artifact:research-003#obs-4",
    "artifact:research-011#obs-2",
    "artifact:research-018#obs-7"
  ]
}
```

A downstream reviewer can expand any distilled statement back to original evidence.

## 7.5 No Untraceable Summary Chains

Rules:

1. Distillation artifacts cite source artifacts.
2. Critical claims can request source expansion.
3. Final synthesis links major conclusions to primary evidence.
4. The UI exposes “show source chain.”

## 7.6 Selection Policies

Selection is explicit.

Possible selectors:

```text
by artifact type
by candidate
by phase
by producer role
by machine gate status
by lineage
by timestamp
by explicit artifact ID
by deterministic tag
```

Semantic/LLM selection may exist later, but if used it becomes a visible job whose selection result is itself an artifact.

There is no invisible “AI relevance filter.”

## 7.7 Context Fingerprints

Every model attempt records a hash of:

- prompt version,
- role version,
- selected artifact IDs/hashes,
- model,
- reasoning configuration,
- relevant project manifest version.

---

# 8. Structured Output Is Load-Bearing

Structured output is required for results consumed programmatically.

## 8.1 Schemas Per Role

Examples:

```text
research.schema.json
observation.schema.json
code-review.schema.json
visual-review.schema.json
distillation.schema.json
synthesis.schema.json
candidate-summary.schema.json
```

## 8.2 Validation Lifecycle

```text
model response
    ↓
parse
    ↓
schema validate
    │
    ├─ valid → persist structured artifact
    │
    └─ invalid
          ↓
      repair attempt
      receives:
        - original response
        - validation errors
        - schema
          ↓
      validate again
          │
          ├─ valid → persist
          └─ invalid → job failure policy
```

The repair loop is bounded.

## 8.3 Raw Output Is Always Preserved

Retain:

- raw model output,
- tool transcript where permitted,
- structured artifact,
- validation result.

## 8.4 Avoid Fake Calibration

Do not require arbitrary values like:

```json
"confidence": 0.78
```

Prefer:

```json
{
  "evidence_strength": "direct-runtime-observation",
  "evidence_refs": ["artifact:frame-42", "artifact:telemetry-7"],
  "limitations": ["No controller-input test was run"]
}
```

---

# 9. Evaluation Model

## 9.1 Deterministic Gates Decide Survival

Examples:

```text
build == success
required_tests == pass
fatal_errors == 0
p95_frame_ms < threshold
scenario_completion == true
save_roundtrip == pass
accessibility_snapshot_parse == pass
```

A failed required gate can eliminate a candidate.

## 9.2 Agent Evaluators Produce Observations

```json
{
  "candidate_id": "flight-004",
  "observations": [
    {
      "category": "camera",
      "finding": "Camera lag obscures heading changes during fast yaw.",
      "evidence_refs": [
        "artifact:contact-sheet-004#frame-12",
        "artifact:video-004#t=00:07.2-00:09.0"
      ],
      "impact": "high",
      "limitations": []
    }
  ]
}
```

A scalar “8.3/10 fun” is not a gate.

## 9.3 Comparative Review Is Allowed, Promotion Authority Is Not

An evaluator may say:

> B shows less visible camera oscillation than D in the supplied scenario.

That becomes evidence for synthesis. The workflow determines which candidates continue.

## 9.4 Synthesizer Diversity

Synthesizers receive lenses too:

- conservative / maintainability-first,
- gameplay-first,
- architecture-first,
- contrarian,
- regression-risk-first,
- visual-quality-first.

## 9.5 Blinded Evaluation

Where useful, evaluator sees Candidate Q / R / S rather than descriptive candidate names or model provenance.

---

# 10. GPT-6.1 Sol Verification Policy

Sol is a first-class worker, but it does not receive magical authority.

## 10.1 Deep Code Verifier

Read-only.

Inputs:

- candidate diff,
- relevant source,
- machine test outputs,
- architecture constraints,
- previous regressions.

Outputs:

- evidence-citing defects,
- architecture risks,
- missing tests,
- unresolved assumptions.

## 10.2 Security Auditor

Read-only and network-disabled unless required.

Outputs findings and evidence. No auto-fix in the same job.

## 10.3 UI Specialist

Writable only when the job is explicitly implementation work.

Suitable for:

- orchestration dashboard,
- candidate comparison UI,
- context inspection UI,
- artifact viewers,
- approval workflow UI,
- accessibility improvements.

UI implementation still happens in isolated worktrees.

## 10.4 UI / Visual Verifier

Read-only / artifact-only.

Inputs:

- screenshots,
- contact sheets,
- viewport captures,
- interaction recordings,
- accessibility trees where available,
- design brief,
- prior visual regressions.

Outputs evidence-citing observations, responsive-layout failures, inconsistencies, and accessibility concerns.

## 10.5 Consensus Challenger

Receives current synthesis plus selected primary evidence and attempts to falsify the consensus.

## 10.6 Final Pre-Integration Reviewer

Receives a carefully constructed context packet:

- final diff,
- machine gates,
- key lineage,
- unresolved high-impact observations,
- selected visual evidence.

This remains advisory. Human approval remains explicit.

---

# 11. Worker Adapter Contract

```ts
interface WorkerAdapter {
  capabilities(): WorkerCapabilities
  execute(input: WorkerExecutionRequest): Promise<WorkerExecutionResult>
  cancel(attemptId: string): Promise<void>
}
```

Adapters:

```text
OpenCodeWorker
CodexWorker
MachineWorker
HumanWorker
ZCodePrototypeWorker
```

## 11.1 Capability Discovery

```ts
type WorkerCapabilities = {
  images: boolean
  structuredOutput: boolean
  filesystemRead: boolean
  filesystemWrite: boolean
  shell: boolean
  network: boolean
  resumableSession: boolean
}
```

Workflow compilation fails early if a role requests unsupported capabilities.

---

# 12. Probe Interface

The evidence probe is one of the most valuable parts of V2.

A probe converts a candidate workspace plus a scenario into evidence artifacts.

```ts
interface Probe {
  id: string

  run(input: {
    workspace: WorkspaceLease
    scenario: ScenarioSpec
    environment: EnvironmentSpec
  }): Promise<EvidenceBundle>
}
```

Conceptually:

> **workspace + scenario → evidence**

## 12.1 Probe Types

### Command Probe

Runs tests, lint, type checking, scripts, static analysis.

### Benchmark Probe

Produces structured performance results.

### Godot Probe

Can eventually provide:

- scene launch,
- deterministic seed,
- scripted input,
- telemetry,
- screenshots,
- video,
- logs,
- frame timing,
- crash detection.

### Web Probe

Browser automation:

- load page,
- interact,
- capture screenshots,
- collect console/network errors,
- accessibility tree,
- viewport matrix,
- performance metrics.

### Blender Probe

Can:

- import asset,
- render standardized turntable,
- capture orthographic views,
- validate dimensions,
- inspect material count,
- inspect poly count,
- run export/import roundtrip.

### Static Diff Probe

Produces patch, changed-file list, code statistics, dependency changes.

## 12.2 Probe Output

```ts
type EvidenceBundle = {
  probeId: string
  scenarioId: string
  success: boolean

  artifacts: ArtifactRef[]
  measurements: Measurement[]
  gateResults: GateResult[]
}
```

A probe does not interpret “fun.” It records what happened.

---

# 13. Project Manifest

Each project declares how it can be built, tested, run, and probed.

```yaml
project:
  id: pigeon-city
  platform: windows

build:
  command: ./scripts/build.ps1

test:
  command: ./scripts/test.ps1

probes:
  godot:
    adapter: godot
    project_path: .
    scenarios: ./swarm/scenarios

  static:
    adapter: command
    commands:
      - ./scripts/lint.ps1
      - ./scripts/typecheck.ps1

integration:
  target_branch: main

retention:
  losing_worktrees: 24h
  finalist_worktrees: 7d
```

This is what makes the system point-at-anything instead of pigeon-specific.

---

# 14. Permission and Workspace Enforcement

## 14.1 Canonical Checkout Is Protected

A write-capable model worker never receives the canonical checkout as its writable workspace.

Builders receive worktrees or disposable clones. Researchers receive artifact-only context or disposable read-only clones.

## 14.2 Workspace Modes

```ts
type WorkspacePolicy =
  | { type: "artifact-only" }
  | { type: "disposable-clone-readonly" }
  | { type: "worktree-write" }
  | { type: "integration-worktree" }
  | { type: "none" }
```

## 14.3 Read-Only Means Mechanism

Possible mechanisms:

- OS ACLs,
- container read-only mounts,
- copied artifact snapshots,
- tool restriction,
- disposable clone whose mutation cannot affect canonical state.

The implementation can vary. The contract does not.

## 14.4 Secrets

Rules:

- production credentials are never copied into candidate worktrees,
- secrets are not stored in artifact bundles,
- probe environment variables are allowlisted,
- logs are scrubbed where practical,
- network access is explicit per role.

---

# 15. Windows-First Execution Semantics

Windows is not an afterthought.

## 15.1 Jobs Are Idempotent

A job is safe to re-run from its declared inputs.

Running jobs are not assumed to be adoptable after orchestrator restart.

## 15.2 Crash Recovery

On startup:

1. attempts recorded as `running` from a prior process are marked `abandoned`,
2. the supervisor kills known descendant process trees where possible,
3. temporary workspaces are inspected,
4. retry policy decides whether to rerun,
5. no live process is silently reattached based on stale PID metadata.

## 15.3 Process Tree Termination

MVP:

- record root PID,
- use Windows process-tree termination facilities,
- verify descendants disappear,
- treat remaining descendants as cleanup failures.

Later:

- use Windows Job Objects through a small native helper or suitable library.

Godot, Blender, browser, compiler, and model-worker subprocesses are process trees.

## 15.4 Path Handling

Design constraints:

- short run IDs,
- short worktree roots,
- normalized paths,
- shallow artifact names,
- explicit long-path tests,
- no dependence on POSIX symlink semantics.

Use a short configurable root, for example:

```text
C:\swarm\runs\
C:\swarm\wt\
C:\swarm\art\
```

---

# 16. Worktree Lifecycle and Garbage Collection

Worktrees are leased resources.

```ts
type WorkspaceLease = {
  id: string
  candidateId?: string
  path: string
  baseSha: string
  createdAt: string
  expiresAt?: string
  retentionClass: RetentionClass
}
```

## 16.1 Retention Classes

```text
ephemeral
failed
eliminated
survivor
finalist
integration
pinned
```

Example policy:

```text
failed candidate worktree       delete after evidence capture
eliminated candidate            delete after 24 hours
survivor                        keep through generation
finalist                        keep 7 days
integration                     keep until human disposition
pinned                          never auto-delete
```

Commits, diffs, and evidence can survive after physical worktree removal.

## 16.2 Imported Asset Explosion

Project manifests can declare disposable directories such as:

```text
.godot/imported
node_modules
target
dist
.cache
```

---

# 17. Integration Is Its Own Workflow

The winning candidate is not simply merged.

## 17.1 Candidate Identity

Every candidate records:

```text
base SHA
candidate commit SHA(s)
generation
parent evidence
```

## 17.2 Fresh Integration Workspace

At integration:

1. fetch current target branch,
2. create a fresh integration worktree at current target HEAD,
3. replay/cherry-pick/apply selected candidate changes,
4. detect conflicts,
5. launch an explicit integration-repair job if necessary,
6. run the complete required probe suite again,
7. run final Sol verification,
8. wait at a human approval gate.

## 17.3 Staleness Policy

If target drift exceeds configured policy:

- candidate cannot silently advance,
- integration replays against current HEAD,
- relevant probes rerun,
- prior evidence is marked historical.

## 17.4 No Automatic Merge to Main Initially

V2 prepares integration candidates. Humans merge.

---

# 18. Prompt Versioning and Performance Tracking

Every role prompt is versioned.

Example:

```text
researcher@3
visual-critic@5
sol-final-verifier@2
```

Each attempt records the version.

Possible metrics:

```text
schema failure rate
repair rate
job success rate
machine-gate survival of produced candidates
human acceptance rate
tokens per accepted candidate
```

Do not optimize prompts solely against another LLM's preference.

---

# 19. Memoization

## 19.1 Machine Jobs

Deterministic machine jobs are cache candidates.

Cache key may include:

```text
job definition hash
candidate tree hash
scenario hash
tool version
environment fingerprint
probe version
```

## 19.2 Agent Jobs

Agent jobs are not memoized by default because repeated independent sampling is often the point.

Optional replay can be enabled only for identical input fingerprints.

## 19.3 Cache Is Visible

Cache hits are recorded with lineage. They never silently substitute stale evidence.

---

# 20. Early Stop and Bounded Waste

Waste is useful. Unbounded waste is a bug.

Possible stop conditions:

```text
stop after 20 valid researchers
stop when 3 consecutive generations produce no new machine-passing candidate
stop at maximum generation count
stop when all candidates fail required gates
stop at run token ceiling
stop at wall-clock ceiling
stop on human cancellation
```

Do not use model confidence as an early-stop condition.

---

# 21. Human Checkpoint Semantics

Approval is a persisted job state.

```text
waiting_for_approval
approved
rejected
cancelled
```

Example:

```yaml
approval:
  after: final-verification
  required: true
  prompt: "Approve this candidate for manual merge?"
```

The workflow can remain paused indefinitely.

---

# 22. Job State Machine

Suggested states:

```text
pending
blocked
ready
running
waiting_for_schema_repair
waiting_for_approval
succeeded
failed
retryable
abandoned
cancelled
skipped
cached
```

State transitions are deterministic and persisted.

---

# 23. Example Structured Schemas

## 23.1 Observation

```json
{
  "candidate_id": "candidate-Q",
  "observations": [
    {
      "id": "obs-1",
      "category": "camera",
      "finding": "Camera oscillation appears after rapid yaw reversal.",
      "impact": "high",
      "evidence_refs": [
        "artifact:video-Q#00:08.2-00:09.7",
        "artifact:telemetry-Q#yaw-reversal-3"
      ],
      "limitations": [
        "Only keyboard/mouse scenario was evaluated."
      ]
    }
  ]
}
```

## 23.2 Distillation

```json
{
  "source_artifacts": [
    "research-001",
    "research-002",
    "research-003"
  ],
  "claims": [
    {
      "id": "claim-1",
      "statement": "Yaw acceleration appears in multiple reports as a likely source of sluggishness.",
      "source_refs": [
        "research-001#obs-3",
        "research-003#obs-1"
      ],
      "disagreement_refs": [
        "research-002#obs-6"
      ]
    }
  ]
}
```

---

# 24. Example Workflow — Pigeon Flight V2

## Phase 0 — Baseline Probe

Before research:

- build baseline,
- run deterministic flight scenarios,
- capture video/screenshots,
- collect telemetry,
- record tests and performance.

This creates a measurable reference point.

## Phase 1 — Research Fan-Out

20 GLM researchers with different lenses:

1. arcade movement,
2. physics-inspired movement,
3. input responsiveness,
4. controller ergonomics,
5. keyboard/mouse ergonomics,
6. animation readability,
7. camera behavior,
8. landing,
9. momentum,
10. vertical traversal,
11. acceleration curves,
12. game-feel,
13. minimal-change,
14. radical redesign,
15. successful traversal games,
16. bird movement references,
17. accessibility,
18. low-complexity solution,
19. instrumentation-first,
20. contrarian.

Each produces schema-valid research artifacts.

## Phase 2 — Research Distillation

Five shard distillers receive four reports each.

Two cross-shard distillers receive the five distilled packets.

Three synthesizers with different lenses create experiment families.

No synthesizer receives the raw 20-report population unless explicitly requested.

## Phase 3 — Candidate Construction

10 GLM builders.

Each receives:

- original goal,
- baseline evidence,
- experiment brief,
- relevant distilled research,
- project rules.

Each starts from a fresh worktree at the same base SHA.

## Phase 4 — Machine Gates

Every candidate:

- builds,
- runs required tests,
- runs fixed flight scenarios,
- emits telemetry,
- captures screenshots/video,
- collects logs,
- runs performance checks.

A required-gate failure eliminates the candidate unless a bounded repair policy applies.

## Phase 5 — Observational Evaluation

Machine-passing candidates are evaluated by:

### GLM

- broad playtest observations,
- routine code review,
- edge-case hypotheses.

### Sol 6.1

- deep code verification,
- architecture review,
- selected visual evaluation,
- UI/HUD evaluation if relevant.

Evaluators receive evidence packets sized to explicit budgets.

## Phase 6 — Evaluation Distillation

Observations are distilled by category:

```text
controls
camera
animation
landing
performance
architecture
regression risk
```

Each claim preserves evidence references.

## Phase 7 — Generation 1 Synthesis

Three synthesizers:

- gameplay-first,
- maintainability-first,
- contrarian.

They propose second-generation experiment briefs.

## Phase 8 — Second Generation

Five new GLM builders receive evidence, not a command to mechanically combine candidate code.

## Phase 9 — Adversarial Probes

Run:

- rapid alternating input,
- repeated takeoff/landing,
- wall contact,
- roof-edge cases,
- variable frame rate,
- scene reload,
- long flight,
- high/low speed,
- unusual camera orientations,
- controller reconnect where available.

## Phase 10 — Sol Final Verification

Sol receives:

- final diff,
- fresh machine probe report,
- unresolved high-impact observations,
- relevant architecture constraints,
- selected visual evidence.

Sol outputs evidence-citing issues, unresolved risks, suggested regression tests, and integration concerns.

It does not merge.

## Phase 11 — Integration Replay

Selected candidate is replayed onto current target HEAD in a fresh integration worktree.

All required probes rerun.

## Phase 12 — Human Approval

UI shows:

- final diff,
- machine gate report,
- Sol verification,
- candidate lineage,
- remaining observations,
- comparison to baseline.

Human chooses:

```text
approve for merge
reject
return to generation
pin candidate for later
```

---

# 25. Generic Workflow Definition Example

```yaml
workflow: flight-rd-v2
version: 2

limits:
  model_jobs: 16
  godot_jobs: 3
  sol_jobs: 2

phases:
  - id: baseline
    jobs:
      - probe: godot.flight.standard
    completion: all

  - id: research
    depends_on: baseline
    fanout:
      count: 20
      role: researcher
      worker: opencode-glm
    completion:
      quorum: 17

  - id: distill-research
    depends_on: research
    map_reduce:
      shard_size: 4
      shard_role: distiller
      final_count: 2

  - id: synthesize
    depends_on: distill-research
    fanout:
      count: 3
      role: synthesizer
      lenses:
        - gameplay
        - maintainability
        - contrarian

  - id: build
    depends_on: synthesize
    fanout:
      count: 10
      role: builder
      workspace: worktree
      worker: opencode-glm

  - id: machine-gates
    depends_on: build
    foreach: candidate
    probes:
      - build
      - tests
      - godot.flight.standard
      - performance

  - id: review
    depends_on: machine-gates
    foreach: machine-passing-candidate
    parallel:
      - role: routine-reviewer
        count: 3
        worker: opencode-glm
      - role: sol-deep-verifier
        count: 1
        worker: codex-sol
      - role: sol-visual-reviewer
        count: 1
        worker: codex-sol

  - id: distill-evaluation
    depends_on: review
    map_reduce:
      by: category

  - id: generation-1
    depends_on: distill-evaluation
    fanout:
      count: 5
      role: builder
      worker: opencode-glm
      workspace: worktree

  - id: adversarial
    depends_on: generation-1
    foreach: candidate
    probes:
      - godot.flight.adversarial

  - id: final-verification
    depends_on: adversarial
    role: sol-final-verifier
    worker: codex-sol

  - id: integration
    depends_on: final-verification
    role: integrator
    workspace: integration-worktree

  - id: approval
    depends_on: integration
    human_approval: true
```

---

# 26. UI Requirements

The UI is not decoration. Once runs involve hundreds of jobs, the UI becomes the human attention-management layer.

Sol 6.1 is the preferred model for high-quality UI implementation and UI verification.

## 26.1 Run Overview

Show:

```text
Goal
Current phase
Elapsed time
Token usage
Active jobs
Machine-passing candidates
Eliminated candidates
Pending approvals
Disk usage
Worktree count
```

## 26.2 DAG View

Interactive graph.

Clicking a node opens:

- job config,
- prompt version,
- context manifest,
- raw output,
- structured output,
- artifacts,
- retry history.

## 26.3 Candidate Comparison

Columns:

```text
baseline
candidate A
candidate B
candidate C
```

Rows:

```text
machine gates
test results
performance
screenshots
video
observations
diff size
Sol findings
lineage
```

Do not collapse subjective model judgment into a single winner score.

## 26.4 Context Inspector

For every model attempt show:

```text
token budget
mandatory artifacts
selected artifacts
distilled artifacts
excluded artifacts
source chain
context fingerprint
```

The operator must be able to answer:

> Why did this agent know this?

and:

> Why did it not see that?

## 26.5 Artifact Viewer

Native viewers for Markdown, JSON, diffs, screenshots, contact sheets, video, logs, benchmark charts, and structured observations.

## 26.6 Approval Queue

A focused view for human checkpoints with only the evidence needed for the decision.

## 26.7 Retention / Disk View

Show:

```text
active worktrees
disk usage by run
expiring leases
pinned candidates
artifact volume
cleanup actions
```

## 26.8 Prompt Registry

Show:

```text
role
prompt version
schema version
runs used
schema repair rate
job failure rate
human acceptance history
```

Prompt editing creates a new version.

---

# 27. Persistence Model

Initial SQLite tables:

```text
goals
workflows
workflow_versions
runs
phases
jobs
job_dependencies
attempts
workers
roles
role_versions
prompts
prompt_versions
schemas
artifacts
artifact_lineage
context_plans
context_packets
candidates
candidate_lineage
workspace_leases
probe_runs
gate_results
observations
approval_gates
events
cache_entries
retention_actions
```

SQLite is sufficient until actual contention proves otherwise.

---

# 28. Event Log

In addition to current state, keep an append-only event stream.

Example events:

```text
RUN_CREATED
JOB_READY
ATTEMPT_STARTED
ARTIFACT_CREATED
SCHEMA_VALIDATION_FAILED
SCHEMA_REPAIR_STARTED
GATE_FAILED
CANDIDATE_ELIMINATED
WORKTREE_LEASE_CREATED
WORKTREE_GC_STARTED
APPROVAL_REQUESTED
APPROVAL_GRANTED
ATTEMPT_ABANDONED
```

---

# 29. Recovery Semantics

On process restart:

1. open SQLite,
2. reconcile durable state,
3. mark old `running` attempts `abandoned`,
4. kill known process trees when possible,
5. validate worktree leases,
6. validate artifact files/hashes,
7. requeue retryable jobs,
8. preserve waiting approvals,
9. resume scheduling.

Do not depend on live model sessions surviving controller restart.

Session resumption can be an optimization later. Correctness comes from durable artifacts and replayable jobs.

---

# 30. Failure Policies

Possible policies:

```text
retry same worker once
retry fresh session
repair structured output once
switch worker/model
continue after quorum
eliminate candidate
pause for human
abort phase
abort run
```

Failures are normal at swarm scale. They should be visible and boring.

---

# 31. Budgets

Budgeting exists to bound workflows, not to minimize inference.

Track:

```text
input tokens
output tokens
model calls
wall-clock
worker time
probe time
disk usage
worktree count
Sol usage
GLM usage
```

Possible limits:

```text
per attempt
per role
per phase
per run
per model/provider
```

---

# 32. The Quality Ratchet

When a real failure is discovered:

```text
finding
   ↓
reproduction
   ↓
machine probe or test
   ↓
regression artifact
   ↓
project quality suite
```

Examples:

```text
UI breaks at 3440x1440
→ add viewport probe

signal leak after scene reload
→ add lifecycle test

camera clips after high-speed dive
→ add deterministic scenario

old save fails after schema migration
→ add migration fixture
```

Inference should leave the repository harder to break than it was before.

---

# 33. ZCode Dynamic Workflows — Proper Role

ZCode dynamic workflows already demonstrate that script-driven fan-out/fan-in is useful.

Use them early to validate:

- role definitions,
- lens design,
- schema shapes,
- phase semantics,
- distillation prompts,
- useful fan-out counts.

Do not require the standalone engine to exist before learning what workflow semantics work.

The standalone project remains justified because its core value is broader:

- persistent cross-run state,
- worker-runtime neutrality,
- Git worktree isolation policy,
- artifact lineage,
- probe abstraction,
- machine gates,
- context assembly,
- prompt versioning,
- retention / GC,
- Windows lifecycle management,
- human approval semantics,
- OpenCode + Codex coordination.

---

# 34. MVP Sequence

## Milestone 0 — Workflow Semantics Prototype

Use an existing workflow-capable agent environment where convenient.

Validate the job/lens/schema model, research → distill → synthesize pattern, and useful evaluator roles.

No standalone UI required.

## Milestone 1 — Durable Local Control Plane

Build:

- SQLite state,
- job DAG,
- attempts,
- deterministic scheduler,
- retries,
- approvals,
- event log,
- filesystem artifact store.

Worker adapters:

- MachineWorker,
- OpenCodeWorker.

## Milestone 2 — Context System

Build:

- ContextPlan,
- ContextPacket,
- token budgets,
- deterministic selectors,
- shard distillation,
- source lineage,
- context inspector CLI.

This is required before large fan-in.

## Milestone 3 — Workspace / Windows Reliability

Build:

- worktree leases,
- disposable clones,
- retention policies,
- process-tree kill,
- abandoned-job recovery,
- GC,
- short-path run roots.

## Milestone 4 — Probe Layer

Start generic:

```text
command probe
test probe
benchmark probe
screenshot artifact probe
```

Then add Godot.

The first Godot probe should be intentionally small:

- launch one scene,
- run one scripted scenario,
- capture several frames,
- capture log,
- emit telemetry JSON.

## Milestone 5 — Codex / Sol Worker

Add Codex adapter.

Initial Sol roles:

- deep code verifier,
- UI verifier,
- final verifier.

Support:

- read-only workspace where applicable,
- image inputs,
- structured output,
- persisted raw output,
- schema repair policy.

## Milestone 6 — First Full R&D Loop

Run:

```text
5 researchers
2 distillers
2 synthesizers
3 candidate builders
machine probes
3 GLM reviewers
1 Sol verifier per surviving candidate
1 final synthesis
human approval
```

## Milestone 7 — UI

Use Sol heavily for UI work.

Build:

- run dashboard,
- DAG,
- job inspector,
- artifact viewer,
- candidate comparison,
- context inspector,
- approval queue,
- retention view.

Then have Sol perform screenshot-based UI verification across viewport scenarios.

## Milestone 8 — Generations

Add:

- candidate lineage,
- second-generation briefs,
- adversarial probes,
- bounded generation loops,
- early stop.

---

# 35. First Acceptance Test

A successful first end-to-end run should answer all of these.

## Execution

- Did every configured job run exactly as workflow policy required?
- Can the orchestrator recover after being killed mid-run?
- Can incomplete work be rerun safely?

## Isolation

- Could any researcher mutate the canonical repo?
- Did builders receive isolated worktrees?
- Were evaluator jobs prevented from modifying contestants?

## Context

- Can we inspect exactly which artifacts each agent saw?
- Did large fan-in pass through explicit distillation?
- Can a distilled claim be traced to primary evidence?

## Evidence

- Were candidate claims grounded in machine-produced artifacts?
- Did required gates determine survival?
- Were model observations advisory rather than authoritative?

## Structure

- Were structured outputs schema-valid?
- Did invalid outputs go through bounded repair?

## Git

- Can losing worktrees be removed without losing evidence?
- Can a survivor be replayed onto current target HEAD?
- Are integration conflicts explicit workflow events?

## Windows

- Are spawned process trees killable?
- Does restart mark incomplete jobs abandoned and safely retry them?
- Are paths short enough to avoid routine Windows friction?

## Human Control

- Can the workflow pause at an approval gate indefinitely?
- Can a human reject a result without corrupting run state?

## Verification

- Did Sol receive a bounded, inspectable context packet?
- Did Sol cite evidence for its findings?
- Did the final human see machine evidence and Sol findings separately?

If yes, the architecture is working.

---

# 36. Intended End State

The finished system should feel like operating an automated R&D organization.

The human supplies a goal:

> Make the carnival midway feel dramatically more alive without reducing the cozy tone.

The system might conduct:

```text
214 investigations
42 distillation jobs
73 experiment proposals
31 implemented candidates
18 candidates eliminated by machine gates
9 behavioral regressions
56 visual evidence bundles
24 Sol verification passes
5 second-generation candidates
3 adversarial finalists
1 integration candidate
```

The operator is not expected to read 214 transcripts.

Instead the system presents:

- surviving hypotheses,
- evidence,
- lineage,
- final diffs,
- unresolved disagreements,
- machine gate results,
- Sol verification,
- human approval controls.

The purpose of Inference Refinery is:

> **Turn abundant model inference into a controlled experimental process in which context is constructed deliberately, evidence is gathered mechanically, model judgment is advisory and traceable, failures become permanent tests, and only a small amount of well-supported software reaches the human merge decision.**
