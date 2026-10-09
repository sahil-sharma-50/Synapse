# Desktop assistant validation

Development checkout, 2026-10-09. This is implementation evidence, not release or microphone acceptance. The published v0.2.2 installer does not include this milestone.

## Implemented behavior

- On-demand capture of the external Windows app, process identity and title before the orb takes focus. Relevant requests read bounded accessibility context, retained text selection and native Explorer folder/selection information. No background activity timeline is collected.
- Installed/running app resolution, common aliases, explicit switching without launching, ambiguity choices and foreground verification.
- Bounded filename/folder search in the current Explorer folder and Windows-known Desktop/Documents/Downloads, or a user-supplied local folder. Searches report partial coverage; they do not inspect file contents. Limits: 20,000 entries, depth 12, two seconds, five displayed results.
- Literal local paths and backend-owned choices, native Windows associations, file-type review for executable/unknown types, and exact native Explorer folder verification. Generic document opens are always reported as accepted but unverified; no arbitrary text control can establish document identity.
- Session-scoped, single-use numbered results; click, keyboard, typed and spoken follow-up paths; ordered compound requests stop with explicit partial results when verification fails.
- Visible orb context/results, partial-search scope, keyboard choices and Escape dismissal. Expanded size is clamped to the monitor work area.

## Automated and renderer checks

| Check                                        | Result                     | Evidence / scope                                                                                                                                                            |
| -------------------------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Frontend typecheck and lint                  | Passed                     | `npm.cmd run typecheck`, `npm.cmd run lint`                                                                                                                                 |
| Frontend unit tests                          | 44 passed, 12 files        | `npm.cmd test`; includes stale session/turn rejection and clearing desktop results                                                                                          |
| Frontend production build                    | Passed                     | `npm.cmd run build`; existing >500 kB chunk warning remains                                                                                                                 |
| Repository guards                            | 9 passed                   | `npm.cmd run guards`                                                                                                                                                        |
| Guard selftests                              | 13 passed                  | `npm.cmd run guards:selftest`; fixed capability mutation to parse JSON instead of depending on whitespace                                                                   |
| Rust unit tests                              | 160 passed, nine ignored   | `cargo test --lib`; includes review regression tests                                                                                                                        |
| Rust formatting and Clippy                   | Passed                     | `cargo fmt --check`; `cargo clippy --all-targets -- -D warnings`                                                                                                            |
| Actual React result picker, mocked Tauri IPC | Passed                     | Five synthetic duplicate-like long paths; Enter on result 2 submitted one `choice1` with correct set/session/turn; Escape removed choices; stale event did not restore them |
| Small viewport / reduced motion              | Passed in browser renderer | 320 x 480 viewport, no horizontal overflow; actual monitor/DPI acceptance remains pending                                                                                   |

Renderer checks used the official Tauri IPC mock API against the Vite-served React app. They do not prove real OS actions or voice input. The test browser reported a blocked Vite hot-reload websocket and mock event callback warnings; no application exception was observed.

The native app binary also built successfully with `cargo build --bin synapse`. The broader `cargo build` was blocked by a running `synapse-browser-host.exe` file lock (`os error 5`); that existing process was left running. No installer or signed release was built.

## Native Windows checks

The native Explorer probe initially exposed COM re-entrancy errors (`0x8001010D`) and an xcap product-name mismatch. Explorer automation now runs in its own STA, and `Windows Explorer` resolves to the Explorer alias. Exact folder-opening verification reached native focus restoration, where Windows denied foreground activation from the background test process. This is an unresolved acceptance result, not a successful open.

A later read-only probe returned an explicit unavailable/ambiguous Explorer context for the available window; this does not establish successful filesystem-folder or tab acceptance.

The configured native automation helper was unavailable (missing named pipe after retry), so unattended foreground interaction and a real microphone session could not be completed here. Existing development processes were preserved.

## Acceptance still required

Run each happy path ten times typed and ten times through a real microphone on Windows: launch Notepad/Calculator/VS Code; switch an existing app; open Downloads; find/open an ordinary document and a folder; disambiguate duplicate names by number; inspect the current app/Explorer selection; run a compound request. Record iteration, elapsed time, app version, expected target, observed outcome and evidence. Require zero wrong-target actions and zero false completion claims.

Also pending: cold/warm launch behavior, multiple Explorer tabs, redirected/cloud folders, app closing during a request, actual selected text after orb focus, multiple monitors/non-default DPI, Chrome companion profile/window pairing, and regression checks for wheel, dictation/injection, clipboard, notes, screenshot, spoken replies, workflows and signed updates. Automated tests cover parts of these systems but do not substitute for interactive acceptance. macOS remains untested.

