# Synapse website

The approved Synapse landing page, setup guide, privacy page, and 404. Static HTML/CSS/JavaScript with a dependency-free Node 22 build. The site uses dark and white surfaces with restrained dark blue, real repository screenshots, and the app's wheel geometry and icons.

## Preview and checks

From the repository root:

```powershell
node website/build.mjs
python -m http.server 4173 --bind 127.0.0.1 --directory website/dist
node --test website/test.mjs
```

Open http://127.0.0.1:4173/. With the server running:

```powershell
npx --yes --package @playwright/cli playwright-cli -s=synapse-site open http://127.0.0.1:4173/
npx --yes --package @playwright/cli playwright-cli -s=synapse-site run-code --filename=website/browser-check.js
```

The browser check covers four routes at five widths, the navigation's inset/expanded/returned states, all eight tool guides, keyboard FAQs, focus restoration, screenshot zoom, and reduced motion. Screenshots go to ignored `output/playwright/`.

## Publishing

Source is on the dedicated `website` branch of the Synapse repository. `.github/workflows/pages.yml` runs the tests, builds an artifact, and deploys GitHub Pages when website files change on that branch. It does not deploy desktop app changes.

Public URL: https://sahil-sharma-50.github.io/Synapse/

The workflow sets `SITE_MODE=production` and `SITE_URL=https://sahil-sharma-50.github.io/Synapse/`. The builder prefixes local links and metadata for the project path. Production requires a valid HTTPS site URL. Use a fresh output directory for publishing; the workflow uses a clean checkout and `_site`.

Preview builds stay noindex. If historical alternatives exist in the local checkout, preview builds include them under `/designs/`; they are excluded from the published source and artifact. The approved page is `src/index.html`; shared styles, scrolling behavior, and wheel guide live in `src/styles.css`, `src/site.js`, and `src/product-tour.*`. Supporting pages share its header, footer, fonts, and palette through the build.

The site has no signup, checkout, account, analytics, or desktop integration. Download buttons open the official GitHub release. Paid licensing details remain an FAQ, with no invented price or launch date. Published asset provenance is recorded in `src/assets/PROVENANCE.md`.
