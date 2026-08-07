# Design System: Practice Platform

## Direction

Dark, terminal/CI-adjacent developer tool. The user just deployed their own API (Render/Fly free tier) and is here to prove it works — submit URL, watch checks tick pass/fail like a CI run, read what broke, fix, resubmit. Not a consumer app, not a marketing-flavored SaaS dashboard.

**Foundation:** Near-black neutral (code-editor dark), not blue-black.
**Depth:** Borders-only. No shadows anywhere.
**Signal:** Pass/fail/pending (green/red/amber) is the real color language — not decoration, it's the product's actual output.
**Signature:** HTTP-method badges (GET/POST/PUT/PATCH/DELETE, colored per Swagger/Insomnia convention) + route + pass/fail pill on every check row — this audience already reads that color-to-method mapping daily in their own API tools.

## Tokens

- Spacing base: 4px (`--space-1` through `--space-7`: 4/8/12/16/24/32/48)
- Radius: `--radius-sm` 4px (controls/badges/pills), `--radius-md` 6px (panels/cards)
- Surfaces: `--bg-canvas` #0d0e10 → `--bg-surface` #17181b → `--bg-surface-2` #1f2023 (elevation, whisper-quiet steps); `--bg-inset` #0a0b0c (inputs, darker than canvas — "receives content")
- Borders: `--border-subtle` rgba(255,255,255,.06) → `--border-default` .1 → `--border-emphasis` .18
- Text: `--text-primary` #e8e9ea, `--text-secondary` #a7abb3, `--text-tertiary` #767b85, `--text-muted` #4d525c
- Signal: `--signal-pass` #3fb950, `--signal-fail` #f85149, `--signal-pending` #d29922 (each with a `-bg` rgba(...,.12) tint variant)
- Accent (single, restrained): `--accent` #58a6ff
- Method badges: GET #58a6ff, POST #3fb950, PUT #d29922, PATCH #bc8cff, DELETE #f85149 (each with a `-bg` rgba(...,.14) variant)
- Typography: `--font-body` = Inter (via `next/font/google`, CSS var `--font-sans`), `--font-data` = JetBrains Mono (`--font-mono`). Mono for everything technical (routes, scores, status, model names, IDs); sans for prose/UI chrome. The split itself is the typographic decision — not just "pick a readable font."

## Patterns

- **`.btn` / `.btn-primary`** — 36px height, 0 16px padding, `--radius-sm`, border always present (subtle default, accent-tinted for primary). No filled/solid buttons — everything is border + tinted background, matching borders-only depth.
- **`.panel`** — the one card treatment: `--bg-surface`, `--border-default`, `--radius-md`, 24px padding, flex column gap 16px. Used for forms.
- **`.field`** — flex column gap 8px; `.field-label` (12px, secondary text) is a **sibling** of the input, never a wrapper around it (wrapping broke layout — label+input need to be separate flex children).
- **`.pill`** (pass/fail/pending/neutral) and **`.badge-method`** (GET/POST/PUT/PATCH/DELETE) — 11px mono, 2px/8px padding, `--radius-sm`, tinted bg + colored border at .3 opacity. The check-row signature: `[method badge] [route in <code>] [description] [points] [pill]`.
- **`.check-list` / `.challenge-list`** — bordered container, rows separated by `--border-subtle`, last row's border removed. No zebra striping.
- **`.status-block`** — single-element state message (pending/timed-out/error) with the colored pulse dot as a CSS `::before` pseudo-element, never a separate DOM node. This matters beyond style: a real text node sitting alone inside an otherwise-empty wrapper element makes every ancestor up the tree match the same exact-text query, breaking `getByText`-style exact matching in tests. Keep single-message states as one flat element with no wrapping divs; use pseudo-elements for decoration, not sibling spans, when there's no other distinguishing content around the text.
- **`TopBar`** — lean, no sidebar (app is shallow, 4-5 screens). `> practice` wordmark (accent-colored prompt glyph) + `/ location` breadcrumb + right-aligned admin tag / username / logout. Breadcrumb location text must never exactly duplicate the page's own `<h1>` text (broke a test once via duplicate-text match) — use a slug/id or shortened form instead of the full title.

## Gotchas (React Testing Library + this token system)

- `getByText('exact string')` fails if the target text is split across **sibling elements** ("text is broken up by multiple elements") — e.g. `<span>Score:</span> <span>100</span>` inside one parent will NOT match `getByText('Score: 100')`. Keep single-string assertions targets as one flat text run (no nested spans around parts of it).
- A lone text node wrapped in otherwise-content-free ancestor `<div>`s makes every ancestor match the same exact-text query too (`getByText` throws "found multiple elements"). Don't wrap simple single-message states in extra layout divs; style the leaf element directly.
- Wrapping an `<input>` inside its own `<label>` while giving both the same visual container works fine functionally but breaks flex-column layout for label-above-input — keep label and input as separate siblings inside a `.field` wrapper, both explicit `htmlFor`/`id`.
- CSS attribute selectors like `input[type='text']` do **not** match an input with no `type` attribute at all (defaults to text behavior but has no matching attribute) — style `.field input` unqualified, or always set `type` explicitly.
