---
name: napkin
description: Use when the user asks for a napkin sketch, wireframe, mockup, or rough UI layout for a product feature they want to design — before any production HTML/CSS is written. Generates a hand-drawn HTML mockup, opens it in a local browser, and enters a live annotation loop where the user clicks elements to leave comments. Outputs a HTML file that has semantic Tailwind layout classes that will provide clear guidance to build agents. Do NOT use for code review of an existing page, design audits, screenshot comparisons, or generic UI conversation. If the goal is underspecified ("design something", "a UI"), ask one targeted clarifying question before generating.
---

# Napkin

Generates a semantic HTML mockup styled as a hand-drawn sketch, opens it in a local browser, and enters a live annotation loop — the user clicks any element to leave a comment, you read it and revise the mockup in-place.

This skill is **rigid**: follow the steps in order. The component vocabulary in Step 2 is the only one the kit recognizes — do not invent class names.

## Step 1 — Precondition checks

Run these in order. If a check fails, surface the fix command and stop. Do not auto-install.

**Runtime:**

```bash
bun --version 2>/dev/null || node --version 2>/dev/null
```

If neither exists: *"This skill needs `bun` (preferred) or `node`. Install bun with `curl -fsSL https://bun.sh/install | bash`, or install Node.js from https://nodejs.org."*

## Step 2 — Generate `proposal.html`

First, make the scratch dir uncommittable so it can never leak into the host project's git history: write `./.napkin-session/.gitignore` containing a single line `*`. (Creating this file also creates the dir.)

Then write the napkin to `./.napkin-session/proposal.html` using the skeleton and component vocabulary below. Do not deviate from the skeleton. Do not show raw HTML to the user — it is meant for the browser.

### File skeleton

`proposal.html` is the **LLM-readable deliverable**. Keep its `<head>` minimal: only the Tailwind CDN. The daemon injects the napkin kit (font, rough.js, `napkin-kit.css/js`) and the annotation overlay at serve time, so the page renders fully decorated in the browser without those tags ever touching disk.

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <script src="https://cdn.tailwindcss.com"></script>
  <script>tailwind.config = { corePlugins: { preflight: false } };</script>
</head>
<body class="p-8">
  <div class="max-w-4xl mx-auto">
    <!-- Your napkin here -->
  </div>
</body>
</html>
```

Do **not** add the kit's `<link>`/`<script>` tags to the head yourself — the daemon injects them. Adding them on disk would duplicate them when served and ship kit cruft to downstream LLMs that consume `proposal.html` directly.

### Components

Write **semantic HTML** for structure and components; use **Tailwind** for layout. The kit decorates semantic HTML with a hand-drawn look at runtime.

| Component | Write |
|---|---|
| Text input | `<input type="text">` |
| Number input | `<input type="number" value="5">` |
| Search field | `<input type="search" placeholder="Search">` |
| Date field | `<input type="date">` |
| Time field | `<input type="time">` |
| Date + time | `<input type="datetime-local">` |
| Select | `<select><option>...</option></select>` |
| Textarea | `<textarea></textarea>` |
| Checkbox | `<input type="checkbox">` |
| Radio | `<input type="radio" name="group">` |
| Toggle switch | `<input type="checkbox" role="switch">` |
| Button | `<button>Cancel</button>` |
| Primary button | `<button type="submit">Save</button>` |
| Danger button | `<button class="danger">Delete</button>` |
| Segmented control | `<div class="btnbar"><button aria-pressed="true">A</button><button>B</button></div>` |
| Tabs | `<nav><a href="#">Tab</a><a aria-current="page">Active</a></nav>` |
| Card | `<article>...</article>` (use `class="danger"` or `class="accent"` for variants) |
| Alert | `<aside role="alert">...</aside>` (add `class="warning\|danger\|success"`) |
| Tag | `<span class="tag">Active</span>` |
| List | `<ul><li>Item</li><li>Item</li></ul>` |
| Ruler / divider | `<hr>` |
| Accordion | `<details><summary>Title</summary>Body</details>` |
| Dialog | `<dialog open>...<footer>...</footer></dialog>` |
| Table | `<table><thead>...</thead><tbody>...</tbody></table>` |
| Popover | `<div popover id="x">...</div>` + `<button popovertarget="x">Info</button>` (click trigger to toggle; appears to the right of the trigger) |
| Image placeholder | `<img alt="Hero image">` (no `src`) |
| Video placeholder | `<video></video>` (no sources) |
| Chart placeholder | `<figure class="chart bar">Revenue</figure>` (`bar`, `line`, or `pie`) |
| Calendar | See below |

### Calendar structure

```html
<div class="calendar">
  <header>
    <button>‹</button>
    <strong>April 2026</strong>
    <button>›</button>
  </header>
  <ol>
    <li class="dow">Mo</li>
    <li class="dow">Tu</li>
    <!-- ...days of week... -->

    <li aria-hidden="true">30</li>  <!-- prev/next month cells -->
    <li>1</li>
    <li aria-selected="true">15</li>  <!-- chosen date -->
    <li aria-current="date">23</li>   <!-- today -->
  </ol>
