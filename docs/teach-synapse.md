# Teach Synapse

Teach a recurring task once, review its steps, then repeat the approved recipe by name or voice alias. This development feature supports Chrome, Windows applications exposing UI Automation controls, local notes, and commands started by Synapse.

## First routine

1. Open **Settings → AI → Teach Synapse · Workflows**. You can also type “show my workflows” in AI.
2. Create a routine and give it a name and an alias, such as “start my project”.
3. Describe the task and choose **Draft steps with AI**, capture demonstration context from a selected app, or record actions in a selected Chrome tab or Windows window. These methods can be combined with manually edited steps.
4. Check every target, source, folder, command and input. Resolve missing details. Recording replaces entered text with placeholders; declare inputs and bind those placeholders before running. An expected checkpoint is optional **literal text**, not an instruction such as “verify the page loaded”.
5. Save, then **Test**. Testing performs real actions after a one-time confirmation; it does not grant repeat approval. Inspect step evidence and artifacts, then approve the saved revision.
6. Run by name or alias in AI, for example “Synapse, start my project”. Use your configured voice prefix. Missing input values are requested before execution; answer each addressed question by voice or type the value.

The Workflows window shows progress, approvals, errors, artifacts and the last 50 runs per routine. It can be hidden and reopened during execution. Approvals can be answered there or through AI. Stop with **Cancel** or **Ctrl+Alt+Escape**. Stopping does not undo completed actions. An app restart marks unfinished runs interrupted and never resumes them automatically.

## Four starting recipes

| Routine                   | Suggested steps                                                                                                                                              | Details to supply                                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| Start a project           | Open Docker Desktop → run `docker start YOUR_CONTAINER` → wait for the local HTTP service → open the project folder → open its URL in Chrome                 | Installed app name, exact container, absolute working folder and readiness URL                                       |
| Prepare today's work      | Open the chosen apps → open project folders → open saved Chrome URLs                                                                                         | Exact app names, folders and URLs; existing matching windows/tabs are reused when verified                           |
| Prepare a client update   | Open the project board → collect relevant visible progress into an artifact → draft using that artifact and a selected format note → review → save as a note | Source page, scope/date, style note and any client input; collection covers the observed page, not an entire account |
| Turn a message into tasks | Select a local note or open the message page → collect → draft tasks using that source → review → save as a note                                             | Explicit message source and task format; authentication remains manual                                               |

Sending or submitting through a browser/desktop step needs current action approval. The client-update recipe can stop at a draft. No email integration or unseen project data is implied.

## Commands and recording

Commands use a Synapse-owned PowerShell, CMD or local WSL session. Synapse does not attach to existing terminals or SSH sessions. Select a fixed command, an existing absolute Windows directory or absolute WSL directory, and optionally a WSL distribution. Input substitution into commands is refused. A narrow set of literal Docker start/inspect/compose-up commands can repeat with recipe approval; other commands request confirmation each time. Captured stdout/stderr are bounded to 64 KB each and displayed after execution. Known credential prefixes are masked, but arbitrary secrets cannot be identified reliably: keep secrets out of commands and stored recipes.

Background commands keep their owned service alive until Synapse exits. Cancelling the recipe stops foreground commands and further steps; it does not stop an already launched background service. Add a local readiness step before opening the service. Readiness polling accepts explicit localhost/loopback HTTP(S) URLs and does not follow redirects.

Recording is explicitly started, scoped to the selected tab/window, and can be paused or stopped. Chrome requires companion **0.1.5**: reload its card at `chrome://extensions`, reconnect, and enable Chrome control in Settings → AI. Windows capture/replay uses accessible controls and fresh unique target resolution; unsupported or ambiguous controls need an edit or manual handoff. Sensitive fields are excluded and entered values become placeholders. Recordings stop at 1,000 events; recipes accept at most 100 steps, so trim or split long recordings. Interrupted or incomplete captures remain unresolved drafts.

## Storage and repeat behavior

Definitions and run history live in local SQLite. Editing invalidates repeat approval. A run uses the saved revision it started with. Import/export uses version-1 JSON; imports and exported copies carry no approval. Review imported recipes before testing. History and captured artifacts can be cleared per routine.

Fixed steps execute directly. Description, extraction, drafting and adaptive actions use the configured AI providers. Page/note data are passed as source material, not executable instructions. Terminal scripts are never generated from recording data. Read-only collection/drafting and opening/checking a URL have bounded recovery; uncertain command, click or submission outcomes are not automatically replayed. Clarification, rejected actions and exhausted action limits stop the workflow instead of counting as success.

## Implementation and validation ledger

The approved conversation plan is implemented across the editor, versioned store, execution/approval controller, voice aliases and input dialogue, managed terminals, Chrome recording/replay, native Windows recording/replay, source artifacts, notes, and import/export. Scheduling, marketplace, billing, cloud synchronization, SSH, profile switching and unrestricted control of inaccessible desktop apps are outside this version.

Automated checks cover saved revision/approval isolation, alias collisions, unresolved drafts, source/input dependencies, literal expansion, strict controller handoffs, recording privacy/caps, terminal ownership/timeouts and UI models. Live fixtures verified Chrome recording and replay across frames, Windows UI Automation capture/replay, WSL process ownership, and the editor's test/approval flow at wide and narrow window sizes. The editor fixture mocks Tauri and audio; it is not whole-app voice acceptance.

The release target remains **19 successful runs out of 20 for each complete routine on its actual setup, with zero unauthorized actions**. Those repeated end-to-end trials and microphone acceptance have not yet been completed. Executor fixture timings are not a guarantee of model, network or voice latency.
