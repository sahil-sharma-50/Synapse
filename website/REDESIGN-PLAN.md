# Synapse website redesign

Status: spacing correction implemented; three visual compositions prepared for user selection.

## Outcome

Help a Windows power user recognize a useful desktop tool, see a real task completed, and try the current public build. Keep the future paid edition visible with honest one-time purchase terms and a launch waitlist. Price, exact paid features and release date remain unannounced.

## Layout correction

Use one shared 1040px maximum content width. Side gutters follow `clamp(24px, 7vw, 112px)`; centering adds more space on large displays. Breakpoints must never reset this to near-full-width. At 1440px the content has 200px margins; at 1050px roughly 74px; at 768px roughly 54px; at 390px roughly 27px. Text, navigation, previews, pricing and footer align to that system. Long paragraphs stay below 65–75 characters per line.

## Visual direction

Keep the confirmed light website. Use white and pale-blue surfaces, dark slate application previews, cobalt actions, and a restrained mint active state. Preserve the Synapse app mark. Keep the hero around 42–44px, section titles around 28–32px, main explanatory text 16px, and ordinary metadata at least 12px. Use technical precision in actual keycaps, tool geometry, data boundaries and transitions rather than invented telemetry or decorative code.

The UI/UX Pro Max database supports an interactive product demo and bounded text widths. Its broad Aurora/Inter suggestion is not the selected style: the user's earlier rejection of abstract decoration and generic presentation takes precedence.

## Composition options

- **First image: split hero** — recommended. Copy and download action on the left; a contained composition of wheel, email example, note and clipboard on the right. A three-step shortcut explanation follows. Reference: `.impeccable/mocks/split-hero.png`.
- **Second image: guided workflow** — task choices beside one app canvas with Open / Dictate / Insert controls. Strongest emphasis on learning by doing. Reference: `.impeccable/mocks/guided-workflow.png`.
- **Third image: centered demo** — compact centered copy above a wide, contained desktop demonstration. Reference: `.impeccable/mocks/centered-demo.png`.

These are generated composition references, not approved screenshots of the app. Their invented logos, third-party email branding, inaccurate menu sectors and any unsupported copy will not be implemented. Exact app icon paths, eight-sector order, selected tool behavior and true feature claims come from the repository.

## Page sequence

1. Compact navigation: Product, How it works, Pricing, Docs; primary action to try the current Windows build.
2. Hero: practical value proposition, Windows/setup context, download action and a visible demo action.
3. Interactive walkthrough: open the wheel, choose a tool, see the result. Samples are clearly labeled.
4. Concrete workflows: local dictation, BYOK AI, searchable clipboard and notes. Each shows useful output beside concise explanation.
5. Technical trust: what runs locally, what goes to providers, credential storage and optional model requirements.
6. Real product evidence: the existing settings screenshot and customization choices.
7. Planned paid edition: one-time major-version purchase, optional future upgrades and separate provider charges. Current build remains accessible.
8. Short FAQ and paid-launch updates.

Getting Started, Privacy and 404 inherit margins, typography, colors and navigation. No checkout or invented pricing is added.

## Graphics and interactions

| Element                            | Implementation                                                                                        |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Radial menu                        | Existing app SVG paths and order, keyboard-accessible native buttons                                  |
| Email, note and clipboard examples | Responsive HTML with labeled sample content                                                           |
| Live workflow                      | User-triggered sequence, selection feedback, replay and cancellation                                  |
| Technical processing path          | Crisp vector diagram with accurate local/cloud labels                                                 |
| Product evidence                   | Real repository screenshots                                                                           |
| Generated imagery                  | Only isolated visual material the selected composition actually needs; no rasterized text or controls |

Use 180–300ms selection and panel transitions. A guided sequence can run longer only after explicit Play, with replay/pause controls and a visible final state. Keep geometry stable while text changes. Reduced motion shows final states immediately. Avoid endless ambient animation, automatic cycling, scroll hijacking, parallax and oversized entrances.

## Build and verification

- Reuse static HTML/CSS/JS and the existing build; no framework migration.
- Keep the existing waitlist configuration boundary and disabled preview signup.
- Update shared tokens, header and page structure together after the visual choice.
- Retain working wheel, workflow, search, FAQ and keyboard behaviors.
- Test four routes at 320, 390, 768, 1050 and 1440px; explicitly assert gutters and the 1040px width ceiling.
- Test mouse/touch/keyboard selection, replay cancellation, search empty state, reduced motion, no-JavaScript fallback and zero horizontal overflow.
- Inspect desktop and mobile against the selected composition in a bounded pass, fix material findings, then finish review and update website design documentation.

## Still needed for public launch

Owner-provided MailerLite export and hosted form URL, production domain, and public contact email. Live email delivery and subscription flow require verification with the configured provider.

# Historical design plan

Superseded by the user-approved dark-and-white implementation in `DESIGN.md` and the GitHub Pages deployment documented in `README.md`.
