# Synapse Interface Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a smaller radial launcher, calmer onboarding, clearer settings, and automatic voice preview without removing or changing any existing feature.

**Architecture:** Keep the current Tauri window routing and React component boundaries. Make the redesign with native CSS and the established shared tokens, change only the overlay dimensions in Rust, and isolate voice-selection orchestration in one small pure helper so the asynchronous behavior can be tested without adding a DOM test dependency.

**Tech Stack:** Tauri 2, Rust, React 19, TypeScript, Vite, Vitest, native CSS.

**Spec:** `docs/superpowers/specs/2026-09-21-interface-redesign-design.md`

## Global Constraints

- Preserve all eight wheel actions and their order.
- Preserve every existing onboarding and settings feature, state, error path, and persistence behavior.
- Keep the single dark theme, Segoe UI Variable, existing icons, and blue accent.
- Add no frontend dependency.
- Use no continuous or pointer-tracking animation.
- Keep keyboard focus, semantic labels, alerts, status regions, reduced motion, and WCAG AA contrast.
- Do not redesign Notes, Clipboard, AI Panel, Sticky Notes, or shared product behavior outside this scope.
- Do not stage or modify unrelated working-tree changes.

## Review Focus

- Rapid voice changes: only the latest preview may own the playing indicator, while every chosen voice saves immediately.
- Re-selecting the saved voice: it must replay without issuing a redundant settings write.
- Missing TTS engine: voice options remain disabled and explain how to enable them.
- Small or edge-positioned wheel: the 304-pixel window must stay completely inside monitor work areas.
- Narrow settings windows: labels and controls stack without clipping, wrapping action labels, or losing accessible names.

---

### Task 1: Compact wheel geometry and shell

**Files:**

- Modify: `synapse/src/Wheel.tsx`
- Modify: `synapse/src/wedges.ts`
- Modify: `synapse/src/App.css`
- Modify: `synapse/src-tauri/src/lib.rs`
- Test: `synapse/src/wedges.test.ts`
- Test: `synapse/src-tauri/src/lib.rs`

**Interfaces:**

- Consumes: existing `WEDGES`, `wedgePath`, `iconPosition`, and Tauri overlay positioning.
- Produces: a 304-pixel overlay containing a 252-pixel wheel and 176-pixel status surface.

- [ ] **Step 1: Pin the compact frontend geometry with a failing test**

Export a single geometry object from `wedges.ts` and assert its dimensions in `wedges.test.ts`:

```ts
export const WHEEL_GEOMETRY = {
  size: 304,
  outerRadius: 126,
  innerRadius: 50,
} as const;

it("keeps the launcher compact with enough shadow margin", () => {
  expect(WHEEL_GEOMETRY).toEqual({ size: 304, outerRadius: 126, innerRadius: 50 });
  expect(WHEEL_GEOMETRY.size / 2 - WHEEL_GEOMETRY.outerRadius).toBeGreaterThanOrEqual(24);
});
```

- [ ] **Step 2: Run the focused frontend test and verify RED**

Run: `npm.cmd test -- src/wedges.test.ts`

Expected: FAIL because `WHEEL_GEOMETRY` does not exist.

- [ ] **Step 3: Pin the Rust overlay size with failing assertions**

Change the existing overlay-position tests to use `304` and expect the bottom-right position `(1616, 736)`. Change the dragged-window test size to `(304, 304)` and its right/bottom expected positions to `(1616, 736)`.

- [ ] **Step 4: Run the focused Rust tests and verify RED**

Run: `cargo test --lib overlay_position`

Expected: FAIL while `OVERLAY_SIZE` remains `360.0` or the old expectations remain.

- [ ] **Step 5: Implement the compact wheel**

Use `WHEEL_GEOMETRY` in `Wheel.tsx`:

```ts
const { size: SIZE, outerRadius: R_OUTER, innerRadius: R_INNER } = WHEEL_GEOMETRY;
const CENTER = SIZE / 2;
const R_ICON = (R_OUTER + R_INNER) / 2;
```

Set `OVERLAY_SIZE` to `304.0` in Rust and update its comment. In `App.css`, shrink icons to 20 pixels, the status circle to 176 pixels, the hub text measure to fit the 50-pixel radius, and the entrance scale to `0.96`. Keep the real level meter and all existing modes.

- [ ] **Step 6: Verify wheel tests and Rust positioning**

Run: `npm.cmd test -- src/wedges.test.ts src/Wheel.test.ts`

Run: `cargo test --lib overlay_position`

Expected: all focused tests pass.

- [ ] **Step 7: Commit the wheel change**

```powershell
git add -- synapse/src/Wheel.tsx synapse/src/wedges.ts synapse/src/wedges.test.ts synapse/src/App.css synapse/src-tauri/src/lib.rs
git commit -m "feat: compact the radial launcher"
```

### Task 2: Automatic voice selection and preview

**Files:**

