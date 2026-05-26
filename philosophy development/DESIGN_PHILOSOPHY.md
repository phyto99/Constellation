# Design Philosophy — Constellation Philosophy Documents

This document exists so a future instance of Claude can produce new philosophy/system HTML documents in exactly the right way. It covers visual language, writing voice, structural patterns, and the intellectual commitments that make these documents feel consistent and serious.

---

## The Core Aesthetic Commitment

**Black and white. Nothing else.**

The entire palette is:
- `#000` — black. Used for: strong borders, filled badges, hover states, inset left-bar, table header bottom borders, button hover backgrounds, dark cards.
- `#fff` — white. Used for: page background, nav background, button default, badge-inv text.
- `#111` — body text. Not pure black — avoids harshness.
- `#f0f0f0` — table header background, code block background.
- `#fafafa` — card background. One step off white.
- `#f8f8f8` — warn box background, detail panel background.
- `#eee` — bar track background, separator.
- `#ddd` — light separator color.
- `#ccc` — default card border, scrollbar thumb, light badge borders.
- `#888` — medium-weight secondary text, partial badge color.
- `#666` — tab default color, footnote text.
- `#555` — slider labels, subdued body text.
- `#333` — h4 color, secondary emphasis.

**The only exception ever allowed:** the generator terminal (`background:#000; color:#0f0`) — this is a deliberate console metaphor, not a color choice. Green on black signals "machine output" specifically.

No border-radius. Ever. Every corner is sharp. Softness is not part of this vocabulary.

No shadows except one specific case: `box-shadow: 2px 0px 4px rgba(0,0,0,0.3)` on score-row hover — and that's in the game UI, not the philosophy documents.

No imported fonts. Arial, sans-serif only. The system font is not a limitation — it is the point. These documents should feel like technical instruments, not branded products.

---

## Typography

Everything is small. Density is the aesthetic.

| Element | Size | Weight | Transform | Spacing |
|---|---|---|---|---|
| body | 12px | 400 | — | — |
| h2 (section heading) | 10px | 700 | uppercase | letter-spacing: 2px |
| h3 (sub-section) | 11px | 700 | uppercase | letter-spacing: 1px |
| h4 (card heading) | 10px | 700 | uppercase | letter-spacing: 1px |
| nav logo | 10px | 700 | uppercase | letter-spacing: 2px |
| tab | 10px | 400/700 (active) | uppercase | letter-spacing: 1px |
| table th | 9px | 700 | uppercase | letter-spacing: 1px |
| badge | 9px | 700 | uppercase | letter-spacing: 1px |
| footnote/asterisk | 9px | 400 | — | — |
| body text in cards | 11px | 400 | — | line-height: 1.7–1.8 |

h2 always has `border-bottom: 1px solid #000; padding-bottom: 5px; margin-bottom: 12px`.

Headings are section markers, not visual statements. They are small and compressed so content dominates.

---

## The Navigation

Sticky, white, `border-bottom: 2px solid #000`.

Logo on left, `border-right: 1px solid #ccc`, uppercase, `letter-spacing: 2px`. Tabs to its right.

Tabs: `border-bottom: 3px solid transparent` by default. Active: `border-bottom-color: #000; font-weight: 700; color: #000`. Inactive: `color: #666`. Hover: `color: #000`. Transition `.1s`.

Tab switching is always panel show/hide — `display:none` / `display:block`. No animations on panel transitions. Instant.

---

## Component Vocabulary

### Card
```css
border: 1px solid #ccc;
padding: 12px;
background: #fafafa;
```
The default container for content.

### Dark Card
```css
border: 1px solid #000;
padding: 12px;
background: #000;
color: #fff;
```
Used for: formulas displayed at prominence, terminal-style readouts. h4 inside must also be `color: #fff`.

### Warn Box (dashed border)
```css
background: #f8f8f8;
border: 1px dashed #000;
padding: 8px 10px;
font-size: 10px;
line-height: 1.7;
margin: 8px 0;
```
Used for: epistemics caveats, things the reader must not misread, important non-obvious warnings. Not for errors — for nuance.

