/* =============================================================
 * wireframe-kit.js
 *
 * Decorates semantic HTML with hand-drawn SVG overlays via Rough.js.
 *
 *   <script src="https://cdn.jsdelivr.net/npm/roughjs@4.6.6/bundled/rough.js"></script>
 *   <script src="wireframe-kit.js"></script>
 *
 * Exposes:
 *   window.wireframeKit.render()   — redraw all decorations
 *   window.__wireframeReady        — true after first render
 *
 * Architecture:
 *   - Four generic shape drawers: rect, pill, circle, line.
 *   - A SPECS table maps CSS selectors to {shape, ...options}.
 *   - Compound drawers for components with internal structure
 *     (buttons, toggle, checkbox/radio, calendar days, tabs,
 *     button bar, image/video/chart placeholders, search, date/time,
 *     tooltip, popover, ruler).
 *   - An icons() helper draws small glyphs (magnifier, clock, etc.).
 * ============================================================= */

(() => {
  if (typeof rough === 'undefined') {
    console.error('[wireframe-kit] Rough.js is not loaded. Add its <script> before wireframe-kit.js.');
    return;
  }

  /* ---------- Palette ---------- */
  const INK     = '#1f1f1f';
  const BG      = '#fdfdfb';
  const DANGER  = '#b91c1c';
  const SUCCESS = '#15803d';
  const WARNING = '#b45309';
  const INFO    = '#1d4ed8';
  const MUTED   = '#e5e7eb';
  const ACCENT  = '#2563eb';

  const SVG_NS = 'http://www.w3.org/2000/svg';

  /* ---------- Utilities ---------- */

  const seedFor = (el, k = '') => {
    const key = '__wfSeed_' + k;
    if (!el[key]) el[key] = (Math.random() * 2 ** 31) | 0;
    return el[key];
  };

  function freshSvg(parent, className, w, h) {
    let svg = parent.querySelector(`:scope > svg.${className}`);
    if (!svg) {
      svg = document.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('class', className);
    }
    if (parent.firstChild !== svg) parent.insertBefore(svg, parent.firstChild);
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    return svg;
  }

  function pillPath(w, h) {
    const r = h / 2 - 1;
    return `M ${r + 1},1 L ${w - r - 1},1 A ${r},${r} 0 0,1 ${w - r - 1},${h - 1} ` +
           `L ${r + 1},${h - 1} A ${r},${r} 0 0,1 ${r + 1},1 Z`;
  }

  const resolve = (opt, el) => (typeof opt === 'function' ? opt(el) : opt);

  function roughOpts(spec, el, seedKey = '') {
    const o = {
      stroke:      resolve(spec.stroke, el) ?? INK,
      strokeWidth: resolve(spec.strokeWidth, el) ?? 1.5,
      roughness:   resolve(spec.roughness, el) ?? 1.8,
      bowing:      resolve(spec.bowing, el) ?? 1.5,
      seed:        seedFor(el, seedKey),
    };
    const fill = resolve(spec.fill, el);
    if (fill) {
      o.fill = fill;
      o.fillStyle = resolve(spec.fillStyle, el) ?? 'solid';
    }
    return o;
  }

  /* ---------- Generic shape drawers ---------- */

  function drawRect(el, spec) {
    const { width: w, height: h } = el.getBoundingClientRect();
    if (w < 2 || h < 2) return;
    const svg = freshSvg(el, spec.svgClass || 'wf-bg', w, h);
    const rc = rough.svg(svg);
    const inset = spec.inset ?? 2;
    svg.appendChild(rc.rectangle(
      inset, inset, w - inset * 2, h - inset * 2,
      roughOpts(spec, el)
    ));
  }

  function drawPill(el, spec) {
    const { width: w, height: h } = el.getBoundingClientRect();
    if (w < 2 || h < 2) return;
    const svg = freshSvg(el, spec.svgClass || 'wf-bg', w, h);
    const rc = rough.svg(svg);
    svg.appendChild(rc.path(pillPath(w, h), roughOpts(spec, el)));
  }

  function drawCircle(el, spec) {
    const { width: w, height: h } = el.getBoundingClientRect();
    if (w < 2 || h < 2) return;
    const svg = freshSvg(el, spec.svgClass || 'wf-bg', w, h);
    const rc = rough.svg(svg);
    const pad = spec.inset ?? 3;
    const d = Math.min(w, h) - pad * 2;
    svg.appendChild(rc.circle(w / 2, h / 2, d, roughOpts(spec, el)));
  }

  function drawLine(el, spec) {
    const { width: w, height: h } = el.getBoundingClientRect();
    if (w < 2 || h < 2) return;
    const svg = freshSvg(el, spec.svgClass || 'wf-bg', w, h);
    const rc = rough.svg(svg);
    const y = h / 2;
    svg.appendChild(rc.line(4, y, w - 4, y, roughOpts(spec, el)));
  }

  /* ---------- Input wrapping ----------
   * Inputs/selects/textareas get a <span class="wf-input"> wrapper at
   * render time so we have a place for the SVG background. The LLM
   * writes plain <input>; the wrapper is an implementation detail. */
  function wrapInputs(root) {
    const inputs = root.querySelectorAll(
      'input:not([type="checkbox"]):not([type="radio"]), select, textarea'
    );
    inputs.forEach(el => {
      if (el.parentElement?.classList.contains('wf-input')) return;
      const wrap = document.createElement('span');
      wrap.className = 'wf-input';
      el.parentNode.insertBefore(wrap, el);
      wrap.appendChild(el);
    });
  }

  /* ---------- Icons (little sketchy glyphs) ----------
   * drawn into a given svg at a given (x,y), fitting `size` box. */
  const icons = {
    magnifier(rc, svg, x, y, size, seed) {
      const r = size * 0.32;
      svg.appendChild(rc.circle(x + r + 2, y + r + 2, r * 2, {
        stroke: INK, strokeWidth: 1.3, roughness: 1.4, seed,
      }));
      svg.appendChild(rc.line(
        x + r * 2 + 2, y + r * 2 + 2,
        x + size - 2, y + size - 2,
        { stroke: INK, strokeWidth: 1.5, roughness: 1.2, seed: seed + 1 }
      ));
    },
    calendar(rc, svg, x, y, size, seed) {
      const s = size - 4;
      svg.appendChild(rc.rectangle(x + 2, y + 5, s, s - 3, {
        stroke: INK, strokeWidth: 1.3, roughness: 1.4, seed,
      }));
      svg.appendChild(rc.line(x + 2, y + 10, x + 2 + s, y + 10, {
        stroke: INK, strokeWidth: 1.2, roughness: 1.2, seed: seed + 1,
      }));
      // Two little tabs on top
      svg.appendChild(rc.line(x + 6, y + 2, x + 6, y + 7, {
        stroke: INK, strokeWidth: 1.3, roughness: 1, seed: seed + 2,
      }));
      svg.appendChild(rc.line(x + size - 6, y + 2, x + size - 6, y + 7, {
        stroke: INK, strokeWidth: 1.3, roughness: 1, seed: seed + 3,
      }));
    },
    clock(rc, svg, x, y, size, seed) {
      const r = size / 2 - 2;
      const cx = x + size / 2, cy = y + size / 2;
      svg.appendChild(rc.circle(cx, cy, r * 2, {
        stroke: INK, strokeWidth: 1.3, roughness: 1.4, seed,
      }));
      // Hour hand (up) and minute hand (right)
      svg.appendChild(rc.line(cx, cy, cx, cy - r * 0.55, {
        stroke: INK, strokeWidth: 1.3, roughness: 1, seed: seed + 1,
      }));
      svg.appendChild(rc.line(cx, cy, cx + r * 0.7, cy, {
        stroke: INK, strokeWidth: 1.3, roughness: 1, seed: seed + 2,
      }));
    },
    play(rc, svg, x, y, size, seed) {
      // Triangle ▶
      svg.appendChild(rc.polygon([
        [x, y],
        [x, y + size],
        [x + size * 0.9, y + size / 2],
      ], {
        stroke: INK, fill: INK, fillStyle: 'solid',
        strokeWidth: 1.3, roughness: 1.3, seed,
      }));
    },
    chevronUp(rc, svg, x, y, size, seed) {
      const mid = x + size / 2;
      svg.appendChild(rc.linearPath([
        [x + 3, y + size * 0.68],
        [mid, y + size * 0.32],
        [x + size - 3, y + size * 0.68],
      ], { stroke: INK, strokeWidth: 2.2, roughness: 1.4, seed }));
    },
    chevronDown(rc, svg, x, y, size, seed) {
      const mid = x + size / 2;
      svg.appendChild(rc.linearPath([
        [x + 3, y + size * 0.32],
        [mid, y + size * 0.68],
        [x + size - 3, y + size * 0.32],
      ], { stroke: INK, strokeWidth: 2.2, roughness: 1.4, seed }));
    },
    chevronRight(rc, svg, x, y, size, seed) {
      const mid = y + size / 2;
      svg.appendChild(rc.linearPath([
        [x + size * 0.32, y + 3],
        [x + size * 0.68, mid],
        [x + size * 0.32, y + size - 3],
      ], { stroke: INK, strokeWidth: 2.2, roughness: 1.4, seed }));
    },
  };

  /* ---------- Spec table: simple "shape + options" cases ---------- */

  const SPECS = [
    // Form input backgrounds.
    { selector: '.wf-input',
      shape: drawRect, svgClass: 'wf-bg',
      stroke: INK, strokeWidth: 1.4, roughness: 1.6 },

    // Card.
    { selector: 'article',
      shape: drawRect, svgClass: 'wf-bg',
      stroke: el => el.classList.contains('danger') ? DANGER
                  : el.classList.contains('accent') ? ACCENT
                  : INK,
      strokeWidth: 1.6, roughness: 2, bowing: 2, inset: 3 },

    // Alert.
    { selector: 'aside[role="alert"]',
      shape: drawRect, svgClass: 'wf-bg',
      stroke: el => {
        if (el.classList.contains('danger'))  return DANGER;
        if (el.classList.contains('warning')) return WARNING;
        if (el.classList.contains('success')) return SUCCESS;
        return INFO;
      },
      strokeWidth: 1.6, roughness: 1.8, inset: 3 },

    // Table.
    { selector: 'table',
      shape: drawRect, svgClass: 'wf-bg',
      stroke: INK, strokeWidth: 1.4, roughness: 1.6 },

    // Calendar.
    { selector: '.calendar',
      shape: drawRect, svgClass: 'wf-bg',
      stroke: INK, strokeWidth: 1.6, roughness: 2, bowing: 2, inset: 3 },

    // Tag.
    { selector: '.tag',
      shape: drawPill, svgClass: 'wf-bg',
      stroke: INK, fill: MUTED, strokeWidth: 1.2, roughness: 1.4 },

    // Dialog.
    { selector: 'dialog[open]',
      shape: drawRect, svgClass: 'wf-bg',
      stroke: INK, fill: BG, strokeWidth: 1.8, roughness: 2, bowing: 2, inset: 3 },

    // Ruler (<hr>).
    { selector: 'hr',
      shape: drawLine, svgClass: 'wf-bg',
      stroke: INK, strokeWidth: 1.3, roughness: 2, bowing: 3 },
  ];

  /* ---------- Compound drawers ---------- */

  function drawButton(el) {
    if (el.closest('.btnbar')) return;
    if (el.closest('.calendar > header')) return;

    let stroke = INK, fill;
    // Use getAttribute, not el.type — the latter defaults to "submit" for
    // any <button> without an explicit type attribute.
    if (el.getAttribute('type') === 'submit') { stroke = ACCENT; fill = ACCENT; }
    else if (el.classList.contains('danger')) { stroke = DANGER; fill = DANGER; }

    const spec = { svgClass: 'wf-bg', stroke, strokeWidth: 1.5, roughness: 1.8, bowing: 2 };
    if (fill) spec.fill = fill;
    drawRect(el, spec);
  }

  function drawButtonBar(el) {
    const { width: w, height: h } = el.getBoundingClientRect();
    if (w < 2 || h < 2) return;
    const svg = freshSvg(el, 'wf-bg', w, h);
    const rc = rough.svg(svg);

    svg.appendChild(rc.rectangle(2, 2, w - 4, h - 4, {
      stroke: INK, strokeWidth: 1.5, roughness: 1.7, bowing: 1.5,
      seed: seedFor(el, 'frame'),
    }));

    const selected = el.querySelector('[aria-pressed="true"]');
    if (selected) {
      const r = selected.getBoundingClientRect();
      const p = el.getBoundingClientRect();
      svg.appendChild(rc.rectangle(
        r.left - p.left + 2, r.top - p.top + 2, r.width - 4, r.height - 4,
        {
          stroke: INK, fill: INK, fillStyle: 'solid',
          strokeWidth: 1, roughness: 1.5,
          seed: seedFor(el, 'sel'),
        }
      ));
    }
  }

  // Position an overlay SVG directly over an input-like element.
  function overlayOn(input) {
    let svg = input.__wfOverlay;
    if (!svg || !svg.isConnected) {
      svg = document.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('class', 'wf-overlay');
      input.parentNode.insertBefore(svg, input.nextSibling);
      input.__wfOverlay = svg;
    }
    const rect = input.getBoundingClientRect();
    svg.style.left = `${input.offsetLeft}px`;
    svg.style.top = `${input.offsetTop}px`;
    svg.style.width = `${rect.width}px`;
    svg.style.height = `${rect.height}px`;
    svg.setAttribute('viewBox', `0 0 ${rect.width} ${rect.height}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    return { svg, rect };
  }

  function drawToggle(el) {
    const { svg, rect } = overlayOn(el);
    const rc = rough.svg(svg);
    const checked = el.checked;

    svg.appendChild(rc.path(pillPath(rect.width, rect.height), {
      stroke: INK, strokeWidth: 1.3, roughness: 1.4,
      fill: checked ? INK : BG, fillStyle: 'solid',
      seed: seedFor(el, 'track'),
    }));

    const knobR = (rect.height - 6) / 2;
    const knobX = checked ? rect.width - knobR - 3 : knobR + 3;
    svg.appendChild(rc.circle(knobX, rect.height / 2, knobR * 2, {
      stroke: INK, strokeWidth: 1.3, roughness: 1.4,
      fill: BG, fillStyle: 'solid',
      seed: seedFor(el, 'knob'),
    }));
  }

  function drawCheckOrRadio(el) {
    if (el.getAttribute('role') === 'switch') return;
    const { svg } = overlayOn(el);
    svg.setAttribute('viewBox', '0 0 22 22');
    const rc = rough.svg(svg);
    const isRadio = el.type === 'radio';
    const checked = el.checked;

    if (isRadio) {
      svg.appendChild(rc.circle(11, 11, 18, {
        stroke: INK, strokeWidth: 1.3, roughness: 1.4,
        seed: seedFor(el, 'outer'),
      }));
      if (checked) {
        svg.appendChild(rc.circle(11, 11, 9, {
          stroke: INK, fill: INK, fillStyle: 'solid',
          strokeWidth: 1, roughness: 1.2, seed: seedFor(el, 'inner'),
        }));
      }
    } else {
      svg.appendChild(rc.rectangle(2, 2, 18, 18, {
        stroke: INK, strokeWidth: 1.3, roughness: 1.5, seed: seedFor(el, 'box'),
      }));
      if (checked) {
        svg.appendChild(rc.linearPath(
          [[5, 11], [10, 16], [18, 5]],
          { stroke: ACCENT, strokeWidth: 2.2, roughness: 1.2, seed: seedFor(el, 'check') }
        ));
      }
    }
  }

  function drawCalDay(el) {
    const today = el.getAttribute('aria-current') === 'date';
    const selected = el.getAttribute('aria-selected') === 'true';
    if (!today && !selected) {
      const stale = el.querySelector(':scope > svg.wf-bg');
      if (stale) stale.remove();
      return;
    }
    drawCircle(el, {
      svgClass: 'wf-bg',
      stroke: selected ? INK : ACCENT,
      fill: selected ? INK : undefined,
      strokeWidth: selected ? 1.3 : 1.8,
      roughness: selected ? 1.6 : 1.8,
    });
  }

  /* ---------- Accordion chevron ----------
   * A child <svg> is placed at the end of <summary>. Rendered as
   * chevron-down when the parent <details> is closed, chevron-up
   * when open — actively communicating state, not just rotating. */
  function drawAccordionChevron(summary) {
    let svg = summary.querySelector(':scope > svg.wf-chevron');
    if (!svg) {
      svg = document.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('class', 'wf-chevron');
      svg.setAttribute('viewBox', '0 0 22 22');
      // Insert as FIRST child of summary so it appears on the left.
      summary.insertBefore(svg, summary.firstChild);
    }
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    const rc = rough.svg(svg);
    const isOpen = summary.parentElement.hasAttribute('open');
    const seed = seedFor(summary, isOpen ? 'down' : 'right');
    if (isOpen) icons.chevronDown(rc, svg, 0, 0, 22, seed);
    else        icons.chevronRight(rc, svg, 0, 0, 22, seed);
  }

  function drawTab(el) {
    if (el.getAttribute('aria-current') !== 'page') {
      const existing = el.querySelector(':scope > svg.wf-tab-underline');
      if (existing) existing.remove();
      return;
    }
    const { width: w } = el.getBoundingClientRect();
    if (w < 2) return;

    let svg = el.querySelector(':scope > svg.wf-tab-underline');
    if (!svg) {
      svg = document.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('class', 'wf-tab-underline');
      Object.assign(svg.style, {
        position: 'absolute', left: '0', right: '0', bottom: '-1px',
        height: '6px', width: '100%', display: 'block', pointerEvents: 'none',
      });
      el.appendChild(svg);
    }
    svg.setAttribute('viewBox', `0 0 ${w} 6`);
    svg.setAttribute('preserveAspectRatio', 'none');
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    const rc = rough.svg(svg);
    svg.appendChild(rc.line(2, 3, w - 2, 3, {
      stroke: INK, strokeWidth: 2.2, roughness: 1.6, seed: seedFor(el),
    }));
  }

  /* ---------- Nav underline ----------
   * Sketchy line across the full bottom of a <nav> (the nav container
   * itself, not a specific tab). Uses stroke-dasharray via Rough.js's
   * strokeLineDash option for a broken, hand-drawn look. */
  function drawNavUnderline(nav) {
    const { width: w } = nav.getBoundingClientRect();
    if (w < 2) return;
    let svg = nav.querySelector(':scope > svg.wf-nav-line');
    if (!svg) {
      svg = document.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('class', 'wf-nav-line');
      Object.assign(svg.style, {
        position: 'absolute', left: '0', bottom: '0',
        width: '100%', height: '6px',
        display: 'block', pointerEvents: 'none', zIndex: '-1',
      });
      nav.appendChild(svg);
    }
    svg.setAttribute('viewBox', `0 0 ${w} 6`);
    svg.setAttribute('preserveAspectRatio', 'none');
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    const rc = rough.svg(svg);
    svg.appendChild(rc.line(2, 3, w - 2, 3, {
      stroke: '#9ca3af', strokeWidth: 1.2, roughness: 1.5, seed: seedFor(nav),
    }));
  }

  /* ---------- Table header divider ----------
   * A sketchy line under the <thead>, spanning the full table width. */
  function drawTableHeaderDivider(table) {
    const thead = table.querySelector(':scope > thead');
    if (!thead) return;
    const tableRect = table.getBoundingClientRect();
    const theadRect = thead.getBoundingClientRect();
    const w = tableRect.width;
    if (w < 2) return;

    let svg = table.querySelector(':scope > svg.wf-thead-divider');
    if (!svg) {
      svg = document.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('class', 'wf-thead-divider');
      Object.assign(svg.style, {
        position: 'absolute', left: '0',
        width: '100%', height: '6px',
        display: 'block', pointerEvents: 'none', zIndex: '0',
      });
      table.appendChild(svg);
    }
    // Position at the bottom of the thead.
    const offsetTop = theadRect.bottom - tableRect.top - 3;
    svg.style.top = `${offsetTop}px`;
    svg.setAttribute('viewBox', `0 0 ${w} 6`);
    svg.setAttribute('preserveAspectRatio', 'none');
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    const rc = rough.svg(svg);
    svg.appendChild(rc.line(2, 3, w - 2, 3, {
      stroke: INK, strokeWidth: 1.6, roughness: 1.4, seed: seedFor(table, 'thead'),
    }));
  }

  /* ---------- Input icons: search, date, time, number steppers ---------- */

  function drawInputIcon(wrap, kind) {
    // wrap is the .wf-input span; icon drawn at the right edge.
    const { width: w, height: h } = wrap.getBoundingClientRect();
    if (w < 2 || h < 2) return;
    const svg = freshSvg(wrap, 'wf-bg', w, h);
    const rc = rough.svg(svg);

    // Redraw the background — pill for search, rect for others.
    if (kind === 'search') {
      svg.appendChild(rc.path(pillPath(w, h), {
        stroke: INK, strokeWidth: 1.4, roughness: 1.6, seed: seedFor(wrap),
      }));
    } else {
      svg.appendChild(rc.rectangle(2, 2, w - 4, h - 4, {
        stroke: INK, strokeWidth: 1.4, roughness: 1.6, seed: seedFor(wrap),
      }));
    }

    const iconSize = 18;
    const iconX = w - iconSize - 12;
    const iconY = (h - iconSize) / 2;
    const seed = seedFor(wrap, 'icon');

    if (kind === 'search')       icons.magnifier(rc, svg, iconX, iconY, iconSize, seed);
    else if (kind === 'date')    icons.calendar (rc, svg, iconX, iconY, iconSize, seed);
    else if (kind === 'time')    icons.clock    (rc, svg, iconX, iconY, iconSize, seed);
    else if (kind === 'datetime') {
      icons.calendar(rc, svg, iconX - iconSize - 4, iconY, iconSize, seed);
      icons.clock(rc, svg, iconX, iconY, iconSize, seed + 10);
    }
    else if (kind === 'number') {
      icons.chevronUp  (rc, svg, w - 20, 4,    14, seed);
      icons.chevronDown(rc, svg, w - 20, h-18, 14, seed + 1);
    }
  }

  /* ---------- Image & video placeholder ---------- */

  function drawMediaPlaceholder(el, kind) {
    const { width: w, height: h } = el.getBoundingClientRect();
    if (w < 2 || h < 2) return;

    // img/video are replaced elements and can't contain SVG children,
    // so we inject the SVG as a sibling and position it absolutely.
    let svg = el.__wfMediaSvg;
    if (!svg || !svg.isConnected) {
      svg = document.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('class', 'wf-overlay');
      // Ensure the parent is a positioned context.
      if (el.parentElement && getComputedStyle(el.parentElement).position === 'static') {
        el.parentElement.style.position = 'relative';
      }
      el.parentNode.insertBefore(svg, el.nextSibling);
      el.__wfMediaSvg = svg;
    }
    svg.style.left = `${el.offsetLeft}px`;
    svg.style.top = `${el.offsetTop}px`;
    svg.style.width = `${w}px`;
    svg.style.height = `${h}px`;
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    const rc = rough.svg(svg);
    const seed = seedFor(el);

    svg.appendChild(rc.rectangle(2, 2, w - 4, h - 4, {
      stroke: INK, strokeWidth: 1.4, roughness: 1.6, seed,
    }));

    if (kind === 'video') {
      // Centered play triangle
      const size = Math.min(w, h) * 0.25;
      const x = (w - size * 0.9) / 2;
      const y = (h - size) / 2;
      icons.play(rc, svg, x, y, size, seed + 1);
    } else {
      // Diagonal cross to mark "image goes here"
      svg.appendChild(rc.line(4, 4, w - 4, h - 4, {
        stroke: INK, strokeWidth: 1.2, roughness: 1.8, seed: seed + 1,
      }));
      svg.appendChild(rc.line(w - 4, 4, 4, h - 4, {
        stroke: INK, strokeWidth: 1.2, roughness: 1.8, seed: seed + 2,
      }));
    }
  }

  /* ---------- Chart placeholder ---------- */

  function drawChart(el) {
    const { width: w, height: h } = el.getBoundingClientRect();
    if (w < 2 || h < 2) return;
    const svg = freshSvg(el, 'wf-bg', w, h);
    const rc = rough.svg(svg);
    const seed = seedFor(el);

    if (el.classList.contains('bar')) {
      // Axis
      const axY = h - 24;
      svg.appendChild(rc.line(24, 8, 24, axY, { stroke: INK, strokeWidth: 1.4, roughness: 1.3, seed }));
      svg.appendChild(rc.line(24, axY, w - 8, axY, { stroke: INK, strokeWidth: 1.4, roughness: 1.3, seed: seed + 1 }));
      // Bars
      const heights = [0.55, 0.75, 0.40, 0.85, 0.60, 0.90, 0.70];
      const barArea = w - 40;
      const barW = (barArea / heights.length) * 0.65;
      const gap = (barArea / heights.length) * 0.35;
      heights.forEach((ratio, i) => {
        const bh = (axY - 8) * ratio;
        const x = 28 + i * (barW + gap);
        svg.appendChild(rc.rectangle(x, axY - bh, barW, bh, {
          stroke: INK, fill: INK, fillStyle: 'hachure',
          strokeWidth: 1.2, roughness: 1.5, hachureGap: 4,
          seed: seed + 10 + i,
        }));
      });
    } else if (el.classList.contains('line')) {
      const axY = h - 24;
      svg.appendChild(rc.line(24, 8, 24, axY, { stroke: INK, strokeWidth: 1.4, roughness: 1.3, seed }));
      svg.appendChild(rc.line(24, axY, w - 8, axY, { stroke: INK, strokeWidth: 1.4, roughness: 1.3, seed: seed + 1 }));
      // Line series
      const n = 8;
      const xs = Array.from({ length: n }, (_, i) => 30 + (i / (n - 1)) * (w - 40));
      const ys = [0.3, 0.5, 0.35, 0.65, 0.55, 0.8, 0.7, 0.9].map(r => axY - r * (axY - 12));
      const pts = xs.map((x, i) => [x, ys[i]]);
      svg.appendChild(rc.linearPath(pts, {
        stroke: ACCENT, strokeWidth: 2, roughness: 1.3, seed: seed + 2,
      }));
      // Dots at points
      pts.forEach(([x, y], i) => {
        svg.appendChild(rc.circle(x, y, 6, {
          stroke: INK, fill: INK, fillStyle: 'solid',
          strokeWidth: 1, roughness: 1, seed: seed + 20 + i,
        }));
      });
    } else if (el.classList.contains('pie')) {
      const cx = w / 2, cy = h / 2;
      const r = Math.min(w, h) / 2 - 10;
      // Three slices at rough angles. Using paths since Rough.js lacks arc.
      const slices = [
        { start: 0,             end: Math.PI * 0.8, fillStyle: 'hachure' },
        { start: Math.PI * 0.8, end: Math.PI * 1.4, fillStyle: 'cross-hatch' },
        { start: Math.PI * 1.4, end: Math.PI * 2,   fillStyle: 'zigzag' },
      ];
      slices.forEach((s, i) => {
        const x1 = cx + r * Math.cos(s.start), y1 = cy + r * Math.sin(s.start);
        const x2 = cx + r * Math.cos(s.end),   y2 = cy + r * Math.sin(s.end);
        const largeArc = (s.end - s.start) > Math.PI ? 1 : 0;
        const d = `M ${cx},${cy} L ${x1},${y1} A ${r},${r} 0 ${largeArc},1 ${x2},${y2} Z`;
        svg.appendChild(rc.path(d, {
          stroke: INK, fill: INK, fillStyle: s.fillStyle,
          strokeWidth: 1.3, roughness: 1.4, hachureGap: 5,
          seed: seed + 30 + i,
        }));
      });
    } else {
      // Fallback: a dashed rectangle labeled "chart"
      svg.appendChild(rc.rectangle(2, 2, w - 4, h - 4, {
        stroke: INK, strokeWidth: 1.3, roughness: 1.8, seed,
      }));
    }
  }

  /* ---------- Popover ----------
   * Speech-bubble style: positioned next to the trigger button, with a
   * leftward-pointing notch in the middle of its left edge. Toggled on
   * click of the trigger. Only one open at a time. Scrolls with the page. */

  // Speech-bubble path: rounded rect with triangular notch on the left.
  function bubblePath(w, h) {
    const notch = 10;
    const notchH = 14;
    const r = 6;
    const midY = h / 2;
    return [
      `M ${notch + r},1`,
      `L ${w - r - 1},1`,
      `A ${r},${r} 0 0,1 ${w - 1},${r + 1}`,
      `L ${w - 1},${h - r - 1}`,
      `A ${r},${r} 0 0,1 ${w - r - 1},${h - 1}`,
      `L ${notch + r},${h - 1}`,
      `A ${r},${r} 0 0,1 ${notch},${h - r - 1}`,
      `L ${notch},${midY + notchH / 2}`,
      `L 1,${midY}`,
      `L ${notch},${midY - notchH / 2}`,
      `L ${notch},${r + 1}`,
      `A ${r},${r} 0 0,1 ${notch + r},1`,
      'Z',
    ].join(' ');
  }

  function drawPopover(pop) {
    const target = document.querySelector(`[popovertarget="${pop.id}"]`);
    if (!target) return;
    const tRect = target.getBoundingClientRect();

    // Absolute positioning in document coords so the bubble scrolls with
    // its context (not fixed to the viewport).
    pop.style.display = 'block';
    pop.style.left = `${window.scrollX + tRect.right + 12}px`;

    // Measure height to center vertically against the trigger.
    pop.style.visibility = 'hidden';
    pop.style.top = '0px';
    const pHeight = pop.offsetHeight;
    const tCenterY = window.scrollY + tRect.top + tRect.height / 2;
    pop.style.top = `${tCenterY - pHeight / 2}px`;
    pop.style.visibility = '';

    const w = pop.offsetWidth;
    const h = pop.offsetHeight;
    const svg = freshSvg(pop, 'wf-bg', w, h);
    const rc = rough.svg(svg);
    svg.appendChild(rc.path(bubblePath(w, h), {
      stroke: INK, fill: BG, fillStyle: 'solid',
      strokeWidth: 1.6, roughness: 1.6, bowing: 1.2,
      seed: seedFor(pop),
    }));
  }

  function hideAllPopovers() {
    document.querySelectorAll('[popover]').forEach(pop => {
      pop.style.display = 'none';
      pop.removeAttribute('data-wf-open');
    });
  }

  function togglePopover(pop) {
    const wasOpen = pop.getAttribute('data-wf-open') === 'true';
    hideAllPopovers();
    if (!wasOpen) {
      pop.setAttribute('data-wf-open', 'true');
      drawPopover(pop);
    }
  }

  /* ---------- Orchestration ---------- */

  function render() {
    wrapInputs(document);

    // Generic spec-driven pass.
    for (const spec of SPECS) {
      document.querySelectorAll(spec.selector).forEach(el => spec.shape(el, spec));
    }

    // Compound components.
    document.querySelectorAll('button').forEach(drawButton);
    document.querySelectorAll('.btnbar').forEach(drawButtonBar);
    document.querySelectorAll('input[type="checkbox"][role="switch"]').forEach(drawToggle);
    document.querySelectorAll('input[type="checkbox"], input[type="radio"]').forEach(drawCheckOrRadio);
    document.querySelectorAll('.calendar > ol > li').forEach(drawCalDay);
    document.querySelectorAll('nav > a').forEach(drawTab);
    document.querySelectorAll('nav').forEach(drawNavUnderline);
    document.querySelectorAll('table').forEach(drawTableHeaderDivider);

    // Input-icon overlays (these re-draw the input bg since freshSvg clears it).
    document.querySelectorAll('input[type="search"]').forEach(input =>
      drawInputIcon(input.parentElement, 'search'));
    document.querySelectorAll('input[type="date"]').forEach(input =>
      drawInputIcon(input.parentElement, 'date'));
    document.querySelectorAll('input[type="time"]').forEach(input =>
      drawInputIcon(input.parentElement, 'time'));
    document.querySelectorAll('input[type="datetime-local"]').forEach(input =>
      drawInputIcon(input.parentElement, 'datetime'));
    document.querySelectorAll('input[type="number"]').forEach(input =>
      drawInputIcon(input.parentElement, 'number'));

    // Media placeholders.
    document.querySelectorAll('img:not([src]), img[src=""]').forEach(el =>
      drawMediaPlaceholder(el, 'image'));
    document.querySelectorAll('video:not([src])').forEach(el => {
      if (!el.querySelector('source')) drawMediaPlaceholder(el, 'video');
    });

    // Chart placeholders.
    document.querySelectorAll('figure.chart').forEach(drawChart);

    // Accordion chevrons.
    document.querySelectorAll('details > summary').forEach(drawAccordionChevron);

    // Re-draw any currently-open popover so it follows its trigger on
    // resize/scroll-triggered re-renders.
    document.querySelectorAll('[popover][data-wf-open="true"]').forEach(drawPopover);

    window.__wireframeReady = true;
  }

  window.wireframeKit = {
    render,
    openPopover(id) {
      const pop = document.getElementById(id);
      if (pop && pop.hasAttribute('popover')) togglePopover(pop);
    },
    closePopovers: hideAllPopovers,
  };

  /* ---------- Event wiring ---------- */

  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(render, 100);
  });

  document.addEventListener('change', (e) => {
    if (e.target.matches('input[type="checkbox"], input[type="radio"]')) {
      render();
    }
  });

  document.addEventListener('click', (e) => {
    const tab = e.target.closest('nav > a');
    if (tab) {
      e.preventDefault();
      tab.parentElement.querySelectorAll('a').forEach(t => t.removeAttribute('aria-current'));
      tab.setAttribute('aria-current', 'page');
      render();
    }
  });

  // Re-render when details open/close.
  document.addEventListener('toggle', (e) => {
    if (e.target.matches('details')) render();
  }, true);

  // Intercept popovertarget clicks. We want our custom toggle logic
  // (one at a time, speech-bubble positioning) rather than the native
  // popover API's default behavior.
  document.addEventListener('click', (e) => {
    const trigger = e.target.closest('[popovertarget]');
    if (trigger) {
      const pop = document.getElementById(trigger.getAttribute('popovertarget'));
      if (pop) {
        e.preventDefault();
        e.stopPropagation();
        togglePopover(pop);
        return;
      }
    }

    // Click outside any popover closes all of them.
    if (!e.target.closest('[popover]') && !e.target.closest('[popovertarget]')) {
      hideAllPopovers();
    }
  }, true);

  // Reposition open popovers on scroll so they track their triggers.
  window.addEventListener('scroll', () => {
    document.querySelectorAll('[popover][data-wf-open="true"]').forEach(drawPopover);
  }, { passive: true });

  const init = () => {
    // Initialize all popovers as hidden until clicked.
    document.querySelectorAll('[popover]').forEach(pop => {
      pop.style.display = 'none';
    });
    render();
  };

  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(init);
  } else {
    window.addEventListener('load', init);
  }
})();
