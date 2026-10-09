# Desktop Assistant Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Windows app launching, switching, local file discovery, opening, and current-app questions reliable through the existing Synapse orb.

**Architecture:** Extend the existing native desktop adapter and hybrid action loop. Rust owns target identities, actual paths, pending choices, cancellation, and result evidence; the model interprets requests and chooses typed actions. Reuse the existing workflow execution lock, browser bridge, conversation lifecycle, and UI tokens.

**Tech Stack:** Tauri 2, Rust, installed `windows` bindings, `dirs`, standard filesystem APIs, React/TypeScript, Vitest, existing Rust unit tests.

**Spec:** [Approved desktop assistant design](../specs/2026-10-09-desktop-assistant-design.md).

## Global Constraints

- Context is captured when Synapse is invoked and refreshed during an active task.
- There is no background activity timeline. Windows is the acceptance platform.
- Keep the existing provider configuration and hybrid-mode opt-in.
- No new dependency is planned; reuse installed libraries and native APIs.
- Search: at most 20,000 entries, depth 12, a two-second cooperative traversal budget, and up to five candidates.
- Use an eight-second cooperative verification deadline with cancellation checks.
- Keep the 16-step task bound and existing error handoff.
- Do not add raw snapshots or screenshots to persistent history.
- Preserve the directory-only saved-workflow path contract and existing recipe format.
- No whole-disk index, file-content search, always-on monitoring, file modification/deletion, new terminal automation, or broad UI redesign.
- No new persistent settings, database migration, release version, window label, or capability is expected.

## Review Focus

- Reused window handles or process IDs must not authorize input to a different app (Task 1).
- Explorer tabs, virtual folders, and redirected known folders must not become guessed paths (Tasks 1 and 4).
- Long/Unicode names, overlapping roots, inaccessible entries, and reparse points must not corrupt search or imply exhaustive coverage (Task 3).
- A clarification reply advances the conversation turn; valid choices must survive that transition while stale clicks and late responses remain rejected (Tasks 5 and 7).
- An already-running app, a cloud document, or an accepted launch with no observable document must not produce duplicate launches or false success (Tasks 2, 4, and 6).

## Execution baseline and file responsibilities

The working tree already contains substantial modified and untracked browser/workflow code. Its behavior is part of the baseline, not this task's diff. Before edits, record `git status --short`, `git diff --stat`, and the existing check results. Preserve all unrelated changes. Work in this checkout unless a complete copy of its current changes is deliberately made; a worktree from HEAD alone would omit required code.

Each task below includes a commit checkpoint. Inspect and stage only the new task's hunks; do not blanket-add existing dirty files or untracked workflow code. If the changes cannot be staged independently without breaking the baseline, retain the task as a reviewed working-tree checkpoint and record why. Never reset or overwrite existing work to produce a clean commit.

| Files                                                                     | Responsibility                                                                                                                 |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `synapse/src-tauri/src/desktop.rs`                                        | Window identity, native observations/selection, app catalog, native opening, verification. Keep existing COM thread ownership. |
| New `synapse/src-tauri/src/desktop_files.rs`                              | Path validation, bounded name search, ranking and temporary-directory tests. No Tauri or model calls.                          |
| `synapse/src-tauri/src/hybrid.rs`                                         | New actions, typed evidence, request routing, pending candidates and planner schema.                                           |
| `synapse/src-tauri/src/lib.rs`                                            | Invocation capture, session state, choice submission, events and orb sizing.                                                   |
| `synapse/src-tauri/src/workflows.rs`                                      | Shared native operations with unchanged recipe semantics and deadlines.                                                        |
| `synapse/src-tauri/src/workflow_recording.rs`                             | Audit recording/replay assumptions against target validation changes; change only affected callers.                            |
| `synapse/src-tauri/src/browser.rs`                                        | Current-app routing versus previous browser context.                                                                           |
| `synapse/src/AiPanel.tsx`, `synapse/src/AiPanel.css`                      | Visible results and keyboard/click choices in the existing orb window.                                                         |
| New `synapse/src/desktopChoices.ts`, `synapse/src/desktopChoices.test.ts` | Small event-state reducer and tests for actual choice lifecycle behavior.                                                      |
| `synapse/src/settings/AiSection.tsx`                                      | Context/provider help text in the existing AI section.                                                                         |
| `README.md`, `PROGRESS.md`, new `docs/desktop-assistant-validation.md`    | Supported behavior and honest automated/hardware validation ledger.                                                            |

