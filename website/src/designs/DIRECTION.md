# Synapse design exploration

Three HTML alternatives combine the parts selected by the user: the rounded header from their second screenshot, the headline and two actions from their first screenshot, and the blurred wheel overlay from their third screenshot. Screenshot content takes precedence over the mismatched concept names in the request. Existing filenames remain stable; no main-site identity has been selected.

- **Dusk** (`midnight.html`): dark ink and apricot, compact typography, a prominent wheel, and full-width product captures within the content gutter.
- **Cobalt** (`carbon.html`): selected by the user for refinement. Cobalt blue, near-black, sky blue, and white; a compact full-width fixed header; a clickable source-based hero wheel; real screenshots to the right of appearance and usage copy; three native FAQs; and restrained screenshot reveals that respect reduced motion. No gold or yellow accents. This is the single approval candidate; other concepts remain archived alternatives.
- **Lilac** (`plum.html`): warm lilac and peach, an arched wheel composition, and alternating screenshot sections.

All three share the source-based eight-sector wheel guide and a native screenshot dialog. Wheel geometry and icon paths come from `synapse/src/wedges.ts`; product captures are unchanged copies of the existing repository assets. No generated or invented app windows are used. Background artwork is conceptual brand imagery only.

The guide explains actual behavior instead of simulating desktop actions: dictation finishes on Enter or a click, transcribes locally after model setup, and pastes into the previous app; screenshots capture the monitor under the cursor; Force Quit exits Synapse itself. Every tool has a three-step explanation. The pages show the real wheel, Wheel & color settings, and usage screen, with captions and click-to-enlarge viewing. Usage figures are local estimates, not subscription prices.

Main content stays within 1120px with at least 24px side clearance. Headline size is capped at 48px. Preserve keyboard access, native Escape/focus restoration, reduced motion, accurate Windows support, and the distinction between the public build and planned paid edition. No invented pricing, customer metrics, checkout, or launch date.

Earlier inspiration came from [Donit](https://sahil-sharma-50.github.io/donit/) and OpenAI launch pages. The latest user-selected visual references supersede earlier mascot, sample-note, and simulated clipboard directions.