### Inset (left bar)
```css
background: #f0f0f0;
border-left: 3px solid #000;
padding: 8px 10px;
font-size: 11px;
line-height: 1.7;
margin: 8px 0;
```
Used for: key axioms, formulas, definitions that anchor a section. The reader's eye goes here first.

### Badge
```css
display: inline-block;
padding: 1px 7px;
font-size: 9px;
letter-spacing: 1px;
text-transform: uppercase;
border: 1px solid #000;
font-weight: 700;
```
Default: white background, black border, black text.
`badge-inv`: `background: #000; color: #fff` — used for YES, COMPOSABLE, ALWAYS COMPOSABLE.
`badge-dim`: `border-color: #999; color: #999` — used for NO, disabled states.
`badge-warn`: `border: 1px dashed #000` — used for PARTIAL, conditional states.

### Table
```css
width: 100%;
border-collapse: collapse;
font-size: 11px;
```
`th`: 9px, uppercase, `letter-spacing: 1px`, `border-bottom: 2px solid #000`, `background: #f0f0f0`, left-aligned.
`td`: `padding: 4px 7px`, `border-bottom: 1px solid #e8e8e8`, `vertical-align: top`.
`tr:hover td`: `background: #f5f5f5`.

### Button
```css
background: #fff;
border: 1px solid #000;
color: #000;
padding: 4px 10px;
cursor: pointer;
font-size: 10px;
font-family: Arial, sans-serif;
font-weight: 700;
letter-spacing: 1px;
text-transform: uppercase;
```
Hover: `background: #000; color: #fff`. Active/selected: same as hover. No intermediate states.

### Invariant Card
```css
border: 1px solid #000;
padding: 10px 14px;
margin-bottom: 8px;
display: flex;
gap: 12px;
align-items: flex-start;
```
With an `inv-num`: `font-size: 28px; font-weight: 700; opacity: 0.15; flex-shrink: 0; line-height: 1`. The ghosted large number is decoration — it gives weight to the invariant without competing with the content. Use ① ② ③ (Unicode circled numbers).

### Bar Row
```html
<div class="bar-row">
  <div class="bar-lbl">Label</div>
  <div class="bar-track"><div class="bar-fill" style="width:65%"></div></div>
  <div class="bar-val">0.65</div>
</div>
```
Track: `height: 14px; background: #eee; border: 1px solid #ccc`. Fill: `background: #000`. Label: 80px wide, `font-size: 10px; color: #555`.

### Slider Row
```html
<div class="srow">
  <label>Label text</label>
  <input type="range" min="0" max="100" value="50" oninput="handler()">
  <div class="sval" id="val">50</div>
</div>
```
Label: 100–110px wide. Value display: 44–48px, right-aligned, `font-weight: 700`. `accent-color: #000`.

### Code Block
```css
background: #f0f0f0;
border: 1px solid #ccc;
padding: 12px;
font-family: 'Courier New', monospace;
font-size: 10px;
line-height: 1.7;
overflow-x: auto;
white-space: pre;
```

### Asterisk Footnote
```css
font-size: 9px;
color: #888;
line-height: 1.6;
margin-top: 6px;
```
Begins with `*`. Always at the bottom of the card it annotates. Used for: epistemics qualifications, "why this matters", edge case notices.

### Scrollbar
```css
::-webkit-scrollbar { width: 5px; height: 5px; }
::-webkit-scrollbar-track { background: #fff; }
::-webkit-scrollbar-thumb { background: #ccc; }
```
Always include. The native scrollbar is too thick and breaks the density.

---

## Grid Layouts

```css
.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.grid3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; }
.grid4 { display: grid; grid-template-columns: 1fr 1fr 1fr 1fr; gap: 10px; }
@media(max-width:760px) { .grid2,.grid3,.grid4 { grid-template-columns: 1fr; } }
```

All grids collapse to single column on mobile. No other breakpoints.

Left column: conceptual content — axioms, tables, definitions.
Right column: interactive simulation — sliders, charts, live-updating bars.