- Create: `synapse/src/settings/voicePreview.ts`
- Create: `synapse/src/settings/voicePreview.test.ts`
- Modify: `synapse/src/settings/VoiceSection.tsx`

**Interfaces:**

- Consumes: `Settings`, `preview_voice`, `tts-ended`, and `tts-error`.
- Produces: `chooseAndPreviewVoice(input): Promise<number>` and `isCurrentPreview(active, completed): boolean`.

- [ ] **Step 1: Write failing orchestration tests**

Create `voicePreview.test.ts` with real settings objects and injected functions:

```ts
const settings: Settings = {
  ai: { provider: "openai", anthropic_model: "claude-sonnet-5", openai_model: "gpt-4o" },
  tts: { voice: "alba" },
  voice: { auto_stop_on_silence: false },
  clipboard: {
    history_enabled: true,
    capture_text: true,
    capture_images: true,
    capture_links: true,
    capture_files: true,
    retention_days: 30,
    max_unpinned_items: 500,
    max_storage_mb: 250,
  },
  onboarding_complete: true,
};

it("saves a changed voice before previewing it", async () => {
  const calls: string[] = [];
  await chooseAndPreviewVoice({
    voice: "lola",
    settings,
    save: (next) => calls.push(`save:${next.tts.voice}`),
    preview: async (voice) => {
      calls.push(`preview:${voice}`);
      return 7;
    },
  });
  expect(calls).toEqual(["save:lola", "preview:lola"]);
});

it("replays the current voice without saving again", async () => {
  const save = vi.fn();
  const preview = vi.fn(async () => 8);
  await chooseAndPreviewVoice({ voice: settings.tts.voice, settings, save, preview });
  expect(save).not.toHaveBeenCalled();
  expect(preview).toHaveBeenCalledWith(settings.tts.voice);
});

it("matches completion events only to the active generation", () => {
  expect(isCurrentPreview(8, 7)).toBe(false);
  expect(isCurrentPreview(8, 8)).toBe(true);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm.cmd test -- src/settings/voicePreview.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the pure helper**

Implement only the orchestration needed by the component:

```ts
interface ChooseVoiceInput {
  voice: string;
  settings: Settings;
  save: (settings: Settings) => void;
  preview: (voice: string) => Promise<number>;
}

export async function chooseAndPreviewVoice({ voice, settings, save, preview }: ChooseVoiceInput) {
  if (voice !== settings.tts.voice) {
    save({ ...settings, tts: { ...settings.tts, voice } });
  }
  return preview(voice);
}

