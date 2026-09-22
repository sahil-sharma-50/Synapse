# Contributing to Synapse

Thanks for helping improve Synapse. Windows is the tested platform; macOS paths exist but need real-hardware validation. Please state which platform you used when reporting or verifying behavior.

## Before you start

- Search [issues](https://github.com/sahil-sharma-50/Synapse/issues) and open pull requests for related work. For a larger feature or a behavior change, open an issue first so the scope is clear.
- Use the [README](README.md) for current features, [AGENTS.md](AGENTS.md) for architecture and safety rules, and [DESIGN.md](DESIGN.md) for UI changes. `synapse_prd.md` records the original v1 plan and contains historical decisions.
- Never include API keys, local app data, downloaded models, signing keys, generated installers, or screenshots containing private information in a commit or issue.

## Set up

Install Node.js 22, a stable Rust toolchain, and on Windows the MSVC build tools and WebView2 runtime. Then, from `synapse/`:

```powershell
npm ci
npm run tauri dev
```

On a fresh install, allow esbuild's install script if npm prompts for approval (`npm approve-scripts esbuild`). Onboarding can download the ASR model and optional local voice engine; those downloads are not required for UI-only work.

## Make a change

1. Branch from `main` and keep the pull request focused. Include a short reason for the change and any user-visible effect.
2. Follow existing types, components, and Rust modules. Keep API credentials in the OS credential store; do not add them to settings JSON. Keep the signed `tauri-plugin-updater` path intact.
3. For UI work, reuse `synapse/src/theme.css` tokens, maintain keyboard and screen-reader basics, and check narrow windows and reduced motion. See [DESIGN.md](DESIGN.md) and [synapse/src/AGENTS.md](synapse/src/AGENTS.md).
4. Add or update a focused check for nontrivial logic. If you add a repo guard, add a matching case in `scripts/guards/selftest.mjs`.

## Verify

Run the checks relevant to your change. CI runs the full set on pull requests.

```powershell
# From synapse/
npm run typecheck
npm run lint
npm run test
npm run build
npm run guards:selftest
npm run guards

# From synapse/src-tauri/
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test --lib
```

The frontend has a Prettier ratchet: format files you touched rather than reformatting the whole tree as part of a feature. Rust formatting applies to the whole crate. The installer workflow builds unsigned PR artifacts; only the maintainer's release workflow can sign updates.

## Open a pull request

Use a Conventional Commit shaped title (`feat:`, `fix:`, `docs:`, `chore:`). Fill in the pull request template with what changed, why, checks run, and any manual Windows verification. Mark macOS behavior untested unless you tested it on a Mac. Link the related issue when there is one. A maintainer reviews and merges the change.

If a bug or security report could expose private data or allow an untrusted installer to run, avoid posting exploit details or credentials publicly. Contact the maintainer through [GitHub](https://github.com/sahil-sharma-50) first.