## Working-tree handoff

Implementation is left in the existing feature checkout with prior user changes intact; it is not committed, merged, published or installed. The approved spec and plan are under `docs/superpowers/`. Local baseline copies and detailed test logs are retained under the ignored `.superpowers/sdd/2026-10-09-desktop-assistant/` directory because the working tree includes intertwined pre-existing work.

## Independent review and implementation decisions

A fresh reviewer identified four Important defects: lost target continuity for UI/clarification, generic text falsely verifying document opens, reused window handles bypassing observed identity, and local searches intercepted by the browser shortcut. All were corrected with regression coverage. A valid long-Unicode filename rejection was regraded from Minor to Important and fixed against a real filesystem fixture. No review minor was deferred. Final automated suite: 160 Rust tests and 44 frontend tests passed; nine environment-dependent Rust tests are excluded from the default suite. The JSON-mode API test was also run explicitly and passed.

The execution rulings, in order:

1. Use the approved current checkout because required workflow/browser code was uncommitted; baseline copies mitigate the loss of branch isolation.
2. Use native PowerShell execution/ledger steps because the installed Bash was WSL; this changes tooling only.
3. Keep typed native operations and pending choices in `desktop_commands.rs`; this adds one focused module and leaves legacy UI outcomes explicitly unverified.
4. Make app resolution return errors distinctly from no matches; this avoids duplicate launches after enumeration failure but can stop a request that cannot enumerate apps.
5. Verify native COM behavior with live probes instead of pretending mock COM proves Windows behavior; inaccessible hardware cases remain pending.
6. Reuse the existing read-only workflow browser snapshot; it is limited to the connected profile and requires native pairing.
7. Retain working-tree checkpoints and baseline files instead of committing intertwined prior changes; a later deliberate commit is still needed.
8. Self-verify the Chrome pairing change delivered during review: page context is accepted only for one titled Chrome window, unchanged identity/title and a matching page title. Multiple-window cases fall back to accessible window context; live profile pairing is still pending.
9. Preserve unrelated existing browser/workflow/recording code; regression checks cover shared callers, but unrelated defects may remain.
10. Leave hardware acceptance pending after helper/focus failures; no real microphone, Explorer-tab, cloud, or DPI success is claimed.

The UI browser check uses synthetic names only. Private snapshots and raw context were not added to this record.

## Downloads command: JSON-mode fix (2026-10-09)

The user reproduced an OpenAI rejection while asking to open Downloads: JSON mode requires the word `json` in a message. The shared desktop request enabled `response_format: json_object` but relied on JSON-shaped examples without an explicit JSON instruction. This affected planning, choice interpretation and read-only context prompts.

The request builder now prepends `Return only a valid JSON object.` to the system message. A regression test failed before this fix and passed afterward for all three prompt classes while checking that original instructions and user input are preserved. The full Rust suite passed (160 tests). An explicitly run live test using the configured OpenAI key accepted a synthetic Downloads request and returned an `open_path` operation for `Downloads`; it performed no OS action. Actual orb-to-Explorer opening remains an interactive acceptance check.

## AI microphone noise filtering (2026-10-09)

The previous AI capture gate treated 120 ms of audio above an RMS threshold as speech. A deterministic sustained-noise test reproduced an unwanted command start. The AI orb now uses local Silero VAD v5 through `@ricky0123/vad-web` (0.0.31), with ONNX Runtime Web 1.30.0. Browser noise suppression and echo cancellation remain enabled. Only confirmed speech lasting at least 320 ms starts an utterance; 320 ms of leading audio is retained. Short misfires are discarded, and non-speech does not animate the speech level. Existing sensitivity, pause timing and command-prefix settings remain in use. Dictation's separate native capture is unchanged.

The model, worklet and WASM runtime are copied from locked npm dependencies during `predev` and `prebuild`; the runtime JavaScript module is bundled by Vite. Detection makes no remote model/CDN requests. This adds about 16.6 MB of uncompressed local assets plus a lazily loaded JavaScript chunk. Notices are bundled in `vad-notices.txt`.

Validation: the real browser audio pipeline, actual ONNX model and real worklet rejected six seconds of generated white noise, 60 Hz hum and click-like impulses (zero speech starts/ends). A local synthetic spoken Downloads command yielded exactly one start and one completed utterance; abort ended the stream. No remote requests occurred. Unit tests cover short misfires, successive turns, onset retention, prefix behavior, echo-cancellation fallback, late callbacks and cancellation during model initialization. Frontend typecheck, lint, 44 tests, production build, all 13 guard selftests and all nine guards passed. Production assets were checked for presence; the synthetic speech fixture is not shipped.