export const isCurrentPreview = (active: number | null, completed: number) => active === completed;
```

- [ ] **Step 4: Verify the helper is GREEN**

Run: `npm.cmd test -- src/settings/voicePreview.test.ts`

Expected: all voice-preview tests pass.

- [ ] **Step 5: Replace the select/button trio with a voice choice group**

In `VoiceSection.tsx`:

- remove `voiceChoice` and the Preview and Use Voice buttons;
- render the six `TTS_VOICES` as a labeled `role="radiogroup"`;
- render each voice as a button with `role="radio"`, `aria-checked`, and disabled state;
- call `chooseAndPreviewVoice` on activation;
- use a monotonically increasing request ref so late promise resolutions cannot replace the active generation;
- clear the playing state only when `isCurrentPreview` matches the `tts-ended` generation;
- show `Playing` only beside the active option;
- keep preview failures inline.

- [ ] **Step 6: Run the focused and complete frontend suites**

Run: `npm.cmd test -- src/settings/voicePreview.test.ts`

Run: `npm.cmd test`

Expected: all tests pass.

- [ ] **Step 7: Commit voice selection**

```powershell
git add -- synapse/src/settings/voicePreview.ts synapse/src/settings/voicePreview.test.ts synapse/src/settings/VoiceSection.tsx
git commit -m "feat: preview voices on selection"
```

### Task 3: Calm onboarding flow

**Files:**

- Modify: `synapse/src/Onboarding.tsx`
- Modify: `synapse/src/Onboarding.css`

**Interfaces:**

- Consumes: existing step state, microphone command, model-download hook, TTS setup hook, and finish command sequence.
- Produces: the same five-step behavior in a simpler visual hierarchy.

- [ ] **Step 1: Replace the persistent five-badge rail with current-step progress**

Render the header with the brand, `STEP_LABELS[step]`, `Step ${stepIndex + 1} of ${STEPS.length}`, and a progress element whose transform is driven by `(stepIndex + 1) / STEPS.length`.

- [ ] **Step 2: Simplify intermediate task markup without changing behavior**

Keep all current commands, hooks, text meaning, retry paths, skip paths, progress details, and readiness values. Use one `.ob-task` container per permission or download state. Keep Welcome and Finish as the only screens with the product mark.

- [ ] **Step 3: Replace the onboarding stylesheet**

Use solid `--sy-bg`, `--sy-sunken`, and `--sy-panel` surfaces; one border hierarchy; 12-pixel cards; a fixed footer; left-aligned task screens; and the existing 8-pixel opacity/translate step transition. Remove private raw colors where shared semantic tokens already exist.

- [ ] **Step 4: Verify onboarding compiles and formats**

Run: `npm.cmd run typecheck`

Run: `node_modules\\.bin\\prettier.cmd --check src/Onboarding.tsx src/Onboarding.css`

Expected: both commands pass.

- [ ] **Step 5: Commit onboarding**

```powershell
git add -- synapse/src/Onboarding.tsx synapse/src/Onboarding.css
git commit -m "feat: refine the onboarding flow"
```

### Task 4: Clear settings information architecture and styling

**Files:**

- Modify: `synapse/src/Settings.tsx`
- Modify: `synapse/src/Settings.css`
- Modify: `synapse/src/settings/VoiceSection.tsx`

**Interfaces:**

- Consumes: the existing four section components and optimistic queued settings writes.
- Produces: direct four-item navigation, flat row groups, and responsive voice options.

- [ ] **Step 1: Simplify navigation structure**

Remove `group` from `SECTIONS`, remove `Fragment` and `.set-group-label`, and keep the four buttons as direct navigation children. Preserve `aria-current`, labels, titles, version, and shortcut details.

- [ ] **Step 2: Rebuild settings CSS around flat groups**

Set the sidebar to 176 pixels. Remove the radial page gradient, branded glow, gradient cards, inset highlights, and heavy shadows. Style `.set-card` as a transparent group with a single top rule and rows separated only when needed. Standardize interactive controls at a 32-pixel minimum height and keep a single trailing control axis.

- [ ] **Step 3: Style voice choices as a responsive selection grid**

Add `.set-voice-grid` and `.set-voice-option` styles using a three-column grid at the default size and one column when controls stack. Selected, playing, focus, hover, disabled, and error states must be distinct without relying on animation alone.

- [ ] **Step 4: Verify narrow layouts and source quality mechanically**

Run: `npm.cmd run typecheck`

Run: `npm.cmd run lint`

Run: `npm.cmd run guards`

Expected: all commands pass with no new raw-color or spacing violations.

- [ ] **Step 5: Commit settings**

```powershell
git add -- synapse/src/Settings.tsx synapse/src/Settings.css synapse/src/settings/VoiceSection.tsx
git commit -m "feat: clarify settings navigation and controls"
```

### Task 5: Full verification and bounded visual finish

**Files:**

- Modify only files already in scope if the first visual pass reveals concrete defects.

**Interfaces:**

- Consumes: the completed wheel, onboarding, settings, and voice-preview work.
- Produces: verified builds, screenshots, detector output, and a final review verdict.

- [ ] **Step 1: Run the complete automated suite**

Run:

```powershell
npm.cmd test
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run guards
npm.cmd run guards:selftest
npm.cmd run build
cargo test --lib
```

Expected: every command exits 0.

- [ ] **Step 2: Run the required design detector once**

Run:

```powershell
node C:\Users\sahil\.agents\skills\impeccable\scripts\detect.mjs --json synapse/src/App.css synapse/src/Onboarding.css synapse/src/Settings.css synapse/src/Wheel.tsx synapse/src/Onboarding.tsx synapse/src/Settings.tsx synapse/src/settings/VoiceSection.tsx
```

Expected: capture every finding; do not rerun the detector after fixes.

- [ ] **Step 3: Inspect all affected surfaces in one visual pass**

Capture the wheel, all five onboarding steps, and all four settings sections at their real default Tauri window sizes. Check clipping, overflow, alignment, focus visibility, error/progress states, selected voice, and reduced-motion behavior. Batch all material fixes into one edit round.

- [ ] **Step 4: Confirm the visual fixes once**

Rebuild and recapture the same surfaces once. Stop local polishing after this confirmation round.

- [ ] **Step 5: Run the Impeccable finish review and apply only material findings**

Provide the original request, approved spec, changed targets, direction contract, detector output, and captured screenshots to the shipped finish reviewer. Apply one batch of material fixes, rebuild once, recapture, and request the required verdict. A second correction batch is the ceiling.

- [ ] **Step 6: Record the final visual system**

Run the Impeccable documenter against the shipped surfaces so `DESIGN.md` describes the built result rather than the discarded visual world.

- [ ] **Step 7: Final verification and commit**

Run `git diff --check` and rerun the complete automated suite from Step 1 after any finish-review edits.

```powershell
git add -- DESIGN.md synapse/src/Wheel.tsx synapse/src/wedges.ts synapse/src/wedges.test.ts synapse/src/App.css synapse/src/Onboarding.tsx synapse/src/Onboarding.css synapse/src/Settings.tsx synapse/src/Settings.css synapse/src/settings/VoiceSection.tsx synapse/src/settings/voicePreview.ts synapse/src/settings/voicePreview.test.ts synapse/src-tauri/src/lib.rs
git commit -m "feat: polish Synapse core interfaces"
```