Read root `AGENTS.md`, frontend `AGENTS.md`, and `DESIGN.md` before execution. Run tasks sequentially: they share interfaces and dirty files. The exact native signatures below are proposed internal interfaces, not changes to public saved formats. All new native types and callers stay Windows-gated where needed.

## Task 1: Preserve the actual target and expose on-demand context

**Files:** Modify `desktop.rs` (Desktop/new/observe/focus/input methods), `lib.rs` (capture_previous_focus and session start), `hybrid.rs` (desktop_task), and every affected caller in `workflows.rs`; audit `workflow_recording.rs`. Tests live in the existing Rust modules.

**Interfaces:** In `desktop.rs`, add `WindowIdentity { window: u32, pid: u32, process_started_at: u64, app: String, title: String, observed_at_ms: i64 }` and `ExplorerContext { folder: Option<PathBuf>, selected: Vec<PathBuf> }`. Add `capture_external_target() -> Result<Option<WindowIdentity>, String>`, `Desktop::select_target(&mut self, window: u32) -> Result<(), String>`, `Desktop::target_id(&self) -> Option<u32>`, `Desktop::explorer_context(&self) -> Result<ExplorerContext, String>`, and `Desktop::selected_text(&self) -> Result<Option<String>, String>`. Replace public writable `target` with an optional owned identity. Keep `Desktop::new()`, `observe()`, and `observe_target()` signatures; `new` may succeed without a target so launches can work from an empty desktop.

- [ ] Write failing tests named `desktop_target_reuse_is_rejected`, `desktop_missing_target_does_not_pick_first_window`, and `desktop_title_change_requires_fresh_observation`. Use synthetic old/new identities with the same window handle, different PID/start time, then the same process with a new title. Assert: identity replacement is rejected; no target produces an error; a title change invalidates old controls but can be re-observed without selecting another app.
- [ ] Run `cargo test --lib desktop_` from `synapse/src-tauri`; confirm the new assertions fail before implementation. Add pure target-validation helpers only where native decisions need a test seam.
- [ ] Capture external process identity with foreground/PID/process creation information before overlay/orb activation. Ignore Synapse's own windows. Keep `PREVIOUS_FOCUS` behavior for dictation restoration but never overwrite it with Synapse. Do not perform a full accessibility scan on the UI thread. If identity cannot be verified, allow a limited read-only explanation but reject input.
- [ ] Pin observations to the selected target; remove fallback-to-first and automatic target hopping. Separate explicit `focus()` from input validation: a requested focus/open may activate a target, but click/type/key/scroll must not steal focus back from a different external app. Permit initial restoration from Synapse only after checking the original target. Invalidate control IDs whenever the observation changes.
- [ ] Read Explorer folder/selection through the native shell active view and filesystem items; use `GetSelection(false)` so an empty selection does not silently mean the folder. Match the active view to the captured window; reject ambiguity across Explorer tabs and non-filesystem virtual folders. Read selected text through UI Automation TextPattern, excluding protected controls, capped at 4,000 characters. Report unsupported context instead of guessing a path or taking a screenshot automatically.
- [ ] Migrate every direct `.target =` and native observation/input caller in hybrid/workflows. Preserve explicit workflow target selection. Test `desktop_selection_empty_is_not_parent` and `desktop_virtual_folder_has_no_filesystem_path` with adapter-result fixtures; verify active Explorer tabs live during Task 8. Add only required `windows` feature flags to `Cargo.toml`.
- [ ] Run `cargo test --lib desktop_`, `cargo test --lib workflows::tests`, and `cargo check`. Inspect the diff and checkpoint as `fix: pin desktop actions to verified window identities`.

## Task 2: Resolve installed apps and distinguish launching from switching

**Files:** Modify `desktop.rs`, `hybrid.rs`, and the `OpenApp` branch/tests in `workflows.rs`.