This is noise filtering, not speaker identification: television dialogue and other people's speech may still be recognized. Keep the command prefix enabled. A real microphone test in the user's room, quiet/whispered speech and actual WebView2 echo behavior remain pending. Very short utterances below 320 ms are intentionally ignored.

## Spoken-reply feedback loop (2026-10-09)

The orb previously accepted microphone speech while generating and playing its own reply. Speech detection correctly classified speaker playback as speech; with the command prefix disabled this immediately interrupted the reply and started another turn. Commands are now accepted only between turns, including greetings and clicked choices. Capture rejects an entire segment that overlaps a busy turn and requires fresh silence (at least 600 ms and the configured silence interval) before accepting the next segment. Voice interruption is intentionally disabled; Escape/right-click still closes the session.

The regression test failed before the fix because playback started another input utterance. It now covers playback ending before VAD's trailing silence, residual echo, a clicked action invalidating pending input and successive fresh commands. The real browser worklet and ONNX model received synthetic speech during a blocked reply: zero input starts/ends; the same speech after the quiet gap produced exactly one start/end. The rendered React orb with mocked Tauri/audio boundaries accepted exactly two intentional turns with the prefix both enabled and disabled, while ignoring greeting/reply callbacks and duplicate transcription callbacks. These checks do not perform real folder opens or use the physical microphone.

Validation: 45 frontend tests, typecheck, lint, production build, nine guards and 13 guard selftests passed. Physical speaker/microphone acceptance and the user's actual Desktop/new-idea open remain unverified.

## Compact results panel (2026-10-09)

The expanded orb now uses a small status header, icon-led file/folder/app rows, a visible Open action and collapsed search details. Full names and paths remain available on hover; multiple matches retain their voice-selection numbers. The native window accepts measured content height, bounded to 180–520 logical pixels, instead of always opening at 520 pixels tall.

Rendered-browser checks: the single-folder fixture measures 440×230; details expand it to 332 pixels. Enter submits the selected choice once; dismissal clears results. Five matches with long names fit a 320-pixel viewport without horizontal scrolling, and reduced motion disables orb animation. Tauri commands were mocked for these checks; actual Windows sizing/focus was not exercised. Frontend typecheck, lint, 45 tests, build, guards, Rust formatting, 160 Rust tests (nine ignored) and Clippy passed. The design detector returned no findings.

## Immediate voice handoff (2026-10-09)

The quiet-gap safeguard above was too restrictive: speaking immediately reset its timer and discarded that entire command. It has been replaced with a separate utterance segmenter that reuses the existing neural speech scores and resets while input is blocked. Playback frames never enter the user segment; fresh speech can begin as soon as the turn finishes, with no forced silence. The 320 ms minimum speech duration still rejects short echo tails. The main orb increased from 164 to 184 CSS pixels; the compact results header retains its small indicator.

A regression test reproduced the missed immediate command before the fix. It now confirms a zero-silence handoff, excludes playback samples from the resulting utterance, rejects a short echo tail and discards input interrupted by an action. The real browser worklet and ONNX model also accepted exactly one immediate command after synthetic playback, with leading/trailing silence trimmed from the fixture and no deliberate gap; playback itself produced zero accepted starts/ends. Frontend typecheck, lint, all 45 tests, build and nine guards passed. The larger orb fits its existing 224×224 window. Real microphone/speaker timing remains unverified; prolonged room echo still depends on device echo cancellation.

## One-request completion and orb cleanup (2026-10-09)

Removed the orb's input-mode switch and details disclosure; Settings still controls the initial input mode. Partial file searches retain a noninteractive “Limited search” label. Browser rendering confirmed both controls are absent and dismissal still works.

Named YouTube video requests now bind completion to the clicked video's ID and verify the resulting page before playback. Verified playback ends the turn immediately. Search commands, search-field filling/submission and unrelated navigation are rejected for that request. Recent conversation is passed separately from the latest instruction and the conversation's selected tab is retained. New Rust regressions cover selected-video completion, search suppression, unrelated video IDs/hosts and repeated actions across changing snapshot IDs.

Removed the fixed 16-action counters from browser and desktop execution, including pending-choice continuations. Execution stops on completion, cancellation, repeated unchanged actions or a two-minute task deadline. These are per-request guards, not a conversation command quota. Frontend typecheck/lint, 45 tests, build and nine guards passed; 162 Rust tests passed (nine ignored), and Clippy passed. The live user's YouTube session and native microphone interaction were not exercised.

Upstream: [VAD API](https://docs.vad.ricky0123.com/user-guide/api/), [local asset bundling](https://docs.vad.ricky0123.com/user-guide/browser/).