</div>
```

### Icons, maps, shapes

The kit provides no icons or shapes. Use a small inline `<svg>` with simple strokes:

```html
<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5">
  <path d="M4 10h12M10 4v12" />
</svg>
```

Two or three strokes — not production icons.

### Rules

- Use Tailwind classes for layout (`grid`, `flex`, `gap-*`, `mb-*`, `max-w-*`)
- Use semantic HTML for structure (`<section>`, `<header>`, `<label>`, `<nav>`)
- Do **not** invent class names — the kit only recognizes: `danger`, `accent`, `warning`, `success`, `tag`, `btnbar`, `calendar`, `chart`, `bar`, `line`, `pie`, `dow`
- Use `aria-*` attributes for state (`aria-selected`, `aria-current`, `aria-pressed`, `aria-hidden`)
- For popovers in screenshots, call `window.napkinKit.openPopover('id')` before capture to simulate the open state

## Step 3 — Start the server

The paths below (`./bin/napkin`, `./.napkin-session`, etc.) are written **relative to this skill's install directory**, per the [Agent Skills standard](https://agentskills.io/specification). Your harness tells you where the skill lives:

- **Pi** wraps the SKILL.md with `<skill location="…">References are relative to …</skill>` — use that location.
- **Claude Code** announces `Base directory for this skill: …` when the skill loads.
- Other harnesses: check your platform's skill loading docs.

Resolve `./bin/napkin` to an absolute path before invoking — the bash CWD is the user's project, not the skill directory. Concretely:

```bash
SKILL_DIR="<absolute path your harness reported for this skill>"
SESSION_DIR="./.napkin-session"   # relative to user's project, not the skill
"$SKILL_DIR/bin/napkin" start "$SESSION_DIR"
```

The launcher prints one line on stdout then exits 0:

```
NAPKIN_READY http://127.0.0.1:PORT token=TOKEN
```

Parse `PORT` and `TOKEN` from that line. Store them — all subsequent API calls use them.

### 3b — Open the browser and begin the annotation loop

Open the browser with the URL from the `NAPKIN_READY` line (`http://127.0.0.1:PORT/?t=TOKEN`). Then **immediately** enter the annotation loop in Step 4 — do not pause, ask questions, or do any other work between opening the browser and starting the loop. The user is already looking at your napkin; they need you to be listening for annotations.

## Step 4 — Annotation loop

Each iteration of this loop is one round-trip: **wait → revise → signal done**. Repeat until the session ends. The session ends when the user closes the browser tab, clicks Stop, or any HTTP error makes the server unreachable — concretely, when the wait step returns 410, an unexpected status, or curl fails entirely.

### 4a — Wait for the next annotation

