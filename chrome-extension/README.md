# Synapse Chrome companion (local development)

Windows and Chrome 125+; one ordinary profile. Chrome control uses Synapse's hybrid mode and saved OpenRouter/OpenAI keys. Typed commands do not require speech downloads.

Companion 0.1.5 runs common open/search/scroll/play/pause/back/forward/reload/duplicate commands locally and supports scoped workflow recording/replay. Browser follow-ups use the previous task tab in the same conversation. Complex tasks use Jev for concrete action choices and the general planner when text or other parameters must be generated. Website loading and cloud requests still affect total latency.

For recurring tasks, open **Settings → AI → Teach Synapse · Workflows**. Record a selected tab, pause or stop, then edit and test its saved steps. Entered values become input placeholders; sensitive fields are excluded. See the [workflow guide](../docs/teach-synapse.md). Reload this extension at `chrome://extensions` after updating to 0.1.5, then reconnect.

In voice mode, say “Synapse, open this video Sora memes”, then “Synapse, pause it”. In Settings → AI, edit **Voice command prefix** to use another word or phrase, or disable the prefix requirement. Changes apply to the next command; a blank prefix uses "Synapse". The companion prioritizes controls currently on screen, so visible video titles are not crowded out by offscreen controls. Named-video requests use an existing page; missing or ambiguous titles require clarification rather than an unrequested search. Page understanding uses text/control metadata; this companion does not continuously stream screenshots.

1. Run Synapse with `npm run tauri dev` from `synapse/`.
2. In Chrome, open `chrome://extensions`, enable **Developer mode**, select **Load unpacked**, and choose this `chrome-extension` directory.
3. Copy the extension's ID and run from the repository root:

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\chrome-extension\register.ps1 -ExtensionId YOUR_EXTENSION_ID
   ```

4. In Synapse **Settings → AI**, enable **Hybrid desktop control** and **Chrome control**. Use **Start AI with typing** if you prefer text or have not installed the voice engine.
5. Open the extension popup and click **Reconnect**. It should say **Connected**.

Open Synapse's AI tool and try “Open Wikipedia”, “Search for Rust ownership”, or “Play this video” followed by its visible title. Named YouTube video requests open that video and verify playback without adding a search. Follow-ups retain the selected tab and recent conversation; earlier commands are not repeated. Input mode is configured in Settings → AI, with no mode-switch button on the orb.

In the same AI conversation, follow-ups such as “scroll down” or “pause it” continue on the previous task tab. An explicit “new tab” request starts a new one; “this tab” selects the active Chrome tab. The remembered tab is cleared on disconnect and is not reused across AI conversations.

The app reviews consequential actions, including non-search form submissions. Passwords, payment fields, CAPTCHAs, file transfers, incognito, profile switching and internal Chrome pages require manual handling. Only relevant task-page text and control metadata go to the existing cloud providers; field values are excluded from action logs and observations. Commands you give Synapse still appear in conversation history.

**Stop:** press `Ctrl+Alt+Escape`, close the AI panel, or click **Stop task** in the extension. Already completed website actions cannot be undone. Opening DevTools or dismissing Chrome's debugging indicator interrupts the task. After a disconnect, reconnect and make a new request; actions are never replayed automatically.

**Troubleshooting:** enable Chrome control before reconnecting; check the registered extension ID after moving this directory; keep the helper manifest beside the debug app/helper binaries. Port 47321 must be available. A packaged older Synapse build does not contain the bridge: run this checkout's development app. Native-host errors appear in Chrome's extension service-worker console and app connection status.

“Specified native messaging host not found” means Chrome has no native-host registration. The popup shows a setup command containing this extension's exact ID. Run it from the repository root, then click Reconnect. After updating extension files, click Reload on its card at `chrome://extensions`.

**Remove registration:** rerun the same registration command with `-Remove`, then remove the extension through Chrome. The script only removes a registry entry belonging to this checkout. It does not modify Chrome profiles or install browser policies.

## Checks

```powershell
node --test chrome-extension/test/*.test.mjs
```

For live checks, serve `test/fixture.html` over HTTP, then test filling, search Enter, confirmed Submit, dynamic stale controls, iframe and shadow-root controls, and media play/pause. Test navigation, tab switching, declining a confirmation, emergency stop, Chrome closure, DevTools detach, and extension reload in real Chrome. Live AI tasks consume your provider credits.

```powershell
python -m http.server 8766 --bind 127.0.0.1 --directory chrome-extension/test
```

Open `http://127.0.0.1:8766/fixture.html` in the controlled profile. Frame input and selection are supported; nested, transformed, or out-of-process frame clicks are handed off pending live coordinate validation. Document responses that would download are blocked during a task and require manual handling.
