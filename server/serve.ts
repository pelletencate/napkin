/**
 * Napkin skill server — daemon + self-fork launcher.
 *
 * Works with:
 *   bun serve.ts start <session-dir>
 *   node --experimental-strip-types serve.ts start <session-dir>
 *
 * First invocation is launcher mode: forks self with NK_DAEMON=1,
 * reads NAPKIN_READY from child stdout, forwards it, exits 0.
 * The child (daemon) runs the HTTP/WS server and stays alive.
 */

import { spawn }                                                                  from 'child_process';
import { readFileSync, writeFileSync, mkdirSync, statSync, openSync, writeSync }  from 'fs';
import { createServer as netCreateServer }                                        from 'net';
import { join, dirname }                            from 'path';
import { fileURLToPath }                            from 'url';
import { randomBytes, createHash }                  from 'crypto';
import { createServer as httpCreateServer }         from 'http';
import type { IncomingMessage, ServerResponse }     from 'http';
import type { Socket }                              from 'net';

// ─────────────────────────────────────────────────────────────────────────────
// Runtime detection
// ─────────────────────────────────────────────────────────────────────────────
const IS_BUN = typeof (globalThis as any).Bun !== 'undefined';

// ─────────────────────────────────────────────────────────────────────────────
// File paths
// ─────────────────────────────────────────────────────────────────────────────
const __file    = fileURLToPath(import.meta.url);
const __dir     = dirname(__file);
const SKILL_DIR = dirname(__dir);           // server/ → napkin/
const ASSETS    = join(SKILL_DIR, 'assets');

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────
interface Annotation {
  id:          string;
  comment:     string;
  selector:    string;
  xpath:       string;
  tag:         string;
  classes:     string[];
  attributes:  Record<string, string>;
  textSnippet: string;
  rect:        { x: number; y: number; w: number; h: number };
  viewport:    { w: number; h: number; scrollY: number };
}

