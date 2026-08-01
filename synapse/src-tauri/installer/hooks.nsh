; Tauri's NSIS template !include's this file and expands each macro inline at the
; matching point of the (un)install sequence. Every macro is optional.

; App data (settings.json, snippets, the downloaded ASR model) deliberately
; survives an uninstall/reinstall — which means an `onboarding_complete` left
; over from an earlier install suppresses the setup wizard on a machine the user
; has only just installed on. Every Synapse window starts hidden, so in that
; state the finish page's "Run Synapse" checkbox launches an app with no visible
; window at all and reads as doing nothing.
;
; Drop a marker the app consumes on its next start instead of touching
; settings.json here: a fresh install always lands on onboarding, and the user's
; AI settings and API keys are left alone.
;
; $APPDATA is the Roaming folder of the *installing* user, which lines up with
; Tauri's app_data_dir() only because installMode is currentUser — an elevated
; per-machine install would resolve it to the admin's profile instead.
!macro NSIS_HOOK_POSTINSTALL
  Push $0
  CreateDirectory "$APPDATA\com.synapse.app"
  FileOpen $0 "$APPDATA\com.synapse.app\.fresh-install" w
  FileClose $0
  Pop $0
!macroend
