# Website assets

- `synapse-overview.png`, `customization_options.png`, and `usuage_stats.png`: unchanged copies of the existing repository product captures in root `assets/`. Used by all three HTML alternatives; the usage figures are historical examples, not pricing or a provider invoice. The build also copies these originals. `synapse-icon.png` is an unchanged copy of `synapse/src/assets/synapse.png`. Source copies allow direct HTML previews without a build.

- `manrope.woff2` and `literata.woff2`: unmodified Latin variable fonts served by Google Fonts, downloaded October 9, 2026. SIL Open Font Licenses in `Manrope-LICENSE.txt` and `Literata-LICENSE.txt`; source projects in https://github.com/google/fonts/tree/main/ofl/manrope and https://github.com/google/fonts/tree/main/ofl/literata.
- `afterglow.png` and `daydream.png`: original ChatGPT-generated concept artwork for the HTML design alternatives, October 9, 2026. The landscape is brand imagery; the companion is a website illustration. Neither depicts a shipped app feature or a product screenshot.

- `source-sans-3.woff2`: Adobe Source Sans 3 upright variable font from https://github.com/adobe-fonts/source-sans/tree/release/WOFF2/VF. Unmodified, downloaded October 9, 2026; SIL Open Font License in `SourceSans-LICENSE.md`.
- The interactive wheel uses the existing app’s eight icon paths and radial geometry from `synapse/src/wedges.ts`. Other diagrams are semantic HTML and crisp SVG geometry, with illustrative sample content labeled in the interface.
- SVG icons: unmodified Tabler outline icons from https://github.com/tabler/tabler-icons/tree/main/icons/outline, downloaded October 9, 2026. MIT license in `Tabler-LICENSE.txt`.
- Product screenshots and icon are copied by the build from existing repository assets. No external image CDN, remote font request or runtime dependency is required.