interface RouteResult {
  status:  number;
  headers: Record<string, string>;
  body:    string | Buffer | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Mutable server state (populated in startDaemon)
// ─────────────────────────────────────────────────────────────────────────────
let SESSION_DIR   = '';
let SESSION_TOKEN = '';
let SERVER_PORT   = 0;

const annotationQueue: Annotation[] = [];
let pendingPoll: { resolve: (a: Annotation | null) => void; timer: ReturnType<typeof setTimeout> } | null = null;
let shutdownTimer: ReturnType<typeof setTimeout> | null = null;
let sessionEnded = false;

// Mtime of proposal.html the last time we broadcast it (or served it at GET /).
// Used to skip redundant morph broadcasts when the agent's `connect` enters
// /wait but hasn't edited the file since the last push.
let lastBroadcastMtime = 0;

// Node WS clients; Bun uses a separate set below
const nodeWsClients = new Set<Socket>();
const bunWsClients  = new Set<any>();

// ─────────────────────────────────────────────────────────────────────────────
// WS broadcast helpers
// ─────────────────────────────────────────────────────────────────────────────
function broadcast(msg: object): void {
  const text = JSON.stringify(msg);
  if (IS_BUN) {
    for (const ws of bunWsClients) { try { ws.send(text); } catch {} }
  } else {
    for (const s of nodeWsClients) { try { nodeWsSend(s, text); } catch {} }
  }
}

function wsClientCount(): number {
  return IS_BUN ? bunWsClients.size : nodeWsClients.size;
}

function onWsOpen(sendFn: (t: string) => void): void {
  resetShutdownTimer();
  sendFn(JSON.stringify({ type: 'hello' }));
}

function onWsClose(): void {
  if (wsClientCount() === 0) startShutdownTimer();
}

// ─────────────────────────────────────────────────────────────────────────────
// Annotation queue
// ─────────────────────────────────────────────────────────────────────────────
function enqueue(ann: Annotation): void {
  if (pendingPoll) {
    const { resolve, timer } = pendingPoll;
    clearTimeout(timer);
    pendingPoll = null;
    broadcast({ type: 'agent-working' });
    resolve(ann);
    return;
  }
  annotationQueue.push(ann);
}

function dequeue(timeoutSec: number): Promise<Annotation | null> {
  if (annotationQueue.length > 0) {
    const item = annotationQueue.shift()!;
    broadcast({ type: 'agent-working' });
    return Promise.resolve(item);
  }
  // Cancel any stale poll
  if (pendingPoll) { clearTimeout(pendingPoll.timer); pendingPoll.resolve(null); }
  return new Promise(resolve => {
    const timer = setTimeout(() => { pendingPoll = null; resolve(null); }, timeoutSec * 1000);
    pendingPoll = { resolve, timer };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Shutdown timer
// ─────────────────────────────────────────────────────────────────────────────
function startShutdownTimer(): void {
  if (shutdownTimer) return;
  shutdownTimer = setTimeout(() => {
    try { writeFileSync(join(SESSION_DIR, 'done.json'), JSON.stringify({ reason: 'tab-closed', time: new Date().toISOString() })); } catch {}
    endSession();
    // Let the resolved /wait flush its 410 before we exit
    setTimeout(() => process.exit(0), 150);
  }, 15_000);
}

function resetShutdownTimer(): void {
  if (shutdownTimer) { clearTimeout(shutdownTimer); shutdownTimer = null; }
}

// End the session: signal any in-flight /wait long-poll to return 410.
// Called from the auto-shutdown timer and from /stop.
function endSession(): void {
  if (sessionEnded) return;
  sessionEnded = true;
  if (pendingPoll) {
    const { resolve, timer } = pendingPoll;
    clearTimeout(timer);
    pendingPoll = null;
    resolve(null);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Proposal push — reads proposal.html and broadcasts a morph to all WS
// clients. Called on every /wait entry; mtime-deduped so repeat polls during
// a single agent "round" don't re-broadcast unchanged content.
// ─────────────────────────────────────────────────────────────────────────────
function broadcastProposalIfChanged(): void {
  try {
    const p = join(SESSION_DIR, 'proposal.html');
    const mtime = statSync(p).mtimeMs;
    if (mtime === lastBroadcastMtime) return;
    lastBroadcastMtime = mtime;
    const html = injectOverlay(readFileSync(p, 'utf8'));
    const bodyMatch = html.match(/<body[^>]*>[\s\S]*<\/body>/i);
    broadcast({ type: 'morph', html: bodyMatch ? bodyMatch[0] : html });
    if (annotationQueue.length === 0) broadcast({ type: 'agent-ready' });
    else                              broadcast({ type: 'agent-working' });
  } catch { /* file missing or unreadable — skip silently */ }
}

// ─────────────────────────────────────────────────────────────────────────────
// HTML injection
// ─────────────────────────────────────────────────────────────────────────────
function injectOverlay(html: string): string {
  // Kit assets (decoration). Injected at serve time so proposal.html on disk
  // stays minimal — Tailwind + body, the LLM-readable deliverable.
  const kitFont  = `<link href="https://fonts.googleapis.com/css2?family=Gloria+Hallelujah&display=swap" rel="stylesheet">`;
  const kitRough = `<script src="https://cdn.jsdelivr.net/npm/roughjs@4.6.6/bundled/rough.js"></script>`;
  const kitCss   = `<link rel="stylesheet" href="/napkin-kit.css?t=${SESSION_TOKEN}">`;
  const kitJs    = `<script defer src="/napkin-kit.js?t=${SESSION_TOKEN}"></script>`;

  // Annotation overlay (interactive UI). Token-scoped so it can't be loaded
  // out of session.
  const config       = `<script>window.__NK_CONFIG={port:${SERVER_PORT},token:"${SESSION_TOKEN}"};</script>`;
  const annotateCss  = `<link rel="stylesheet" href="/annotate.css?t=${SESSION_TOKEN}">`;
  const annotateJs   = `<script src="/annotate.js?t=${SESSION_TOKEN}"></script>`;

  return html
    .replace(/<\/head>/i, `${kitFont}\n${kitRough}\n${kitCss}\n${kitJs}\n${config}\n${annotateCss}\n</head>`)
    .replace(/<\/body>/i, `${annotateJs}\n</body>`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Static assets
// ─────────────────────────────────────────────────────────────────────────────
const STATIC: Record<string, string> = {
  '/napkin-kit.css': join(ASSETS, 'napkin-kit.css'),
  '/napkin-kit.js':  join(ASSETS, 'napkin-kit.js'),
  '/annotate.css':      join(ASSETS, 'annotate.css'),
  '/annotate.js':       join(ASSETS, 'annotate.js'),
};
const MIME: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.js':  'text/javascript; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.png': 'image/png',
  '.json': 'application/json',
};
const mime = (p: string) => MIME[p.match(/\.[^.]+$/)?.[0] ?? ''] ?? 'application/octet-stream';

function checkToken(t: string | null): boolean {
  return t === SESSION_TOKEN;
}

// ─────────────────────────────────────────────────────────────────────────────
// Request router  (shared between Bun and Node)
// ─────────────────────────────────────────────────────────────────────────────
async function route(
  method:  string,
  urlStr:  string,
  headers: Record<string, string>,
  body:    string,
): Promise<RouteResult> {
  const url  = new URL(urlStr, `http://127.0.0.1:${SERVER_PORT}`);
  const path = url.pathname;
  const t    = url.searchParams.get('t') ?? headers['x-nk-token'] ?? null;

  // ── GET / ──────────────────────────────────────────────────────────────────
  if (method === 'GET' && path === '/') {
    if (!checkToken(t)) return { status: 401, headers: {}, body: 'Unauthorized' };
    try {
      const p = join(SESSION_DIR, 'proposal.html');
      // Record the mtime served so the first /wait push doesn't redundantly
      // re-broadcast the same content the browser just loaded.
      lastBroadcastMtime = statSync(p).mtimeMs;
      const html = injectOverlay(readFileSync(p, 'utf8'));
      return { status: 200, headers: { 'Content-Type': mime('.html') }, body: html };
    } catch {
      return { status: 404, headers: {}, body: 'proposal.html not found in session dir' };
    }
  }

  // ── Static assets ──────────────────────────────────────────────────────────
  const staticPath = STATIC[path];
  if (method === 'GET' && staticPath) {
    try {
      return { status: 200, headers: { 'Content-Type': mime(path), 'Cache-Control': 'no-store' }, body: readFileSync(staticPath) };
    } catch {
      return { status: 404, headers: {}, body: `Asset not found: ${path}` };
    }
  }

  // ── GET /wait — agent long-poll ────────────────────────────────────────────
  // Two responsibilities: (1) push any edits the agent made to proposal.html
  // since the last broadcast, then (2) block until an annotation arrives.
  // The agent's `connect` CLI is the only caller; it loops on this endpoint.
  if (method === 'GET' && path === '/wait') {
    if (!checkToken(t)) return { status: 401, headers: {}, body: 'Unauthorized' };
    if (sessionEnded) return { status: 410, headers: { 'Content-Type': mime('.json') }, body: JSON.stringify({ ended: true }) };
    broadcastProposalIfChanged();
    const raw = Number(url.searchParams.get('timeout'));
    const timeout = Number.isFinite(raw) && raw > 0 ? Math.min(raw, 310) : 300;
    const ann = await dequeue(timeout);
    if (sessionEnded) return { status: 410, headers: { 'Content-Type': mime('.json') }, body: JSON.stringify({ ended: true }) };
    if (ann === null) return { status: 204, headers: { 'Content-Type': mime('.json') }, body: JSON.stringify({ retry: true }) };
    return { status: 200, headers: { 'Content-Type': mime('.json') }, body: JSON.stringify(ann) };
  }

  // ── POST /annotation ───────────────────────────────────────────────────────
  if (method === 'POST' && path === '/annotation') {
    if (!checkToken(headers['x-nk-token'] ?? null)) return { status: 401, headers: {}, body: 'Unauthorized' };
    try {
      const data = JSON.parse(body);
      const ann: Annotation = { id: randomBytes(8).toString('hex'), ...data };
      enqueue(ann);
      return { status: 202, headers: { 'Content-Type': mime('.json') }, body: JSON.stringify({ id: ann.id }) };
    } catch {
      return { status: 400, headers: {}, body: 'Invalid JSON' };
    }
  }

  // ── POST /stop ─────────────────────────────────────────────────────────────
  if (method === 'POST' && path === '/stop') {
    if (!checkToken(headers['x-nk-token'] ?? null)) return { status: 401, headers: {}, body: 'Unauthorized' };
    try { writeFileSync(join(SESSION_DIR, 'done.json'), JSON.stringify({ reason: 'stop-requested', time: new Date().toISOString() })); } catch {}
    endSession();
    setTimeout(() => process.exit(0), 200).unref();
    return { status: 204, headers: {}, body: null };
  }

  return { status: 404, headers: {}, body: 'Not found' };
}

// ─────────────────────────────────────────────────────────────────────────────
// Node.js WebSocket — RFC 6455 (no deps)
// ─────────────────────────────────────────────────────────────────────────────
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function nodeWsAccept(key: string): string {
  return createHash('sha1').update(key + WS_GUID).digest('base64');
}

function nodeWsSend(socket: Socket, text: string): void {
  const payload = Buffer.from(text, 'utf8');
  const len = payload.length;
  let hdr: Buffer;
  if (len < 126) {
    hdr = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    hdr = Buffer.allocUnsafe(4);
    hdr[0] = 0x81; hdr[1] = 126;
    hdr.writeUInt16BE(len, 2);
  } else {
    hdr = Buffer.allocUnsafe(10);
    hdr[0] = 0x81; hdr[1] = 127;
    hdr.writeUInt32BE(0, 2);
    hdr.writeUInt32BE(len, 6);
  }
  socket.write(Buffer.concat([hdr, payload]));
}

interface WsFrame { opcode: number; frameLen: number; }

function parseWsFrame(buf: Buffer): WsFrame | null {
  if (buf.length < 2) return null;
  const masked = (buf[1] & 0x80) !== 0;
  let payLen = buf[1] & 0x7f;
  let offset = 2;
  if (payLen === 126) { if (buf.length < 4) return null; payLen = buf.readUInt16BE(2); offset = 4; }
  else if (payLen === 127) { if (buf.length < 10) return null; payLen = buf.readUInt32BE(6); offset = 10; }
  if (masked) offset += 4;
  if (buf.length < offset + payLen) return null;
  return { opcode: buf[0] & 0x0f, frameLen: offset + payLen };
}

function attachNodeWs(socket: Socket, req: IncomingMessage): void {
  const key = (req.headers as any)['sec-websocket-key'] as string;
  if (!key) { socket.destroy(); return; }
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${nodeWsAccept(key)}\r\n\r\n`,
  );

  nodeWsClients.add(socket);
  onWsOpen(t => nodeWsSend(socket, t));

  let buf = Buffer.alloc(0);
  socket.on('data', chunk => {
    buf = Buffer.concat([buf, chunk]);
    let frame: WsFrame | null;
    while ((frame = parseWsFrame(buf)) !== null) {
      const { opcode, frameLen } = frame;
      buf = buf.subarray(frameLen);
      if (opcode === 0x8) { socket.destroy(); return; } // close
      // 0x9=ping, 0xA=pong, 0x1/0x2=text/binary — ignore all from client
    }
  });
  socket.on('close', () => { nodeWsClients.delete(socket); onWsClose(); });
  socket.on('error', () => { nodeWsClients.delete(socket); });
}

// ─────────────────────────────────────────────────────────────────────────────
// Node HTTP server
// ─────────────────────────────────────────────────────────────────────────────
async function startNodeServer(port: number): Promise<number> {
  const server = httpCreateServer(async (req: IncomingMessage, res: ServerResponse) => {
    let body = '';
    for await (const chunk of req) body += chunk;

    const hdrs: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === 'string') hdrs[k.toLowerCase()] = v;
    }

    const result = await route(req.method ?? 'GET', req.url ?? '/', hdrs, body);
    res.writeHead(result.status, result.headers);
    result.body !== null ? res.end(result.body) : res.end();
  });

  server.on('upgrade', (req: IncomingMessage, socket: Socket) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1`);
    if (url.pathname !== '/ws') { socket.destroy(); return; }
    const t = url.searchParams.get('t') ?? (req.headers as any)['x-nk-token'];
    if (!checkToken(t)) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
    attachNodeWs(socket, req);
  });

  await new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve));
  return (server.address() as any).port as number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Bun server
// ─────────────────────────────────────────────────────────────────────────────
async function startBunServer(port: number): Promise<number> {
  const Bun = (globalThis as any).Bun;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port,
    // /wait long-polls for up to 310s. Bun's default idleTimeout (10s) would
    // close those connections mid-poll, causing curl exit 52 ("Empty reply
    // from server") on the agent side. 0 disables the timeout entirely.
    idleTimeout: 0,
    async fetch(req: Request, srv: any) {
      const url = new URL(req.url);

      // WebSocket upgrade
      if (req.headers.get('upgrade') === 'websocket' && url.pathname === '/ws') {
        const t = url.searchParams.get('t') ?? req.headers.get('x-nk-token');
        if (!checkToken(t)) return new Response('Unauthorized', { status: 401 });
        srv.upgrade(req);
        return;
      }

      const hdrs: Record<string, string> = {};
      req.headers.forEach((v: string, k: string) => { hdrs[k.toLowerCase()] = v; });
      const needsBody = ['POST', 'PUT', 'PATCH'].includes(req.method);
      const body = needsBody ? await req.text() : '';
      const result = await route(req.method, req.url, hdrs, body);
      return new Response(result.body as any, { status: result.status, headers: result.headers });
    },
    websocket: {
      open(ws: any) {
        bunWsClients.add(ws);
        onWsOpen(t => ws.send(t));
      },
      message(_ws: any, _data: any) { /* only pongs expected; ignored */ },
      close(ws: any) { bunWsClients.delete(ws); onWsClose(); },
    },
  });
  return server.port as number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Daemon startup
//
// The launcher has already chosen the port and token (and written them to
// server.json) before forking us. We just bind, attach handlers, and serve.
// ─────────────────────────────────────────────────────────────────────────────
async function startDaemon(sessionDir: string): Promise<void> {
  SESSION_DIR   = sessionDir;
  SESSION_TOKEN = process.env.NK_TOKEN ?? '';
  const port    = Number(process.env.NK_PORT) || 0;
  if (!SESSION_TOKEN || !port) {
    process.stderr.write('[napkin] daemon: missing NK_TOKEN or NK_PORT in env\n');
    process.exit(1);
  }

  SERVER_PORT = IS_BUN ? await startBunServer(port) : await startNodeServer(port);

  // Heartbeat every 15s
  const heartbeat = setInterval(() => broadcast({ type: 'ping' }), 15_000);
  heartbeat.unref();
}

// ─────────────────────────────────────────────────────────────────────────────
// Allocate a free TCP port by briefly binding port 0 on 127.0.0.1, reading
// the kernel-assigned port, and closing. There's a microsecond window where
// another process could grab it before the daemon re-binds, but on localhost
// dev machines that's essentially never an issue.
// ─────────────────────────────────────────────────────────────────────────────
function allocateFreePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const srv = netCreateServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (!addr || typeof addr === 'string') { srv.close(); reject(new Error('no address')); return; }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Launcher — the foreground process attached to the caller's terminal.
//
// 1. Allocates a port + token,
// 2. Writes server.json (the source of truth for stop/connect),
// 3. Prints the openable URL on stdout via writeSync(fd 1) — bypasses Bun's
//    Writable buffering so the line is visible before we exit,
// 4. Spawns a detached copy of ourselves with NK_DAEMON=1 to become the
//    daemon (inherits port + token via env),
// 5. Exits.
// ─────────────────────────────────────────────────────────────────────────────
async function runLauncher(sessionDir: string): Promise<void> {
  mkdirSync(sessionDir, { recursive: true });

  const port  = await allocateFreePort();
  const token = randomBytes(16).toString('hex');

  writeFileSync(
    join(sessionDir, 'server.json'),
    JSON.stringify({ port, token }),
  );

  writeSync(1, `NAPKIN_READY http://127.0.0.1:${port}/?t=${token}\n`);

  // Daemon stderr → daemon.err in session dir so crashes/diagnostics aren't
  // lost. Truncates each new session.
  const errFd = openSync(join(sessionDir, 'daemon.err'), 'w');

  const args = [...process.execArgv, ...process.argv.slice(1)];
  spawn(process.execPath, args, {
    detached: true,
    stdio: ['ignore', 'ignore', errFd],
    env: { ...process.env, NK_DAEMON: '1', NK_PORT: String(port), NK_TOKEN: token },
  }).unref();

  process.exit(0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Connect (client) — looped by the agent. One call = one annotation.
//
// Reads server.json from the session dir, long-polls /wait with a short
// timeout, retries silently on 204, prints the annotation JSON on stdout
// when one arrives. Exit codes:
//
//   0 — annotation on stdout
//   1 — session ended cleanly (tab closed or /stop)
//   2 — server unreachable or unexpected response (message on stderr)
//
// The /wait handler pushes the current proposal.html to the browser on entry,
// so there is no separate "I'm done revising" step — calling connect is the
// signal.
// ─────────────────────────────────────────────────────────────────────────────
async function runConnect(sessionDir: string): Promise<never> {
  let info: { port: number; token: string };
  try {
    info = JSON.parse(readFileSync(join(sessionDir, 'server.json'), 'utf8'));
  } catch (e: any) {
    process.stderr.write(`napkin: could not read ${sessionDir}/server.json (${e?.message ?? e})\n`);
    process.exit(2);
  }
  const { port, token } = info;

  // Short server-side timeout keeps us under any client fetch headers timeout
  // (Node undici's default is 5 min on recent versions but was 30s on older
  // ones; staying well under that is harmless). The agent never sees the
  // retries — we only exit on a terminal status.
  while (true) {
    let res: Response;
    try {
      res = await fetch(`http://127.0.0.1:${port}/wait?timeout=25`, {
        headers: { 'X-NK-Token': token },
      });
    } catch (e: any) {
      process.stderr.write(`napkin: server unreachable (${e?.message ?? e})\n`);
      process.exit(2);
    }

    if (res.status === 200) {
      process.stdout.write(await res.text());
      process.stdout.write('\n');
      process.exit(0);
    }
    if (res.status === 204) continue;
    if (res.status === 410) {
      process.stderr.write('napkin: session ended\n');
      process.exit(1);
    }
    process.stderr.write(`napkin: unexpected HTTP ${res.status}\n`);
    process.exit(2);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────
const [cmd, sessionDir = './.napkin-session'] = process.argv.slice(2);

if (cmd === 'serve') {
  if (process.env.NK_DAEMON === '1') {
    startDaemon(sessionDir).catch(err => {
      process.stderr.write(`[napkin] ${err}\n`);
      process.exit(1);
    });
  } else {
    runLauncher(sessionDir).catch(err => {
      process.stderr.write(`[napkin] ${err}\n`);
      process.exit(1);
    });
  }
} else if (cmd === 'connect') {
  runConnect(sessionDir).catch(err => {
    process.stderr.write(`[napkin] ${err}\n`);
    process.exit(2);
  });
} else {
  process.stderr.write('Usage: serve.ts (serve|connect) <session-dir>\n');
  process.exit(1);
}
