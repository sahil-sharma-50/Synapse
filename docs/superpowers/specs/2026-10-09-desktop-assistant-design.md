# Desktop assistant: commands, files, and current-app context

Status: approved by the user on 2026-10-09. Context is captured on invocation.
Implementation has not started.

## Intended outcome

Synapse should understand everyday desktop requests, launch or switch apps, find
and open files and folders, and answer questions about the app the user is working
in. Reliability includes truthful outcomes, useful clarification, cancellation,
and preserving the existing utility features.

Context is captured when Synapse is invoked and refreshed during an active task.
There is no background activity timeline. Windows is the acceptance platform.

## Evidence from the current checkout

- `lib.rs::send_ai_message` tries saved workflows, then hybrid desktop/browser/chat
  routing, or ordinary provider chat when hybrid mode is disabled.
- `desktop.rs` discovers Start Menu shortcuts, launches named apps, focuses
  windows, reads Windows accessibility controls, and captures window screenshots.
  App lookup mostly requires an exact name; Chrome has its own launch path.
- `Desktop::observe` follows the foreground window and falls back to the first
  usable window if its target disappears. Neither behavior is sufficient for
  preserving the intended task target.
- `hybrid.rs` exposes no direct file search or file-open action. Its `succeeded`
  flag records whether any action returned success, including an observation
  action. This is insufficient evidence that the user's whole request succeeded.
- `workflows.rs` already opens and verifies directories, and launches or reuses
  apps. Its `OpenPath` is directory-only; it is not general file opening.
- Browser follow-ups retain a previous tab. That state needs coordination with
  fresh desktop context so an old browser task cannot capture a new desktop request.
- The orb has typed and voice input, task state events, announcements, history,
  cancellation, and generation checks. These remain the entry points.
- This checkout contains substantial uncommitted workflow and browser work.
  Implementation must preserve it and test shared callers against that checkout.

## Approach

Extend the existing hybrid action loop with native app resolution, bounded local
file search, and explicit task context. Let the model interpret natural language;
resolve actual targets and validate operations in Rust.

Using accessibility clicks for all file navigation would add fragile steps and
make search depend on Explorer's visible state. A persistent whole-disk index
would add a separate background subsystem. Neither is needed for this milestone.

Keep the existing provider configuration and hybrid-mode opt-in. Plain chat mode
does not silently gain desktop access. No new dependency is planned; reuse the
installed Windows bindings, `dirs`, standard filesystem APIs, and existing opener.

## User-facing contract

| Request                         | Required behavior                                                                                                                 |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Open VS Code                    | Resolve its installed identity, reuse a matching window or launch it, and verify the target window is foreground.                 |
| Switch to Spotify               | Focus an existing matching window. If none exists, explain that it is not running; do not silently turn switching into launching. |
| Open Downloads                  | Resolve the user's actual known folder, including redirection, then open and verify it.                                           |
| Find my Synapse project folder  | Search folder names in the defined scope; show real matches with distinguishing locations.                                        |
| Open my budget spreadsheet      | Resolve a real file; clarify ambiguity before opening it in the associated app.                                                   |
| Open that file / the second one | Resolve against a current Explorer selection or the pending result list, as specified below.                                      |
| What am I looking at?           | Report observed app/title/content and qualify inferences. No action must be required merely to answer.                            |
| Stop                            | Stop scheduling actions, invalidate pending responses, and retain an honest partial outcome.                                      |

Routine requested launches, switches, searches, and document opens run directly.
Existing review rules for consequential actions remain. Arbitrary command
execution is not introduced through the file-opening path.

## Context and target lifecycle

Capture the external window identity before Synapse takes focus. At command
submission, use the actual external foreground window if available; otherwise use
the last valid external target captured for this invocation. Never replace that
identity with Synapse's own windows. A fresh invocation refreshes the target.

Store window handle, process identity, app, title, observation time, and task/session
identity. Keep COM accessibility objects on their worker thread. Pass only owned
serializable data between the worker and managed state.

Read accessible controls and selected text on demand. For Explorer, use native
shell selection/folder information when available; a display label alone is not a
verified filesystem path. For Chrome, reuse the enabled companion for page context.
If the companion is unavailable, report the limits of available window context.