**Interfaces:** Add `AppCandidate { id: String, name: String, launch_path: Option<PathBuf>, windows: Vec<WindowIdentity> }`, `AppActivation { target: Option<WindowIdentity>, accepted: bool, verified: bool, detail: String }`, `Desktop::resolve_apps(&self, query: &str) -> Vec<AppCandidate>`, `Desktop::activate_app(&mut self, candidate: &AppCandidate, switch_only: bool, cancelled: &dyn Fn() -> bool) -> Result<AppActivation, String>`. Native dispatch failure returns an error; accepted but unverified activation returns evidence with `verified: false`. IDs use `ids::new_id()` and resolve through the backend catalog, never through executable text supplied by the model. Keep the workflow `open_app(name)` entry point as a wrapper around unique resolution; migrate its verification into the shared operation and treat an unverified result as a workflow error.

- [ ] Add failing table tests for `VS Code`, `visual studio code`, mixed case/extra spaces, two shortcuts with the same display name, and two windows of the same app. Assert aliases resolve to the installed identity; distinct targets remain choices; `switch_only` with no running window cannot invoke launch.
- [ ] Run `cargo test --lib app_` and observe the intended failures.
- [ ] Normalize names, use explicit aliases for existing built-ins and VS Code, then exact and whole-token matching. Resolve shortcut target identity with native shell information where available; deduplicate by that identity, otherwise retain distinct shortcut paths. Use executable identity/process evidence for running-window matches, not title substrings alone. Keep ambiguous candidates for Task 5.
- [ ] Launch a unique installed candidate or reuse its window. Explicit switch never starts an app. Verify foreground state and process identity for up to eight seconds, checking cancellation; on timeout return an unverified result without retrying the launch. Preserve the verified Chrome path and existing consequential-app review rules.
- [ ] Run `cargo test --lib app_`, existing Chrome launch tests and `cargo test --lib workflows::tests`. Checkpoint as `feat: resolve desktop apps and verify launch or switch`.

## Task 3: Add bounded, cancellable file and folder name search

**Files:** Create `desktop_files.rs`; register it in `lib.rs`. Keep tests in `desktop_files.rs`.

**Interfaces:** Define `EntryKind::{File, Folder}`, `SearchQuery { name: String, kind: Option<EntryKind>, extension: Option<String> }`, `SearchHit { path: PathBuf, kind: EntryKind, exact: bool }`, `SearchReport { hits: Vec<SearchHit>, roots: Vec<PathBuf>, partial: bool, issues: Vec<String> }`, `SearchLimits { entries: usize, depth: usize, budget: Duration, results: usize }`. Production defaults are `20_000`, `12`, `Duration::from_secs(2)`, `5`. Add `search(query: &SearchQuery, roots: &[PathBuf], limits: SearchLimits, cancelled: &dyn Fn() -> bool) -> Result<SearchReport, String>` and `validate_local_path(path: &Path) -> Result<PathBuf, String>`.

- [ ] Create unique temporary fixtures with `ids::new_id()` under `std::env::temp_dir()`. Add tests for duplicate `Budget.xlsx` files, mixed case/Unicode, overlapping roots, missing roots, a file renamed during search, and a root containing a reparse point. Cleanup only the exact fixture directory. Test smaller explicit limits to prove entry/depth/result limits without creating a huge tree; test an already-expired budget and immediate cancellation.
- [ ] Pin the defaults and cancellation contract with assertions:

  ```rust
  let limits = SearchLimits::default();
  assert_eq!((limits.entries, limits.depth, limits.results), (20_000, 12, 5));
  assert_eq!(limits.budget, Duration::from_secs(2));
  assert!(search(&query, &roots, limits, &|| true).is_err());
  ```

- [ ] Run `cargo test --lib desktop_files::tests`; confirm failures before writing the implementation.
- [ ] Validate absolute local paths, rejecting embedded NULs, URL schemes, UNC/device paths, alternate data streams, and drive-relative forms such as `C:notes.txt`. Accept canonical extended local drive paths produced by Windows, not arbitrary device namespaces. Canonicalize and reject nonlocal/reparse redirects before opening. Handle Windows reserved names through platform resolution, not string concatenation.
- [ ] Traverse iteratively with cooperative deadline/cancellation checks and metadata-only reads. Count root depth as zero and all visited entries toward the shared limit. Skip child reparse/symlink/hidden/system directories and `.git`, `node_modules`, `target`, `dist`, `build`, `.next`, `.cache`. An explicit hidden root is allowed. Do not read file contents or hydrate placeholder contents. Sort bounded batches and discovered hits; cap enumeration rather than collecting an unbounded directory before checking limits. Ranking is deterministic for a given set of hits, but a time-limited traversal may discover a different subset and must report partial coverage.
- [ ] Deduplicate canonical roots/hits with Windows case handling, preserving actual path spelling. Rank exact name (including extension, or exact stem if no extension was requested) above whole-token matches, then path order. Mark `partial` and explain issues for inaccessible roots, exclusions, or bounds; return at most five suggestions. Empty query and all-invalid roots return useful errors. Do not open anything in this module.
- [ ] Run `cargo test --lib desktop_files::tests` and `cargo clippy --all-targets -- -D warnings`. Checkpoint as `feat: search local files and folders with bounded coverage`.

