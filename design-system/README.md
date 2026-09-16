# SATE Design System

The shared visual language for SATE tools. Use it so anything new — an internal dashboard,
a partner portal, a status page — looks like it came from the same company as the clinical
web app.

```
tokens.json           the single source of truth (colours, type, radius, shadow, space)
sate.css              drop-in stylesheet, no build step        → plain HTML, Workers, docs
tailwind.preset.js    Tailwind preset                          → React apps
index.html            living reference — every component, rendered
verify.mjs            drift checker, runnable in CI
```

**First adopter:** `../sate-devapi` (the developer portal). It passes `verify.mjs` clean and
pins the load-bearing tokens in its test suite, so it is a working example of consuming this.

## Use it

**Plain HTML / a Worker that serves its own CSS:**

```html
<link rel="stylesheet" href="sate.css">
<body class="sate">
  <header class="sate-header">
    <div class="sate-header__inner">
      <div class="sate-wordmark">SATE<span>Your tool name</span></div>
      <nav class="sate-tabs">
        <button aria-current="true">Overview</button>
        <button>Settings</button>
      </nav>
    </div>
  </header>
  <main class="sate-main">
    <div class="sate-card">…</div>
  </main>
</body>
```

**React + Tailwind:**

```js
// tailwind.config.js
import sate from '../design-system/tailwind.preset.js';
export default { presets: [sate], content: ['./index.html', './src/**/*.{ts,tsx}'] };
```

You keep writing `bg-white border-gray-200 rounded-lg shadow-sm` — the preset just makes
those resolve to audited values, and adds named aliases (`bg-sate-primary`,
`text-sate-muted`) for new code that wants to state intent.

**Check for drift:**

```bash
node verify.mjs ../sate-devapi/src        # report near-miss colours
node verify.mjs ../my-project/src --ci    # exit 1 on any — wire into CI
```

## Measured, not declared

Every token was taken from what the app **renders**, not from what its config **claims** —
185 files scanned, occurrences counted. Where the two disagreed, the rendered value won.

| | Config says | App actually uses | Canonical |
|---|---|---|---|
| Primary | `#3a86ff` (tailwind), `#5d6cfa` (index.css) | `blue-600` — 174 uses | **`#2563eb`** |
| Muted text | — | `gray-600` — 294 uses | **`#4b5563`** |
| Card shadow | `shadow-card` — 1 use | `shadow-sm` — 102 uses | **`0 1px 2px 0 rgba(0,0,0,.05)`** |
| Radius | `lg: 0.5rem` | `rounded-lg` — 274 uses | **`8px`** |

The two declared primaries are effectively dead: `#3a86ff` has 5 uses, `#5d6cfa` has 1.
Anyone reading `tailwind.config.js` to learn the brand colour would get the wrong answer.
That is why this file exists.

## Two bugs the audit found

**1. The type scale does not work.** `tailwind.config.js` maps every `fontSize` utility to
`var(--text-xs)`, `var(--text-sm)` … and **nothing anywhere defines those variables**. The
built CSS contains:

```css
.text-sm { font-size: var(--text-sm); line-height: 1.25rem }
```

An undefined custom property makes the declaration invalid, so it is dropped: `.text-sm`,
`.text-2xl` and friends **change no font size at all** — only line-height applies. Every
size difference you currently see comes from something else. Two fixes, either works:

- load `sate.css` (it defines `--text-*` with the intended values), or
- adopt `tailwind.preset.js`, which uses literal rem values.

**2. Three primaries.** See the table above. Pick `#2563eb` and delete the other two from
the config so the next person cannot pick wrong.

Neither is urgent, and I have **not changed the web app** — both are reported, not fixed,
because the app is not what you asked me to touch.

## The rules

**Colour carries meaning; never decorate with it.** The annotation palette (pause blue,
filler amber, morpheme green …) is clinical vocabulary. A pause is that blue on every
surface in every tool, forever. Never reassign one, and never reach for one because it
looks nice.

**Always pair a colour with a label.** A legend swatch needs its word next to it. Roughly 1
in 12 men has a colour-vision deficiency, and this product is read by clinicians making
judgements.

**Blue is for action.** Primary blue means *you can do something here* — the button, the
active tab, the link. A blue that does nothing trains people to ignore it.

**One elevation by default.** `shadow-sm` on cards. `shadow-lg` for things that float over
the page (popover, toast), `shadow-modal` for modals. Nothing else.

**8px radius unless it is a pill.** `rounded-lg` is the default for cards, buttons, inputs.
`rounded-full` for pills and avatars. Mixing radii in one view looks accidental.

**Reach for `--sate-muted` (gray-600) for secondary text**, not gray-500. It is the app's
most-used text colour and clears 4.5:1 contrast on white; gray-400 does not, so keep that
for disabled states only.

**Wide content scrolls in its own box.** Wrap tables in `.sate-tablewrap`. The page body
must never scroll sideways.

**Keep motion almost absent.** Hover and focus transitions at 120ms. The app animates
essentially nothing, and a dashboard that moves is a dashboard that distracts.

## Components in `sate.css`

`sate-header` · `sate-wordmark` · `sate-main` · `sate-tabs` · `sate-card` · `sate-grid` ·
`sate-stat` · `sate-btn` (`--secondary` `--danger` `--ghost` `--sm` `--lg`) · `sate-input`
`sate-select` `sate-textarea` `sate-label` `sate-help` `sate-error` · `sate-choices` ·
`sate-table` (`--striped`) · `sate-tablewrap` · `sate-pill` (`--info` `--success`
`--warning` `--danger`) · `sate-banner` (same modifiers) · `sate-ann--<type>` ·
`sate-swatch` · `sate-pre` `sate-code` · `sate-toast`

Open `index.html` to see all of them rendered.

## Changing a token

1. Edit `tokens.json`. It carries the note explaining *why* each value is what it is — keep
   that current, it is the part that stops the next debate.
2. Mirror into `sate.css` and `tailwind.preset.js`.
3. Run `verify.mjs` against every consuming project.
4. Bump `version` in `tokens.json`.

Do not add a token because one screen needs one colour. Add it when a second screen needs
the same colour, and name it for what it *means*, not what it looks like.