During execution, keep the target pinned. Explicit focus/open actions can move it
to a newly verified target. If the window closes, its process identity changes, or
the user switches to another app before an input action, stop that action and ask
for a target or resumption. Never silently select the first available window.

Observation-only requests can complete with observed evidence and zero mutations.
Snapshots are task-scoped; retain only the target identity and pending choices
needed for follow-ups. Clear them on session end, cancellation, or a new unrelated
request. Do not add raw snapshots or screenshots to persistent history. Existing
conversation and action summaries continue to be stored locally.

Remote interpretation may receive the relevant app title, selected text, controls,
or requested search candidates. Explain this in the existing AI settings help.
Do not read entire files for filename search. Continue excluding protected fields;
screenshots remain a fallback for an explicit task, not routine continuous capture.
App text, file names, and search results are untrusted data, never instructions.

## Apps, search, and opening

### App resolution

Reuse Start Menu discovery and running windows. Normalize case and whitespace,
support a small explicit alias table (such as VS Code / Visual Studio Code), then
use exact matches before token matches. Deduplicate by launch identity rather than
discarding different shortcuts solely because their display names match.

Only a unique supported match can be executed automatically. Multiple apps or
windows needing user choice produce candidates. Unlisted apps get a clear
not-found result. Preserve the existing verified Chrome launch behavior. No model
output becomes an executable command line.

### File search

Start with the active Explorer folder, when known, plus Desktop, Documents, and
Downloads resolved through the platform. Deduplicate overlapping roots. A user can
name another local directory for the current search; this does not create a new
persistent settings system.

Search names and extensions, with optional file/folder kind and parent-location
constraints. Match case-insensitively and rank exact names before token matches;
use a deterministic path tie-breaker. Partial or ambiguous matches are suggestions,
not authorization to open the highest-ranked result.

Use a cancellable bounded traversal: at most 20,000 entries, depth 12, and a
two-second traversal budget checked between filesystem calls. Do not descend
through symlinks or reparse points, hidden/system directories, `.git`,
`node_modules`, `target`, or build caches. Explicitly named roots may themselves
be hidden but still follow the same child traversal exclusions. Restrict this
initial search to local paths; unsupported network/device paths get a clear error.

Return up to five candidates, searched roots, and whether coverage was partial
because of limits or access errors. These are cooperative limits, not a hard
deadline on an individual filesystem call. Never claim a file does not exist
everywhere after searching only these roots. Suggest a narrower location when
coverage is partial or matches are absent. Do not trigger cloud-file hydration to
inspect contents during search.

### Candidate selection and references

Candidates have opaque backend IDs and actual paths, scoped to the current
conversation and result set. Show name, kind, and parent folder in a compact list
attached to the existing orb. Support keyboard selection, a click, and spoken or
typed replies such as "the second one". Keep choices visible while listening;
the generic microphone hint must not replace a pending question.

An ordinal refers to the pending list. "That file" uses a single current Explorer
selection when there is no pending list. If both sources exist and conflict, ask
which one. Reject stale candidate IDs and revalidate existence and kind before
opening. A model-supplied path must resolve to a user-provided path, an observed
selection, or a backend search result; do not execute invented paths.

### Opening and verification

Open directories in Explorer and ordinary documents through their OS association,
passing paths as literal arguments. Reject embedded NULs, URLs disguised as paths,
device paths, and unsupported network paths. Reuse directory verification from
workflows through a shared helper, preserving its directory-only recipe contract.

Executable/script/installer/shortcut file types must not bypass app launching or
the existing action review rules. Unknown file types require review before invoking
their association. Define and test a conservative document-type allowlist in code.

App success requires the expected window identity and foreground state. Folder
success requires the canonical directory observed in Explorer, not a window title
suffix. File opening records OS acceptance separately from observed document
identity. If the receiving app exposes no reliable identity, say "Sent the file to
its default app; I couldn't verify it opened" rather than claiming verified success.
Use an eight-second cooperative verification deadline with cancellation checks.

## Command flow and failure behavior

1. Accept voice or typed input through the existing session/turn handling.
2. Retain explicit saved-workflow invocation precedence and its execution lock.
3. Resolve pending choices before generic routing. Capture lightweight external
   app identity for desktop/context routing; ordinary conversation does not need a
   full accessibility scan.
