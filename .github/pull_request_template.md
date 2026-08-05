## What changed

<!-- One or two sentences. The PR title becomes the squash commit subject, so
     keep it Conventional Commit shaped: feat: / fix: / docs: / chore: ... -->

## Why

<!-- The reasoning that is not visible in the diff. This repo's comments carry a
     lot of "we tried X and it broke Y" history; if this change is another one of
     those, say so here and consider putting it in the code too. -->

## Verified how

<!-- CI proves it compiles. Say what you actually ran. -->

- [ ] `npm run typecheck && npm run lint && npm run test`
- [ ] `cargo clippy --all-targets -- -D warnings && cargo test --lib`
- [ ] `node scripts/guards/run.mjs`
- [ ] Ran the app (`npm run tauri dev`) and exercised the change by hand

## Checklist

- [ ] Windows behaviour verified on real hardware
- [ ] macOS paths, if touched, are marked untested (no macOS hardware here)
- [ ] New colours/spacing come from `theme.css` tokens, not literals
- [ ] `PROGRESS.md` updated if a future session needs to know about this
