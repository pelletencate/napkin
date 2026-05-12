# Wireframe

A skill that turns any agent into a hand-drawn wireframing partner — generates a sketch in the browser, then enters a live annotation loop where you click elements to leave comments and the agent revises in place.

The deliverable on disk is plain semantic HTML + Tailwind. The hand-drawn look and the annotation overlay are injected by a local daemon at serve time, so downstream agents that consume the file see clean structural markup, not wireframe decoration.

## Why this is cool

Apart from the fact that you can talk to your agent by clicking in the browser, the other thing that's cool is that this is just a .md file and a script. Yes, it requires your agent to poll it and wait for a response, but on Claude Code, this works beautifully.

So, no agent-specific extensions, no hooks, no plugin API, no SDK, no "tool use" schema, no framework integration. The skill works with any planning mode that allows you to tell the agent that you want a wireframe. (The agent does need to write to .wireframe-session/ so make sure it can do that). The skill works on any agent that supports skills, can run a shell command and edit a file — which is, essentially, all of them.

Now, I don't know if this is a virtue. You can probably build a much more robust version of this project when you do use all of those things, and maybe someday I will.

## How a session looks

1. You ask your agent for a wireframe of some screen.
2. It writes `./.wireframe-session/proposal.html`, starts a local daemon, and a browser tab pops open with the sketch.
3. Click any element — input, card, button, table row — and a panel appears next to it. Type a comment, hit submit. A blue dot pins the spot.
4. The agent reads your annotation, edits the HTML, and the page morphs in place. The dot stays attached to the element it was pinned to. You keep clicking and commenting.
5. Close the tab (or hit Stop) when the design feels right. The agent optionally generates PNGs and a self-contained kit-decorated HTML for human review.

## Install

Drop the directory into your agent's skills folder. For Claude Code:

```bash
git clone https://github.com/<you>/wireframe ~/.claude/skills/wireframe
```

For other agents that use the standard skill format (frontmatter + `SKILL.md`), follow your agent's installation convention — the skill is self-contained.

## Requirements