```bash
# Block up to 5 min waiting for one user annotation. Only 204 means "keep polling";
# every other outcome ends the inner loop one way or another.
SESSION_OVER=0
while true; do
  if ! RESPONSE=$(curl -s --connect-timeout 10 -m 310 -w $'\n%{http_code}' \
        -H "X-NK-Token: $TOKEN" \
        "http://127.0.0.1:$PORT/wait?timeout=300"); then
    SESSION_OVER=1; break                # curl exit nonzero → server gone or unreachable
  fi
  CODE=${RESPONSE##*$'\n'}               # last line = HTTP status
  BODY=${RESPONSE%$'\n'*}                # everything before it = JSON body
  case "$CODE" in
    200) break ;;                        # annotation in $BODY → revise
    204) continue ;;                     # server-side long-poll timeout → re-poll
    410) SESSION_OVER=1; break ;;        # session ended cleanly (browser closed / /stop)
    *)   SESSION_OVER=1; break ;;        # 000, empty, 4xx, 5xx — surface and exit, don't loop
  esac
done
```

If `SESSION_OVER=1` after this block, **skip 4b and 4c entirely and go to Step 5** — there is nothing to revise and no live server to notify. Otherwise, `$BODY` holds the annotation JSON; proceed to 4b.

> **Portability note:** `${VAR##*$'\n'}` / `${VAR%$'\n'*}` are POSIX bash parameter expansions and work on both macOS BSD and GNU shells. Do **not** use `head -n -1` here — BSD `head` rejects negative counts.

### 4b — Revise the HTML

The `$BODY` JSON contains everything you need — **do not fetch a screenshot**:
- `.comment` — user's comment text
- `.selector` — CSS selector of the annotated element (use this to locate the node in `proposal.html`)
- `.textSnippet` — element text preview
- `.rect` — `{x, y, w, h}` bounding rect

If you need more context, re-read `proposal.html` from disk. The selector + textSnippet + tag is deterministic — you do not need a screenshot to locate the element.

Edit `proposal.html` to apply the requested change.

### 4c — Loop back

Edits to `proposal.html` are automatically broadcast to the browser when the next `/wait` poll (step **4a**) begins. No separate signal is needed — loop back to **4a** for the next annotation.

### Error handling inside the loop

If any HTTP call returns a non-2xx status, surface a one-line diagnostic and continue — **do not** save the response body to a file with a misleading extension (e.g. `.png`), and do not re-Read it as an image. A failed request must not become attached image context.

## Step 5 — Pick the human-readable artifact, then shut down

When the loop ends, `proposal.html` on disk is the **LLM-readable deliverable** — minimal HTML, Tailwind only, no kit. That alone is enough for downstream agents.

**`proposal.html` is the absolute source of truth for UX.** The layout, component choices, sizing, hierarchy, and interaction patterns it defines are the definitive specification. Any agent building from this napkin must not deviate from these unless the user explicitly instructs otherwise. Never substitute, re-order, or reinterpret the napkin's structure when translating it into production code.

Ask the user which human-readable artifact(s) they want alongside it. PNGs and the standalone HTML are independent — the user can pick neither, either, or both. Use a multi-select question UI if one is available; otherwise ask in plain prose.

- **PNG screenshots** — full-page captures at multiple viewport widths
- **Standalone HTML with the kit** — single file that renders the same hand-drawn look in any browser (kit CSS/JS load from jsDelivr; needs network), minus the annotation UI

If the user picks neither, the LLM HTML (`proposal.html`) is the only artifact. That's the default.

### One-time AGENTS.md prompt

Runs once, on the first session that populates `./docs/human/`. **Skip silently** unless **all three** are true:

- the user picked at least one human artifact (PNG or bundled HTML), AND
- `./docs/human/` is missing or empty, AND
- `./AGENTS.md` is missing, or exists but doesn't already mention `docs/human`.

If all three hold, ask the user *once*, in plain prose (do not loop or re-ask):

> I'm about to create `docs/human/` for visual napkin artifacts. These are intended for human review only — agents reading them tend to anchor implementation choices on napkin-specific decoration rather than the cleaned `proposal.html` deliverable. Want me to add a one-line note to `AGENTS.md` telling agents to skip that directory? **One-time question — I won't ask again** (this prompt only fires when `docs/human/` is empty/missing).

On **yes**: append the following to `./AGENTS.md`, creating the file if it doesn't exist. Do not modify or reorder existing content.