This left/right split is structural philosophy: the left is what the system believes, the right is what the system demonstrates.

---

## SVG Pipeline Diagrams

Used to show system architecture as a horizontal pipeline of nodes. Nodes are rectangles with labels. Clicking a node reveals a detail panel below the SVG.

Pattern:
- Draw in JavaScript: `document.getElementById('pipelineSvg').innerHTML = ...`
- Nodes: `rect` with `fill="#f0f0f0" stroke="#000" stroke-width="1.5"`, `rx="0"` (no radius)
- Arrows: horizontal lines with arrowhead markers. Black, 1.5px stroke.
- Labels: 9px, uppercase, letter-spacing 1.5
- Active node: `fill="#000"`, label color `#fff`
- Detail panel: `.pipe-detail` → `.pipe-detail.show` — `display:grid; grid-template-columns:1fr 1fr`

---

## The Terminal Block

Only used in the generator. Black background, green text. This is the one place color is allowed because it is a register shift — the machine is "speaking" instead of the document.

```css
background: #000;
color: #0f0;
font-family: 'Courier New', monospace;
font-size: 11px;
padding: 16px;
min-height: 280px;
border: 2px solid #000;
```

Lines appear progressively with `opacity: 0` → `opacity: 1` via a `transition: opacity .1s` class toggle. Each line has `margin-bottom: 3px`.

The codename display is large (`font-size: 28px; font-weight: 700; letter-spacing: 6px; color: #fff`) centered above the output grid.

---

## Writing Voice

This is where the documents live or die.

**State things absolutely.** Not "this approach tends to produce" but "this produces". Hedging is epistemic noise.

**Name the distinction before explaining it.** "A challenge is not a configuration. A configuration is the *output* of a challenge definition." Lead with the distinction. Then say why it matters.

**Use em dashes (—) for subordinate clauses.** Not parentheses, not commas, not semicolons. The em dash creates a rhythm that feels precise and deliberate.

**Italicize terms that are being formally defined or that carry technical weight.** *free axis*, *locked axis*, *mode-conditioned*. Not for emphasis — for precision.

**"No exceptions." as a standalone sentence.** When something is truly invariant, end with "No exceptions." on its own line. This is stronger than any amount of explanation.

**Numbered invariants with ① ② ③.** Not bullet points. Bullets imply a list. Numbers imply a system. The Unicode circled numbers (① ② ③ ④ ⑤ ⑥ ⑦) carry the right weight.

**Footnotes for epistemics.** The main content makes claims. The `*` asterisk footnote below a card hedges those claims appropriately — "brain metrics gate nothing on their own", "bot affinity is a proxy, not a measurement". Keep the main claim clean; qualify it in the footnote.

**Name what cannot be done, not just what can.** "The resolver is only allowed to touch free axes." "You cannot tell what the player learned." Constraints are as important as capabilities.

**The warn-box is for things the reader will get wrong.** It is not an error message. It is an epistemics guard. Use it before sections where a naive reading would produce false conclusions: "These modes are session configurations, not player trait labels."

---

## Philosophical Commitments

These are the intellectual foundations. New documents should be consistent with them or explicitly argue against them.

**Ground truth is rank among peers under identical configuration.** Not score. Not behavior. Not strategy. Rank. Peer-relative, same session, same config. Everything else is derived.

**Signals are mode-conditioned.** A steal-rate signal in DESTRUCTION mode means something completely different than in QUANTITY mode. Never compare signals across modes without normalization. Never assert a signal is meaningful without first declaring what mode was active when it was observed.

**Difficulty and cognitive target are orthogonal.** A harder version of a SPATIAL challenge is still SPATIAL. Scaling move count is a free axis. Changing which dimension is rewarded changes the cognitive target — that is a locked axis. Never conflate them.

**Epistemic humility about player traits.** "A player who scores well in SPATIAL mode is not a spatial thinker." Score rank is observable. Cognitive traits are inferred. The system measures the first. It does not claim the second without external validation.