4. Route desktop/file/context requests to typed actions. Explicit current-app intent
   overrides an old browser follow-up target. Refresh observations as needed.
5. Validate the target and action in Rust, execute, then record specific evidence.
6. Return verified, unverified, partial, cancelled, or failed outcomes accurately.

Extend the existing action enum and planner schema together for search, opening,
and context answers. Observation and successful search are not evidence that an
open action completed. For compound requests, track evidence for each requested
operation; a partial result cannot turn the entire request into success.

Keep the 16-step task bound and existing error handoff. Do not repeat an uncertain
launch just because verification timed out. Cancellation invalidates late model
responses and candidate submissions; an action already accepted by Windows may
still finish and must be described accordingly.

## Change surface

| Area                                    | Required reach                                                                                                                                                                                 |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `desktop.rs`                            | Target validation, owned context snapshot, app resolution, native selection, shared opening and verification. Audit every `observe`, `observe_target`, `focus`, and `open_app` caller.         |
| New `desktop_files.rs`                  | Bounded name search, candidate ranking, path/type validation, and focused temporary-directory tests. Register in `lib.rs`.                                                                     |
| `hybrid.rs`                             | Action enum, planner schema, routing, confirmation classification, descriptions, result evidence, pending-choice handling, and tests.                                                          |
| `lib.rs`                                | External focus capture, task-scoped state, candidate-response command, session invalidation, event payloads, and lifecycle tests.                                                              |
| `workflows.rs`, `workflow_recording.rs` | Adapt shared desktop callers without changing saved recipe format; preserve directory-only opens and recording/replay target behavior.                                                         |
| `browser.rs`                            | Ensure stale browser follow-ups cannot override explicit current desktop context; retain browser-specific follow-ups and cancellation.                                                         |
| `AiPanel.tsx`, `AiPanel.css`            | Compact candidates, context/status text, keyboard handling, persistent clarification state, and stale-event rejection. Reuse theme tokens.                                                     |
| AI settings help                        | Explain on-demand context and provider transmission using existing controls. No new persistent setting is required.                                                                            |
| Tests/fixtures                          | Extend existing hybrid, lifecycle, browser, workflow, and orb tests where behavior changes; use synthetic names and temporary files.                                                           |
| Documentation/config                    | Update README and current progress after validation. No migration, release version change, new window, or new capability is expected; add only necessary Windows binding features if required. |

## Verification and release acceptance

Automated coverage must exercise ambiguous app names, duplicate filenames, missing
roots, partial search, cancellation, stale choices, path validation, reparse-point
exclusion, closed/changed targets, read-only completion, compound partial outcomes,
and file-open acceptance without document verification. Test behavior through the
smallest existing public boundaries; do not mirror implementation branches.

Run frontend typecheck/lint/tests/build, guard selftests and guards, Rust unit tests,
clippy with warnings denied, rustfmt, and touched-file Prettier checks. Record
pre-existing failures separately from regressions. Do not call hardware acceptance
complete because pure tests pass.

Run each new happy-path example ten consecutive times on Windows, using typed
input and real microphone input. Include cold app launch, warm switch, redirected
known folders, duplicate files, a renamed/deleted candidate, and a second monitor.
Require zero wrong-target actions and zero false completion claims. Record timing,
actual outcomes, and machine/app details rather than asserting an unmeasured speed.

Run focused existing-feature acceptance: dictation into two apps with clipboard
restoration; clipboard search/paste without self-capture; note save/reopen; screenshot
save/copy; selected-text speech; AI speech interruption; browser follow-up routing;
saved workflow invocation; settings persistence and utility-window reopen. Exercise
update checks without installing an update during this work. Preserve any previously
pending full workflow/microphone acceptance as pending unless actually completed.

## Deliberate limits

No persistent whole-disk index, semantic file-content search, always-on monitoring,
file modification/deletion, new terminal automation, or broad UI redesign. Large or
excluded directories may require a narrower search root. Accessibility varies by
app, so incomplete context and unverified document opens remain explicit outcomes.
This milestone provides tested desktop basics; it does not promise universal app
control or establish untested macOS support.