- **Runtime**: [Bun](https://bun.sh) (preferred) or Node.js 22+ (uses `--experimental-strip-types` for TypeScript). The skill detects which is present.
- **Browser**: anything modern. The annotation overlay uses Shadow DOM, native popovers, and standard fetch/WebSocket.
- **OS**: macOS, Linux, Windows. The daemon binds to `127.0.0.1` only.

No npm install, no `package.json` — the daemon uses only Node/Bun built-ins. Rough.js and Tailwind load from CDN at view time.

## Usage

Once installed, invoke the skill from your agent: *"wireframe a settings screen with two tabs and a danger zone"*, *"sketch a checkout flow"*, etc. The skill description tells the agent when to fire — for explicit wireframe / mockup / sketch requests, before any production code.

Direct CLI access (for debugging or scripting):

```bash
bin/wireframe serve ./.wireframe-session
# → WIREFRAME_READY http://127.0.0.1:54321/?t=…

bin/wireframe connect ./.wireframe-session
# blocks for one annotation; prints the JSON on stdout;
# exit 0 (annotation), 1 (session ended), 2 (server error)

bin/wireframe export-human ./.wireframe-session [out.html]
bin/wireframe stop ./.wireframe-session
```

## How it works

```
proposal.html (on disk)            ← LLM-readable, Tailwind only
        │
        ▼ daemon injects kit + overlay at serve time
http://127.0.0.1:PORT/?t=TOKEN     ← decorated, interactive
        │
   ┌────┴─────────┐
   │              │
WebSocket      HTTP long-poll
   │              │
   ▼              ▼
browser ──annotation──▶ agent (via GET /wait)
agent edits proposal.html, calls /wait again
server pushes morph on WS ──▶ browser idiomorphs in place
```

- **`server/serve.ts`** — daemon. Self-forks: launcher prints `WIREFRAME_READY`, child runs HTTP/WS. Works on Bun (native `Bun.serve`) and Node (raw RFC 6455 WebSocket, zero deps).
- **`assets/wireframe-kit.{js,css}`** — decorates semantic HTML with hand-drawn Rough.js overlays. Maps `<input type="search">` to a sketchy field with a magnifier icon, `<dialog open>` to a roughed modal, `figure.chart.bar` to a bar chart, etc.
- **`assets/annotate.{js,css}`** — annotation overlay. Lives in a Shadow DOM so kit styles can't leak in. Bundles a minimal in-place DOM morpher so revisions don't full-reload.
- **`server/export-human.ts`** — bundles `proposal.html` + the kit into a single self-contained HTML file for human review (no annotation UI).

## Component vocabulary

The kit recognises a fixed set of selectors. Inside `proposal.html` you write semantic HTML:

| Want                | Write                                                               |
|---------------------|---------------------------------------------------------------------|
| Text input          | `<input type="text">`                                               |
| Search field        | `<input type="search">`                                             |
| Date / time / both  | `<input type="date">` / `time` / `datetime-local`                   |
| Toggle switch       | `<input type="checkbox" role="switch">`                             |
| Primary button      | `<button type="submit">Save</button>`                               |
| Danger button       | `<button class="danger">Delete</button>`                            |
| Segmented control   | `<div class="btnbar"><button aria-pressed="true">A</button>…</div>` |
| Tabs                | `<nav><a aria-current="page">Active</a><a>Other</a></nav>`          |
| Card                | `<article>…</article>` (`class="danger\|accent"` for variants)      |
| Alert               | `<aside role="alert">…</aside>`                                     |
| Tag                 | `<span class="tag">Active</span>`                                   |
| Accordion           | `<details><summary>…</summary>…</details>`                          |
| Dialog              | `<dialog open>…<footer>…</footer></dialog>`                         |
| Image / video       | `<img alt="…">` / `<video></video>` (no `src`)                      |
| Chart               | `<figure class="chart bar">Revenue</figure>` (`bar`/`line`/`pie`)   |
| Popover             | `<div popover id="x">…</div>` + `<button popovertarget="x">`        |
| Calendar            | see `SKILL.md` for the `<ol>`-based grid                            |

Use Tailwind classes (`grid`, `flex`, `gap-*`, `max-w-*`) for layout, `aria-*` attributes for state. Don't invent class names — the kit only knows the ones above.

## Agent compatibility

The skill is designed to be agent-agnostic. The hard requirements are: a shell tool (for `curl` and the launcher script), file read/write, and the ability to ask the user a multi-select question (or fall back to plain prose).

| Agent              | Status     | Notes |
|--------------------|------------|-------|
| Claude Code        | Tested     | Uses `AskUserQuestion` for the artifact picker; the `Skill` tool announces the install path on load |
| Pi                 | Compatible | Pi's harness wraps each skill with `<skill location="…">References are relative to …</skill>`, which is exactly what Step 3 needs |
| Other skill-aware agents | Should work | The skill loader needs to surface the install directory to the agent — see `SKILL.md` Step 3 |

Anything Claude-Code-specific (the `AskUserQuestion` UI, slash commands) is gated behind "if available; otherwise ask in plain prose".

## File layout

```
wireframe/
├── SKILL.md              ← agent-facing instructions
├── README.md             ← this file
├── assets/
│   ├── wireframe-kit.css ← hand-drawn styles
│   ├── wireframe-kit.js  ← Rough.js decoration
│   ├── annotate.css      ← overlay UI (Shadow DOM)
│   └── annotate.js       ← overlay UI + morph client
├── server/
│   ├── serve.ts          ← daemon (Bun + Node)
│   └── export-human.ts   ← bundle proposal.html + kit
└── bin/
    └── wireframe         ← CLI: serve / connect / stop / export-human
```

## Caveats

- The session daemon binds to `127.0.0.1` only and is gated by a per-session 16-byte random token. Do not expose to other hosts.
- `proposal.html` is the LLM deliverable. The kit-decorated HTML and PNGs that land in `./docs/human/` are anchoring artifacts intended for humans — letting downstream agents read them tends to bake wireframe-specific decoration into production code. The skill offers to add a one-line note to `AGENTS.md` the first time it populates `docs/human/`.
- Tailwind loads from the [Play CDN](https://tailwindcss.com/docs/installation/play-cdn) — fine for wireframes, not for production. Downstream code generation is expected to swap in a proper build.

## License

MIT.