## Task 4: Open real paths and verify what Windows actually did

**Files:** Modify `desktop.rs`, `desktop_files.rs`, and the workflow `OpenPath` implementation/tests.

**Interfaces:** In `desktop_files.rs` add `OpenPolicy::{Document, Review}` and `open_policy(path: &Path) -> OpenPolicy`. In `desktop.rs` add `OpenEvidence { requested: PathBuf, accepted: bool, verified: bool, target: Option<WindowIdentity>, detail: String }`, `known_search_roots() -> Result<Vec<PathBuf>, String>`, and `Desktop::open_path(&mut self, path: &Path, cancelled: &dyn Fn() -> bool) -> Result<OpenEvidence, String>`. The latter is a native operation; the hybrid caller must establish path provenance and obtain any review before invoking it.

- [ ] Add failing tests for identical folder basenames under different parents, paths with spaces/quotes/Unicode, deleted candidates, a `.pdf.exe` double extension, uppercase extensions, `.lnk`, and OS-accepted documents with no observable identity. Assert canonical full-path equality is required for folder verification, dangerous/unknown types require review, and acceptance alone leaves `verified == false`.
- [ ] Run `cargo test --lib path_` and the path policy tests in `desktop_files::tests`; confirm the intended failures.
- [ ] Resolve Desktop/Documents/Downloads using actual known-folder locations (installed `dirs` where it uses the Windows known-folder API, otherwise `SHGetKnownFolderPath`). Combine with captured Explorer location in the caller. Never derive Downloads by appending a hard-coded English folder name to the home directory.
- [ ] Treat folders and the following document extensions as routine opening: `txt`, `md`, `pdf`, `png`, `jpg`, `jpeg`, `gif`, `bmp`, `webp`, `csv`, `docx`, `xlsx`, `pptx`, `odt`, `ods`, `odp`. Everything else, including scripts, shortcuts, installers and macro-enabled Office types, requires existing confirmation. Revalidate the canonical path, file kind, and policy immediately before dispatch; if the reviewed target changed, discard the review.
- [ ] Reuse Explorer windows for an exact folder match, otherwise open through a literal path argument. Verify native active-folder identity and foreground state. Open documents through the installed opener/native shell, never a shell command string. A full observed document path can verify success; title/basename alone cannot. On accepted-but-unverified return the exact spec message: `Sent the file to its default app; I couldn't verify it opened`.
- [ ] Migrate workflow directory opening to the helper, retaining its directory-only validation, expected-state checks, cancellation/deadline, and error on unverified outcome. Add a regression test proving a workflow file path is still rejected. Stop after one accepted launch; do not relaunch cloud documents on timeout.
- [ ] Run the targeted tests plus `cargo test --lib workflows::tests`. Checkpoint as `feat: open validated paths with explicit result evidence`.

## Task 5: Keep candidate choices across valid follow-ups only

**Files:** Modify `hybrid.rs` (owned types and helper methods) and `lib.rs` (ConversationState, message submission, session clearing, command registration). Tests stay in both modules.

**Interfaces:** In `hybrid.rs` define `ChoiceTarget::{Path { path: PathBuf, kind: EntryKind }, App(AppCandidate), Window(WindowIdentity)}`, `ChoiceIntent::{OpenPath, OpenApp, SwitchApp}`, `Choice { id: String, name: String, kind: String, location: String, target: ChoiceTarget }`, and `PendingChoices { id: String, session: u64, turn: u64, question: String, items: Vec<Choice>, intent: ChoiceIntent, operations: Vec<RequestedOperation>, outcomes: Vec<ActionOutcome>, actions_used: usize, errors: usize }`. Define `RequestedOperation { id: String, description: String, action: String }`, `OutcomeStatus::{Verified, Unverified, Partial, Cancelled, Failed}`, and `ActionOutcome { operation_id: String, action: String, status: OutcomeStatus, message: String, evidence: Value }` here for Task 6. Only IDs/display fields are serialized to the frontend. `ConversationState` gains Windows-gated `desktop_target: Option<WindowIdentity>` and `desktop_choices: Option<PendingChoices>`.