**Zero-data validity.** The system must produce a well-designed session on day one for a player with no history. Uniform priors, coverage rotation, no overfitting. Budget 1 is philosophically complete. Higher budgets add precision, not correctness.

**Graceful degradation.** Fewer sessions → fewer active features, not wrong ones. The system should never activate an inference layer it does not have data to support. A system that tries to do too much on too little data is epistemically worse than one that does less correctly.

**Collaborative and competitive are different measurement systems.** Collaborative staircase sessions use target-delta, not rank. Elo is never updated from collaborative sessions. Never mix them.

**Signal purity as design constraint.** If two different strategies produce identical behavioral signals, the challenge is underspecified. The challenge design must actively prevent this. The template must declare what signals it generates and why those signals are valid under its constraints.

---

## What Not To Do

- No colors. A temptation will arise — resist it.
- No border-radius. Not even 2px. Everything is square.
- No gradient backgrounds except as explicit data visualization (the spectrum track).
- No font imports. No Google Fonts. Arial is correct.
- No shadows for decoration. Only functional shadows that indicate elevation (and even then, sparingly).
- No large headings. h2 is 10px. If the heading feels too small, it is correct.
- No friendly language. Not "Let's look at..." or "Here you can see...". State what it is. Let the user observe.
- No padding around invariants — the `.inv-num` ghost number is the breathing room.
- No bullet points where numbered invariants would work.
- No tooltips. If something needs explanation, it gets a footnote or a warn-box inline.
- No animations except: `transition: all .1s` on interactive elements, `transition: opacity .1s` on terminal lines, `transition: width .3s` on bar fills.

---

## The Spectrum Track Pattern

Used to show a zone from maximum to minimum, dark to light, as a physical dial.

```css
background: linear-gradient(90deg, #000 0%, #555 30%, #aaa 60%, #ddd 80%, #f0f0f0 100%);
border: 1px solid #000;
height: 48px;
```

Handle: `width: 6px; height: 56px; background: #fff; border: 2px solid #000; transform: translateX(-3px); transition: left .2s`. White on black gradient — maximum contrast.

Zones below the track: equal-width cells, uppercase labels, `border-right: 1px solid #ddd`.

---

## The Radar Chart Pattern

Canvas-based. Black on white. No color fills — use `rgba(0,0,0,0.1)` for the player's filled polygon, `stroke: #000` for the axes.

Axes radiate from center. Outer ring = best performance (lowest Elo number). Center = worst. Label each axis at the outer tip with the mode name in 9px uppercase.

Grid rings: light gray lines (`#ddd`) at regular intervals. No fill on grid.

---

## Document Structure Template

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>[System Name] — Constellation</title>
  <style>
    /* [Full CSS as above — do not abbreviate] */
  </style>
</head>
<body>
<nav>
  <span class="logo">[System Name]</span>
  <div class="tab active" onclick="showTab('first',this)">First</div>
  <!-- more tabs -->
</nav>

<div id="panel-first" class="panel active">
  <h2>[Section Title]</h2>
  <div class="warn-box"><!-- epistemics guard if needed --></div>
  <div class="grid2">
    <div><!-- left: definitions, axioms, tables --></div>
    <div><!-- right: simulation, sliders, live output --></div>
  </div>
</div>

<script>
function showTab(id, el) {
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.getElementById('panel-' + id).classList.add('active');
  el.classList.add('active');
}
// [All interactive logic here]
</script>
</body>
</html>
```

The script is always at the bottom. No external dependencies. No CDN. Everything is self-contained in one HTML file. This is not a constraint — it is a feature. The document must work by opening it, with no server, no build step, no network.

---

## Final Note

These documents are instruments, not presentations. They exist to make a complex system legible to someone who already needs to use it. The aesthetic choices — small type, no color, dense grids, absolute language — all serve this. They signal: this is not trying to impress you. It is trying to be correct.

A future instance generating a new document in this family should ask: does every element on the page earn its presence? If a card exists, what decision does it enable? If a table row exists, what confusion does it prevent? If a warn-box exists, what false reading does it stop?

The philosophy is compression without loss. Maximum signal, minimum surface area.