```md

## Napkins

Do not read files in `docs/human/`. It holds napkin artifacts (PNGs, kit-decorated HTML) intended for human review only — reading them anchors implementation choices on napkin-specific decoration rather than the cleaned `proposal.html` deliverable.
```

On **no**: proceed without changes. Do not re-prompt; the trigger condition naturally stops being true once any artifact lands in `docs/human/`.

Whether to commit `docs/human/` to git is the user's call — do not touch `.gitignore` either way.

### Generate artifacts

Generate the chosen artifact(s) **before stopping the daemon** (PNGs need the live server). Both go to `./docs/human/` (relative to the user's project root). If the user picked both, run them sequentially — order doesn't matter.

- **PNGs:** use whichever HTML-to-image skill the user has available (e.g. a screenshot skill, a Playwright-based MCP tool, headless Chrome). Point it at the **live daemon URL** (`http://127.0.0.1:$PORT/?t=$TOKEN`), not `proposal.html` on disk — the daemon-rendered version has the kit injected; the disk version doesn't. Write output to `./docs/human/napkin.{sm,md,lg}.png` (small/medium/large viewport widths if the tool supports it; otherwise a single `./docs/human/napkin.png`). If no such skill is available, tell the user and skip the PNG artifact — the bundled HTML still covers the human-review need.
- **Bundled HTML:** run the export tool. It injects `<link>`/`<script>` tags pointing at the kit on jsDelivr (pinned to the skill's local git SHA, or `main` if the skill isn't a git checkout) and writes to `./docs/human/napkin.html` by default (override with a third arg).

```bash
"$SKILL_DIR/bin/napkin" export-human "$SESSION_DIR"
# or with a custom out path:
# "$SKILL_DIR/bin/napkin" export-human "$SESSION_DIR" "./somewhere-else.html"
```

`docs/human/` is intended to be **invisible to downstream agents** — the kit-decorated HTML and PNGs are anchoring artifacts that the user (a human) reviews, not material the next LLM should read. The one-time AGENTS.md prompt above is how that boundary gets set; no per-agent configuration required.

Then stop the server (uses the same `$SKILL_DIR` and `$SESSION_DIR` from Step 3):

```bash
"$SKILL_DIR/bin/napkin" stop "$SESSION_DIR"
```

The server also auto-shuts down 15 seconds after the user closes the browser tab.

### Handoff to downstream agents

Copy `proposal.html` to a suitable location in the user's project where spec artifacts live (e.g. `./specs/`, `./docs/`, or wherever the project convention places design specs). Use a descriptive filename so multiple napkins in the same project don't collide — derive it from the feature or page name (e.g. `napkin-signup.html`, `napkin-settings.html`). If no convention exists, place it at `./napkin-<feature>.html` in the project root and ask the user to confirm or relocate it.

When writing any plan, spec, or handoff for downstream agents:
- **Reference `proposal.html`** by its project path — not `.napkin-session/proposal.html`.
- **Never reference human artifacts.** Do not mention `docs/human/`, PNG screenshots, or the kit-decorated human HTML in any plan, spec, or agent instruction. These are human-review-only artifacts and will anchor downstream agents on decoration rather than structure.

## Verification before reporting complete

- `proposal.html` written to `.napkin-session/` using the Step 2 skeleton
- Server started; `PORT` + `TOKEN` parsed from the `NAPKIN_READY` line
- Browser opened and napkin rendered visually
- Every user annotation handled — each revised, then looped back for the next poll
- Server stopped cleanly
- `proposal.html` copied to an appropriate project location and referenced in the plan

## File layout

```
skills/napkin/
├── SKILL.md              ← this file
├── assets/
│   ├── napkin-kit.css
│   ├── napkin-kit.js
│   ├── annotate.css      ← served by daemon, injected into page
│   └── annotate.js       ← served by daemon, injected into page
├── server/
│   ├── serve.ts          ← daemon (Bun native; Node 22+ via --experimental-strip-types)
│   └── export-human.ts   ← bundle proposal.html + kit → napkin.html
└── bin/
    └── napkin            ← CLI: start / stop / export-human
```

## Related skills

- Any HTML-to-image skill the user has installed can be used in Step 5 to produce PNG artifacts of the finished napkin.
