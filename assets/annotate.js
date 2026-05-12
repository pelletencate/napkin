/* Napkin annotation overlay — injected into proposal.html by the server.
 * Runs entirely inside a Shadow DOM to stay isolated from napkin-kit styles.
 * Includes a minimal in-place DOM morpher so revisions apply without reload. */
(function () {
  'use strict';

  // ─────────────────────────────────────────────
  // Minimal in-place DOM morpher (homegrown — not Idiomorph).
  // Reuses live nodes when ids/tags match, falls back to clone+insert.
  // ─────────────────────────────────────────────
  const Morph = (function () {
    function morphAttrs(from, to) {
      for (let i = from.attributes.length - 1; i >= 0; i--) {
        const n = from.attributes[i].name;
        if (!to.hasAttribute(n)) from.removeAttribute(n);
      }
      for (const a of to.attributes) {
        if (from.getAttribute(a.name) !== a.value) from.setAttribute(a.name, a.value);
      }
    }

    function bestMatch(fromParent, toEl, startFrom) {
      // Prefer same id, then same tag at same relative position.
      if (toEl.id) {
        let c = startFrom;
        while (c) {
          if (c.nodeType === Node.ELEMENT_NODE && c.id === toEl.id) return c;
          c = c.nextSibling;
        }
      }
      // Fall back to first same-tag sibling
      let c = startFrom;
      while (c) {
        if (c.nodeType === Node.ELEMENT_NODE && c.tagName === toEl.tagName) return c;
        c = c.nextSibling;
      }
      return null;
    }

    function morphChildren(from, to) {
      let fromChild = from.firstChild;

      for (const toChild of to.childNodes) {
        if (toChild.nodeType === Node.TEXT_NODE) {
          if (!fromChild || fromChild.nodeType !== Node.TEXT_NODE) {
            from.insertBefore(document.createTextNode(toChild.textContent), fromChild || null);
          } else {
            if (fromChild.textContent !== toChild.textContent) fromChild.textContent = toChild.textContent;
            fromChild = fromChild.nextSibling;
          }
          continue;
        }

        if (toChild.nodeType !== Node.ELEMENT_NODE) continue;

        const match = bestMatch(from, toChild, fromChild);
        if (match) {
          // Move match to current position if needed
          if (match !== fromChild) from.insertBefore(match, fromChild || null);
          morphAttrs(match, toChild);
          morphChildren(match, toChild);
          fromChild = match.nextSibling;
        } else {
          from.insertBefore(toChild.cloneNode(true), fromChild || null);
        }
      }

      // Remove leftover old nodes
      while (fromChild) {
        const next = fromChild.nextSibling;
        from.removeChild(fromChild);
        fromChild = next;
      }
    }

    return {
      /** Morph target's children to match innerHTMLlike newHTML string. */
      morph(target, newHTML) {
        const tmp = document.createElement('div');
        tmp.innerHTML = newHTML;
        morphChildren(target, tmp);
      },
    };
  })();

  // ─────────────────────────────────────────────
  // Config — injected by server as window.__NK_CONFIG
  // ─────────────────────────────────────────────
  const cfg = window.__NK_CONFIG || {};
  const TOKEN      = cfg.token || '';
  const PORT       = cfg.port  || location.port || 80;
  const HTTP       = `http://127.0.0.1:${PORT}`;
  const WS_URL     = `ws://127.0.0.1:${PORT}/ws?t=${TOKEN}`;
  const HOST_ID    = 'nk-annotate-root';
  const CATCHER_ID = 'nk-click-catcher';

  function authHeaders() {
    return { 'X-NK-Token': TOKEN, 'Content-Type': 'application/json' };
  }

  // ─────────────────────────────────────────────
  // State
  // ─────────────────────────────────────────────
  let annotateMode = false;
  let selection    = null;   // { chain: Element[], chainIdx: number }
  let shadow       = null;   // ShadowRoot
  let statusDot    = null;   // span.dot inside shadow
  let ws           = null;
  let wsPingTimer  = null;
  let wsReconnect  = null;
  let sessionEnded = false;  // set when user clicks Stop; suppresses WS reconnect

  const pendingPins = new Map();  // id → { comment, selector, el, dotEl }
  let   orphanedPins = [];        // [{ id, comment, selector }]
  let   selectedOrphanId = null;

  // ─────────────────────────────────────────────
  // DOM helpers
  // ─────────────────────────────────────────────
  function getDeepestAt(x, y) {
    for (const el of document.elementsFromPoint(x, y)) {
      if (el.id === HOST_ID || el.id === CATCHER_ID) continue;
      if (el === document.body || el === document.documentElement) continue;
      return el;
    }
    return document.body;
  }

  function buildChain(el) {
    // chain[0]=deepest, chain[last]=just above <body>
    const chain = [];
    let cur = el;
    while (cur && cur !== document.body && cur !== document.documentElement) {
      chain.push(cur);
      cur = cur.parentElement;
    }
    return chain;
  }

  function escHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function getCssSelector(el) {
    const parts = [];
    let cur = el;
    while (cur && cur !== document.body && cur !== document.documentElement) {
      if (cur.id) { parts.unshift(`#${CSS.escape(cur.id)}`); break; }
      let part = cur.tagName.toLowerCase();
      const classes = [...cur.classList].filter(c => !c.startsWith('nk-'));
      if (classes.length) part += '.' + classes.map(c => CSS.escape(c)).join('.');
      const parent = cur.parentElement;
      if (parent) {
        const sameTag = [...parent.children].filter(c => c.tagName === cur.tagName);
        if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(cur) + 1})`;
      }
      parts.unshift(part);
      cur = cur.parentElement;
    }
    return parts.join(' > ') || el.tagName.toLowerCase();
  }

  function getXPath(el) {
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === Node.ELEMENT_NODE && cur !== document.documentElement) {
      const tag = cur.tagName.toLowerCase();
      let idx = 1;
      let sib = cur.previousElementSibling;
      while (sib) { if (sib.tagName === cur.tagName) idx++; sib = sib.previousElementSibling; }
      parts.unshift(idx > 1 ? `${tag}[${idx}]` : tag);
      cur = cur.parentElement;
    }
    return '/html/' + parts.join('/');
  }

  function getClientRect(el) {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
  }

  // ─────────────────────────────────────────────
  // Highlight box
  // ─────────────────────────────────────────────
  function showHighlight(el) {
    if (!shadow) return;
    const box = shadow.getElementById('highlight-box');
    const r = el.getBoundingClientRect();
    Object.assign(box.style, {
      left:   `${r.left - 2}px`,
      top:    `${r.top - 2}px`,
      width:  `${r.width + 4}px`,
      height: `${r.height + 4}px`,
    });
    box.classList.add('visible');
  }

  function hideHighlight() {
    shadow?.getElementById('highlight-box')?.classList.remove('visible');
  }

  // ─────────────────────────────────────────────
  // Annotation panel
  // ─────────────────────────────────────────────
  function showPanel(el) {
    if (!shadow) return;
    const panel = shadow.getElementById('annotation-panel');
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    const pw = 288, ph = 210;

    let left = r.right + 12;
    let top  = r.top;
    if (left + pw > vw - 8) left = r.left - pw - 12;
    if (left < 8) left = 8;
    if (top + ph > vh - 8) top = Math.max(8, vh - ph - 8);

    Object.assign(panel.style, { left: `${left}px`, top: `${top}px` });
    panel.classList.add('visible');
    setTimeout(() => shadow.getElementById('comment-input')?.focus(), 40);
  }

  function hidePanel() {
    shadow?.getElementById('annotation-panel')?.classList.remove('visible');
  }

  function refreshPanel() {
    if (!shadow || !selection) return;
    const { chain, chainIdx } = selection;
    const el = chain[chainIdx];
    shadow.getElementById('breadcrumb').textContent = getCssSelector(el);

    const btns = shadow.getElementById('panel-actions').querySelectorAll('.pa-btn');
    btns[0].disabled = chainIdx <= 0;                    // narrow
    btns[1].disabled = chainIdx >= chain.length - 1;     // broaden

    showHighlight(el);
    showPanel(el);
  }

  // ─────────────────────────────────────────────
  // Selection model
  // ─────────────────────────────────────────────
  function startSelection(el) {
    selection = { chain: buildChain(el), chainIdx: 0 };
    refreshPanel();
  }

  function shiftSelection(dir) {
    if (!selection) return;
    const next = selection.chainIdx + dir;
    if (next < 0 || next >= selection.chain.length) return;
    selection.chainIdx = next;
    refreshPanel();
  }

  function clearSelection() {
    selection = null;
    hideHighlight();
    hidePanel();
    if (shadow) shadow.getElementById('comment-input').value = '';
    if (shadow) shadow.getElementById('submit-btn').disabled = true;
  }

  // ─────────────────────────────────────────────
  // Click catcher — transparent overlay that intercepts clicks during
  // annotate mode. Disabled buttons don't dispatch click events per the
  // HTML spec, so we can't rely on a document-level click listener to
  // detect clicks on them. The catcher sits above page content but below
  // the toolbar/panel/pin-dots (z-index 2147483643 vs 2147483644+), so
  // annotation UI stays interactive while page clicks become annotations.
  // ─────────────────────────────────────────────
  let catcherEl = null;

  function onCatcherClick(e) {
    e.preventDefault();
    e.stopPropagation();
    // Temporarily disable the catcher so elementsFromPoint sees what's
    // underneath it.
    catcherEl.style.pointerEvents = 'none';
    const target = getDeepestAt(e.clientX, e.clientY);
    catcherEl.style.pointerEvents = '';

    if (selectedOrphanId !== null) {
      const orphan = orphanedPins.find(o => o.id === selectedOrphanId);
      if (orphan) {
        orphan.selector = getCssSelector(target);
        addPendingPin(orphan.id, orphan.comment, orphan.selector, target);
        orphanedPins = orphanedPins.filter(o => o.id !== selectedOrphanId);
        selectedOrphanId = null;
        renderOrphanChips();
        return;
      }
    }

    startSelection(target);
  }

  // ─────────────────────────────────────────────
  // Annotate mode
  // ─────────────────────────────────────────────
  function setAnnotateMode(on) {
    annotateMode = on;
    document.body.style.cursor = on ? 'crosshair' : '';
    if (on) {
      if (!catcherEl) {
        catcherEl = document.createElement('div');
        catcherEl.id = CATCHER_ID;
        Object.assign(catcherEl.style, {
          position: 'fixed',
          inset:    '0',
          zIndex:   '2147483643',
          cursor:   'crosshair',
          background: 'transparent',
        });
        catcherEl.addEventListener('click', onCatcherClick);
        document.body.appendChild(catcherEl);
      }
    } else {
      if (catcherEl) {
        catcherEl.remove();
        catcherEl = null;
      }
      clearSelection();
    }
  }

  // ─────────────────────────────────────────────
  // Pending pin dots
  // ─────────────────────────────────────────────
  function placePinDot(dotEl, el) {
    if (!el) { dotEl.style.display = 'none'; return; }
    try {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) { dotEl.style.display = 'none'; return; }
      Object.assign(dotEl.style, {
        display: '',
        left: `${r.right - 10}px`,
        top:  `${r.top  - 10}px`,
      });
    } catch { dotEl.style.display = 'none'; }
  }

  function addPendingPin(id, comment, selector, el) {
    const dotEl = document.createElement('div');
    dotEl.className = 'pin-dot';
    dotEl.title = 'Click to dismiss this annotation';
    dotEl.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      dotEl.remove();
      pendingPins.delete(id);
    });
    shadow.appendChild(dotEl);
    placePinDot(dotEl, el);
    pendingPins.set(id, { comment, selector, el, dotEl });
  }

  function refreshPinPositions() {
    for (const pin of pendingPins.values()) placePinDot(pin.dotEl, pin.el);
  }

  // ─────────────────────────────────────────────
  // Orphan chips
  // ─────────────────────────────────────────────
  function renderOrphanChips() {
    if (!shadow) return;
    const tray = shadow.getElementById('orphan-tray');
    tray.innerHTML = '';
    for (const o of orphanedPins) {
      const chip = document.createElement('div');
      chip.className = 'orphan-chip' + (o.id === selectedOrphanId ? ' selected' : '');

      const body = document.createElement('div');
      body.className = 'chip-body';
      body.innerHTML =
        `<span class="chip-comment">${escHtml(o.comment)}</span>` +
        `<small>Element not found — tap to reconnect</small>`;
      body.addEventListener('click', () => {
        selectedOrphanId = selectedOrphanId === o.id ? null : o.id;
        renderOrphanChips();
      });

      const dismiss = document.createElement('button');
      dismiss.className = 'chip-dismiss';
      dismiss.textContent = '×';
      dismiss.title = 'Dismiss this annotation';
      dismiss.addEventListener('click', (e) => {
        e.stopPropagation();
        orphanedPins = orphanedPins.filter(x => x.id !== o.id);
        if (selectedOrphanId === o.id) selectedOrphanId = null;
        renderOrphanChips();
      });

      chip.appendChild(body);
      chip.appendChild(dismiss);
      tray.appendChild(chip);
    }
  }

  // ─────────────────────────────────────────────
  // Annotation submission
  // ─────────────────────────────────────────────
  function submitAnnotation() {
    if (!shadow || !selection) return;
    const input = shadow.getElementById('comment-input');
    const comment = input.value.trim();
    if (!comment) return;

    const { chain, chainIdx } = selection;
    const el = chain[chainIdx];

    const payload = {
      comment,
      selector:    getCssSelector(el),
      xpath:       getXPath(el),
      tag:         el.tagName.toLowerCase(),
      classes:     [...el.classList].filter(c => !c.startsWith('nk-')),
      attributes:  Object.fromEntries([...el.attributes].map(a => [a.name, a.value])),
      textSnippet: el.textContent.trim().slice(0, 80),
      rect:        getClientRect(el),
      viewport:    { w: window.innerWidth, h: window.innerHeight, scrollY: Math.round(window.scrollY) },
    };

    fetch(`${HTTP}/annotation`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(payload),
    })
      .then(r => r.ok ? r.json() : Promise.reject(r.status))
      .then(({ id }) => {
        addPendingPin(id, comment, payload.selector, el);
        clearSelection();
      })
      .catch(err => console.error('[annotate] submit failed', err));
  }

  // ─────────────────────────────────────────────
  // Post-morph pin resolution
  // ─────────────────────────────────────────────
  function resolvePinsAfterMorph() {
    for (const [id, pin] of pendingPins) {
      const found = document.querySelector(pin.selector);
      if (found) {
        pin.el = found;
        placePinDot(pin.dotEl, found);
      } else {
        pin.dotEl.remove();
        orphanedPins.push({ id, comment: pin.comment, selector: pin.selector });
        pendingPins.delete(id);
      }
    }
    // Try to reconnect existing orphans
    orphanedPins = orphanedPins.filter(o => {
      const found = document.querySelector(o.selector);
      if (found) { addPendingPin(o.id, o.comment, o.selector, found); return false; }
      return true;
    });
    renderOrphanChips();
  }

  // ─────────────────────────────────────────────
  // Morph handler (server → client)
  // ─────────────────────────────────────────────
  function handleMorph(bodyHTML) {
    // Strip the overlay injections so idiomorph doesn't see them
    const inner = (bodyHTML.match(/<body[^>]*>([\s\S]*)<\/body>/i) || [, bodyHTML])[1];
    const cleaned = inner
      .replace(/<script[^>]*annotate\.js[^>]*><\/script>\s*/gi, '')
      .replace(/<script>\s*window\.__NK_CONFIG\s*=[^<]*<\/script>\s*/gi, '')
      .replace(/<link[^>]*annotate\.css[^>]*>\s*/gi, '');

    // Detach overlay host and click catcher before morphing so the morpher
    // doesn't wipe them out as it replaces body children.
    const host    = document.getElementById(HOST_ID);
    const catcher = document.getElementById(CATCHER_ID);
    if (host)    host.remove();
    if (catcher) catcher.remove();

    clearSelection();
    Morph.morph(document.body, cleaned);

    if (host)    document.body.appendChild(host);
    if (catcher) document.body.appendChild(catcher);
    if (window.napkinKit?.render) window.napkinKit.render();

    resolvePinsAfterMorph();
  }

  // ─────────────────────────────────────────────
  // WebSocket
  // ─────────────────────────────────────────────
  function connectWS() {
    try { ws?.close(); } catch {}
    clearInterval(wsPingTimer);

    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      clearTimeout(wsReconnect);
      wsReconnect = null;
      if (statusDot) statusDot.className = 'dot green';
      wsPingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'pong' }));
      }, 15000);
    };

    ws.onmessage = ({ data }) => {
      let msg; try { msg = JSON.parse(data); } catch { return; }
      if (msg.type === 'morph')         { handleMorph(msg.html); if (statusDot) statusDot.className = 'dot green'; }
      else if (msg.type === 'agent-working') { if (statusDot) statusDot.className = 'dot amber'; }
      else if (msg.type === 'agent-ready')   { if (statusDot) statusDot.className = 'dot green'; }
      else if (msg.type === 'ping')          { ws.send(JSON.stringify({ type: 'pong' })); }
    };

    ws.onclose = () => {
      clearInterval(wsPingTimer);
      if (statusDot) statusDot.className = 'dot amber';
      if (sessionEnded) return;
      if (!wsReconnect) wsReconnect = setTimeout(connectWS, 2500);
    };
    ws.onerror = () => ws.close();
  }

  // ─────────────────────────────────────────────
  // Keyboard handler
  // ─────────────────────────────────────────────
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') clearSelection();
  });

  window.addEventListener('scroll', () => {
    if (selection) refreshPanel();
    refreshPinPositions();
  }, { passive: true });

  window.addEventListener('resize', () => {
    if (selection) refreshPanel();
    refreshPinPositions();
  });

  // ─────────────────────────────────────────────
  // Shadow DOM build
  // ─────────────────────────────────────────────
  function buildUI(root) {
    shadow = root;

    // Toolbar
    const toolbar = el('div', { id: 'toolbar' });
    const dot = el('span', { className: 'dot amber' });
    statusDot = dot;

    const annotateBtn = el('button', { className: 'tb-btn', textContent: 'Annotate' });
    annotateBtn.onclick = () => {
      const next = !annotateMode;
      setAnnotateMode(next);
      annotateBtn.classList.toggle('active', next);
    };

    const stopBtn = el('button', { className: 'tb-btn danger', textContent: 'Stop' });
    stopBtn.onclick = () => {
      if (!confirm('Finish this napkin session?')) return;
      sessionEnded = true;
      try { ws?.close(); } catch {}
      fetch(`${HTTP}/stop`, { method: 'POST', headers: { 'X-NK-Token': TOKEN } })
        .finally(showEndedOverlay);
    };

    toolbar.append(dot, annotateBtn, stopBtn);

    // Highlight box
    const highlightBox = el('div', { id: 'highlight-box' });

    // Annotation panel
    const panel = el('div', { id: 'annotation-panel' });
    const breadcrumb = el('div', { id: 'breadcrumb' });
    const commentInput = el('textarea', { id: 'comment-input', placeholder: 'Describe what should change…' });
    commentInput.oninput = () => {
      root.getElementById('submit-btn').disabled = commentInput.value.trim().length === 0;
    };

    const actions = el('div', { id: 'panel-actions' });

    const narrowBtn  = el('button', { className: 'pa-btn', textContent: '↓ narrow' });
    narrowBtn.disabled  = true;
    narrowBtn.onclick   = () => shiftSelection(-1);

    const broadenBtn = el('button', { className: 'pa-btn', textContent: '↑ broaden' });
    broadenBtn.disabled = true;
    broadenBtn.onclick  = () => shiftSelection(1);

    const cancelBtn = el('button', { className: 'pa-btn', textContent: 'Cancel' });
    cancelBtn.onclick   = () => clearSelection();

    const submitBtn = el('button', { id: 'submit-btn', className: 'pa-btn primary', textContent: 'Submit' });
    submitBtn.disabled  = true;
    submitBtn.onclick   = () => submitAnnotation();

    actions.append(narrowBtn, broadenBtn, cancelBtn, submitBtn);
    panel.append(breadcrumb, commentInput, actions);

    const orphanTray = el('div', { id: 'orphan-tray' });

    root.append(toolbar, highlightBox, panel, orphanTray);
  }

  function el(tag, props) {
    return Object.assign(document.createElement(tag), props);
  }

  // Full-page overlay shown after the user clicks Stop. window.close() is a
  // no-op for tabs the user navigated to (vs opened via JS), so the next-best
  // thing is to make the ended state visually unmistakable.
  function showEndedOverlay() {
    if (!shadow) return;
    if (shadow.getElementById('ended-overlay')) return;
    const overlay = el('div', { id: 'ended-overlay' });
    overlay.innerHTML =
      `<div class="ended-card">` +
      `  <strong>Napkin session ended.</strong>` +
      `  <p>You can close this tab.</p>` +
      `</div>`;
    shadow.appendChild(overlay);
  }

  // ─────────────────────────────────────────────
  // Init
  // ─────────────────────────────────────────────
  function init() {
    const host = document.createElement('div');
    host.id = HOST_ID;
    document.body.appendChild(host);

    const shadowRoot = host.attachShadow({ mode: 'open' });

    // Fetch annotate.css and inject into shadow root so it can't leak
    fetch(`${HTTP}/annotate.css?t=${TOKEN}`)
      .then(r => r.text())
      .then(css => {
        const style = document.createElement('style');
        style.textContent = css;
        shadowRoot.appendChild(style);
        buildUI(shadowRoot);
        connectWS();
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
