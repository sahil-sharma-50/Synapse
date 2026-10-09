# Synapse website design

The user selected the Cobalt layout and approved its compact typography, wheel preview, real product screenshots, and FAQs. The final palette is dark and white with occasional dark blue. This replaces the earlier light workbench direction.

Mode: Persuade. Help Windows users understand Synapse and download the current public release.

- Surfaces: near-black `#111214`, white `#f5f5f5`, muted neutral text `#b9b9bd`, and restrained dark blue `#18253f` around the hero wheel. No bright blue, sky blue, gold, or yellow interface accents. Product screenshots retain their original colors.
- Type: self-hosted Manrope. Body 14px; supporting text 12–13px; display 32–44px; section headings 26–32px. Keep readable line spacing and compact controls.
- Content width: 1120px maximum, with at least 24px side clearance and proportional larger gutters.
- Navigation: inset white rounded bar at the top (22px desktop / 16px mobile offset). After 24px of scrolling, it expands to a full-width dark bar attached to the top. Returning to the top restores the inset bar. Content remains within the same gutters.
- Hero: source-based eight-sector wheel; clicking it opens the full-screen feature guide. No fabricated app screenshot.
- Screenshots: unchanged repository captures. Appearance and usage text sits left, images right; mobile stacks copy before images. Images can be enlarged.
- FAQ: native keyboard-accessible disclosures for local processing, provider/API billing, and planned licensing.
- Motion: subtle screenshot entrance on scroll, nav transition, and hover feedback. Content stays visible without animation; reduced-motion preference disables motion.
- Accessibility: native dialogs with Escape and focus restoration, visible focus on dark and light surfaces, skip link, semantic headings, descriptive image alternatives, and no horizontal overflow at 320px.
- Product truth: manual dictation finish, local model setup, paste back into the previous app, monitor screenshot capture, and Force Quit exiting Synapse itself. The guide explains behavior without performing desktop actions.

The setup guide, privacy page, and 404 share the production site's shell. GitHub Pages hosts the website. No account, waitlist, checkout, or tracking service is part of this release.