Add `ChoiceSelection { set_id: String, choice_id: String }` and `ConversationState::take_desktop_choice(&mut self, session: u64, turn: u64, selection: &ChoiceSelection) -> Result<(ChoiceTarget, PendingChoices), String>`. The returned consumed set retains action intent and completed-operation evidence for resumption. Add optional `choice: Option<ChoiceSelection>` to `send_ai_message`; existing callers omit it. Register `respond_desktop_choice(app, session, turn, set_id, choice_id, silent) -> Result<String, String>` as a Tauri command delegating to the same message executor with a trusted selection. The common executor acquires the existing workflow/manual guard once and handles history/TTS once.

- [ ] Add failing lifecycle tests for: valid next-turn choice, old session, old result set, duplicate click, cancelled session, and a new unrelated command. Assert a consumed ID cannot run twice, a clarified switch stays switch-only, and resuming a compound request retains completed operations. Keep the pending set during ordinary `interrupt_ai_reply` turn advancement; clear it on explicit stop, session end/renew, replacement search, or an unrelated submitted request.
- [ ] Run `cargo test --lib desktop_choice` and the existing conversation lifecycle tests, observing new test failures before implementation.
- [ ] Mint result-set and candidate IDs with `ids::new_id()`. Validate session/turn/set membership under the conversation lock and consume a choice once; release the lock before COM, filesystem, confirmation, or network work. New ordinals apply only to the latest pending set. Limit choices to five and include parent paths/window titles to distinguish duplicates.
- [ ] Handle exact ordinal follow-ups (`1` through `5`, `first` through `fifth`, optional `the`/`one`) locally. Let other natural replies resolve only to a current candidate ID through the planner. An ordinal uses the pending list; `that file` without a list uses one Explorer selection. Conflicting pending/selected sources produce clarification, not automatic opening. Selected files become backend-owned candidates and receive the same revalidation.
- [ ] Use `ai-desktop-context` events with `{ session, turn, generation, app, title, question, choices, partial, scope }`; each choice contains `{ id, name, kind, location }`, and `choices` is either `null` or `{ id, items }`. Send only to `AI_LABEL`. Reject late publications as well as late responses by checking session/turn before mutating state or emitting. No raw context snapshots enter conversation history.
- [ ] Add a path provenance helper that accepts only backend candidates, verified Explorer selections, known-folder aliases, or a literal absolute path actually supplied in the user's request. A model-created location is not sufficient; ambiguous path boundaries require clarification. Add tests where app text says to open a different executable and where the model invents a valid-looking path; neither may dispatch an opener.
- [ ] Run lifecycle/provenance tests and `cargo check`. Checkpoint as `feat: scope desktop choices to the active conversation`.

## Task 6: Integrate actions, routing, read-only answers, and completion evidence

**Files:** Modify `hybrid.rs`, `browser.rs`, `lib.rs`, and shared workflow tests.

**Interfaces:** Extend `hybrid::Action` with `FindPath { name: String, kind: Option<EntryKind>, extension: Option<String>, location: Option<String> }`, `OpenPath { candidate: String }`, `SwitchApp { name: String }`, and `Context`. Existing `OpenApp` uses Task 2. `location` must pass Task 5 provenance checks or resolve to a known-folder alias; it is never a raw trusted path.

Consume Task 5's `RequestedOperation`, `OutcomeStatus`, and `ActionOutcome`. Add `format_outcome(outcome: &ActionOutcome) -> String` for factual result copy. Keep evidence task-local (or in the pending clarification) and persist concise action summaries. A planner `Done` is a proposed finish, not evidence.

- [ ] Add tests proving: a screenshot/search cannot complete a requested open; read-only Context can finish without a mutation; an accepted-but-unverified path cannot be reported as verified; and a compound request with one unverified/failed step returns a partial result. Use structured outcome fixtures, not live provider calls.
- [ ] Add routing tests: `open Downloads` stays desktop despite a previous browser tab; `what am I looking at` reads fresh context; `scroll down in Notepad` cannot operate the previous Chrome tab; `pause it` can retain an explicitly established browser follow-up. Also retain saved-workflow alias precedence and hybrid-disabled plain chat behavior.
- [ ] Run `cargo test --lib hybrid::tests` and `cargo test --lib browser::tests`; confirm new failures.
- [ ] Run pending-choice resolution before generic browser shortcuts. Capture lightweight external identity at submission; collect full context only for relevant requests. Supply current app identity alongside conversation context to routing. Distinguish explicit current-app intent from a previous browser follow-up. Reuse the browser bridge for requested Chrome page context; when unavailable, explain window-only context without forcing a launch/reconnect for a read-only question.
- [ ] Extend Action serde, planner JSON examples, choice criteria, action descriptions, confirmation rules, and execution in the same change. Describe `FindPath` as name-only search with reported scope. Publish ambiguity through Task 5. A unique exact match may open for an explicit open request only after coverage/provenance checks; a partial search cannot establish uniqueness. `find` returns results without opening. Context answers must distinguish observation from inference.
- [ ] Replace `succeeded |= result.is_ok()` with per-operation evidence. For compound requests, retain up to 16 ordered `RequestedOperation` entries from the planner; record which actual result satisfies each. Revisions cannot silently drop unfinished operations. On clarification, store this list and its evidence in `PendingChoices` and resume only unfinished operations after selection. Only finish when all requested operations have matching verified evidence, or return an explicit partial/unverified/handoff message. Keep the 16-action bound across clarification turns and the two-error handoff, carrying `actions_used` and `errors` so resumption cannot reset either budget. Observation-only completion has its own evidence and cannot satisfy a launch/open goal.
- [ ] Check cancellation before and after each native/model call and immediately before dispatch. Discard late provider output. After an OS-accepted action, report cancellation honestly without claiming the action was undone. Preserve workflow `require_completion` behavior: an unverified/partial finish remains an error there.
- [ ] Run hybrid/browser/workflow tests and `cargo test --lib`. Checkpoint as `feat: route desktop requests with verified outcomes`.

## Task 7: Show context and usable choices in the orb

**Files:** Modify `AiPanel.tsx`, `AiPanel.css`, `lib.rs::set_ai_input_mode` and AI window show/resize paths, `settings/AiSection.tsx`; create `desktopChoices.ts` and `desktopChoices.test.ts`.

**Interfaces:** Export TS `DesktopChoice`, `DesktopContextEvent` matching Task 5, `DesktopChoiceState { session: number; turn: number; context: DesktopContextEvent | null }`, and `reduceDesktopContext(state: DesktopChoiceState, event: DesktopContextEvent): DesktopChoiceState`. Extend `set_ai_input_mode(app, typing: bool, expanded: Option<bool>)` so existing callers remain valid. Expanded state uses the existing AI window at 440 by 520 logical units, clamped to the current monitor work area; normal voice/typed sizes remain 224 by 224 / 400 by 360. Preserve window position as far as its work area allows.

- [ ] Write Vitest tests proving stale session/turn events do not replace current choices, an explicit clear removes them, and a listening-state transition does not erase the pending question. For example, `expect(reduceDesktopContext(current, stale)).toBe(current)` and `expect(reduceDesktopContext(current, cleared).context?.choices).toBeNull()` with complete local fixtures.
- [ ] Run `npm.cmd test -- src/desktopChoices.test.ts` from `synapse`; confirm the tests fail before implementing the reducer and event handling.
- [ ] Render the current app/title, pending question, up to five candidate buttons with names/kinds/locations, and partial search scope in a compact visible panel. The existing `.orb-announcement` is visually hidden: keep it for announcements, not as the only results surface. Keep the panel visible during listening and allow long paths to wrap or scroll. Use existing theme tokens and one elevation treatment.
- [ ] Support Tab/Shift+Tab and Enter/Space on semantic buttons, plus Escape to dismiss/cancel pending choices. Click submissions use `respond_desktop_choice`; typed/voice answers use the normal turn path. Advance the turn once, prevent duplicate submission, reject old events, and keep backend errors visible. Do not let candidate clicks start orb dragging. Resize through the existing command and restore size on clear/session close; do not create another window.
- [ ] Add concise help to the AI settings: `When you ask for a desktop task, Synapse reads the current app and relevant visible or selected content. Your configured AI providers may receive that context and matching file names. Synapse does not keep a background activity timeline.`
- [ ] Run `npm.cmd run typecheck`, `npm.cmd run lint`, `npm.cmd test`, `npm.cmd run build`, and guards. Inspect the actual window with keyboard navigation, long/duplicate paths, both input modes, reduced motion, and non-default scaling. Checkpoint as `feat: show desktop context and follow-up choices in the orb`.

## Task 8: Validate the complete milestone and record its actual limits

**Files:** Create `docs/desktop-assistant-validation.md`; update README and the current PROGRESS snapshot only after evidence exists. Fix only failures attributable to these changes; retain unrelated baseline findings separately.

**Interfaces:** The validation ledger records scenario, input mode, machine/app versions, iteration, elapsed time, expected target, observed outcome, evidence location, and pass/fail/pending. No private screenshots, actual sensitive filenames, keys, or conversation dumps are committed.

- [ ] Run from `synapse`: `npm.cmd run typecheck`, `npm.cmd run lint`, `npm.cmd test`, `npm.cmd run build`, `npm.cmd run guards:selftest`, `npm.cmd run guards`. Run from `synapse/src-tauri`: `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test --lib`. Check touched frontend/docs with the installed Prettier and run `git diff --check`. Record exact pass/fail results; do not repeat successful checks without new changes or concerns.
- [ ] Build/run the Windows app using the repository's separate Vite/exe logging workflow. Use synthetic files and supported installed apps. Run each spec happy-path example ten times with typed input and ten times with real microphone input. Include cold launch, warm switch, redirected folders, Explorer tabs, duplicate filenames, renamed/deleted choices, an app closing during a request, and a second monitor. Require zero wrong-target actions and zero false completion claims. If an app/hardware/provider is unavailable, mark the case pending rather than substituting a fake pass.
- [ ] Exercise stop during traversal, provider wait, verification, and candidate selection. Verify no late result restarts work. Test cloud placeholder search without content reads and accepted document opens without a reliable document identity. Record cooperative-deadline overruns instead of claiming strict real-time cancellation of blocking OS calls.
- [ ] Run existing-feature acceptance: dictation into two apps with clipboard restoration; clipboard search/paste without self-capture; note save/reopen; screenshot save/copy; selected-text speech; AI speech interruption; browser follow-ups; saved workflow invocation and recording target selection; settings persistence; window hide/reopen; update check without installing. Keep pre-existing pending full workflow acceptance separately visible.
- [ ] Update user documentation with supported commands, search scope, provider context behavior, and truthful unverified outcomes. Retain the approved design limits. Review the final diff against the pre-task baseline and record any acceptance still requiring the user's microphone or hardware. Checkpoint as `docs: record desktop assistant behavior and validation`.

## Native references for implementation

- Use platform known-folder resolution for redirected locations: [Microsoft Known Folders](https://learn.microsoft.com/en-us/windows/win32/shell/known-folders).
- `IFolderView2::GetSelection(false)` returns actual selected items without substituting the parent on an empty selection: [Microsoft GetSelection](https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/nf-shobjidl_core-ifolderview2-getselection).
- Read accessible selected text through native TextPattern: [Microsoft IUIAutomationTextPattern::GetSelection](https://learn.microsoft.com/en-us/windows/win32/api/uiautomationclient/nf-uiautomationclient-iuiautomationtextpattern-getselection).

## Plan self-review

- Context lifecycle and native selection: Task 1; app identity and switching: Task 2.
- Search scope/bounds and path policy: Tasks 3–4; ambiguity, provenance, and session races: Task 5.
- All action schema/caller/result changes, read-only answers, routing and compound outcomes: Task 6.
- Visible results, voice/typed/click interaction, accessibility, window sizing and settings copy: Task 7.
- Automated checks, repeated real Windows/microphone acceptance, regression checks and honest reporting: Task 8.
- All shared interfaces are defined before their consumers. The optional choice argument preserves existing message callers; saved-workflow formats and existing non-Windows compile gates remain unchanged.
- Implementation remains pending plan review and execution-method selection. Native execution is recommended because the tasks share desktop, conversation, workflow and orb interfaces and the checkout contains existing uncommitted work.
