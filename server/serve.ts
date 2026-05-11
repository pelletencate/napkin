/**
 * Wireframe skill server — daemon + self-fork launcher.
 *
 * Works with:
 *   bun serve.ts start <session-dir>
 *   node --experimental-strip-types serve.ts start <session-dir>
 *
 * First invocation is launcher mode: forks self with WF_DAEMON=1,
 * reads WIREFRAME_READY from child stdout, forwards it, exits 0.
 * The child (daemon) runs the HTTP/WS server and stays alive.
 */

import { spawn, exec }                              from 'child_process';
import { readFileSync, writeFileSync, mkdirSync }   from 'fs';
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
const SKILL_DIR = dirname(__dir);           // server/ → wireframe/
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

// Node WS clients; Bun uses a separate set below
const nodeWsClients = new Set<Socket>();
const bunWsClients  = new Set<any>();

// Promise that resolves once the first WS client connects
let wsReadyResolve: (() => void) | null = null;
const wsFirstConnect = new Promise<void>(r => { wsReadyResolve = r; });

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
  if (wsReadyResolve) { wsReadyResolve(); wsReadyResolve = null; }
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
// HTML injection
// ─────────────────────────────────────────────────────────────────────────────
function injectOverlay(html: string): string {
  // Kit assets (decoration). Injected at serve time so proposal.html on disk
  // stays minimal — Tailwind + body, the LLM-readable deliverable.
  const kitFont  = `<link href="https://fonts.googleapis.com/css2?family=Gloria+Hallelujah&display=swap" rel="stylesheet">`;
  const kitRough = `<script src="https://cdn.jsdelivr.net/npm/roughjs@4.6.6/bundled/rough.js"></script>`;
  const kitCss   = `<link rel="stylesheet" href="/wireframe-kit.css?t=${SESSION_TOKEN}">`;
  const kitJs    = `<script defer src="/wireframe-kit.js?t=${SESSION_TOKEN}"></script>`;

  // Annotation overlay (interactive UI). Token-scoped so it can't be loaded
  // out of session.
  const config       = `<script>window.__WF_CONFIG={port:${SERVER_PORT},token:"${SESSION_TOKEN}"};</script>`;
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
  '/wireframe-kit.css': join(ASSETS, 'wireframe-kit.css'),
  '/wireframe-kit.js':  join(ASSETS, 'wireframe-kit.js'),
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
  const t    = url.searchParams.get('t') ?? headers['x-wf-token'] ?? null;

  // ── GET / ──────────────────────────────────────────────────────────────────
  if (method === 'GET' && path === '/') {
    if (!checkToken(t)) return { status: 401, headers: {}, body: 'Unauthorized' };
    try {
      const html = injectOverlay(readFileSync(join(SESSION_DIR, 'proposal.html'), 'utf8'));
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
  if (method === 'GET' && path === '/wait') {
    if (!checkToken(t)) return { status: 401, headers: {}, body: 'Unauthorized' };
    if (sessionEnded) return { status: 410, headers: { 'Content-Type': mime('.json') }, body: JSON.stringify({ ended: true }) };
    const raw = Number(url.searchParams.get('timeout'));
    const timeout = Number.isFinite(raw) && raw > 0 ? Math.min(raw, 310) : 300;
    const ann = await dequeue(timeout);
    if (sessionEnded) return { status: 410, headers: { 'Content-Type': mime('.json') }, body: JSON.stringify({ ended: true }) };
    if (ann === null) return { status: 204, headers: { 'Content-Type': mime('.json') }, body: JSON.stringify({ retry: true }) };
    return { status: 200, headers: { 'Content-Type': mime('.json') }, body: JSON.stringify(ann) };
  }

  // ── POST /annotation ───────────────────────────────────────────────────────
  if (method === 'POST' && path === '/annotation') {
    if (!checkToken(headers['x-wf-token'] ?? null)) return { status: 401, headers: {}, body: 'Unauthorized' };
    try {
      const data = JSON.parse(body);
      const ann: Annotation = { id: randomBytes(8).toString('hex'), ...data };
      enqueue(ann);
      return { status: 202, headers: { 'Content-Type': mime('.json') }, body: JSON.stringify({ id: ann.id }) };
    } catch {
      return { status: 400, headers: {}, body: 'Invalid JSON' };
    }
  }

  // ── POST /revised ──────────────────────────────────────────────────────────
  if (method === 'POST' && path === '/revised') {
    if (!checkToken(headers['x-wf-token'] ?? null)) return { status: 401, headers: {}, body: 'Unauthorized' };
    try {
      const html = injectOverlay(readFileSync(join(SESSION_DIR, 'proposal.html'), 'utf8'));
      const bodyMatch = html.match(/<body[^>]*>[\s\S]*<\/body>/i);
      broadcast({ type: 'morph', html: bodyMatch ? bodyMatch[0] : html });
      if (annotationQueue.length === 0) broadcast({ type: 'agent-ready' });
      else                              broadcast({ type: 'agent-working' });
    } catch {
      return { status: 500, headers: {}, body: 'Could not read proposal.html' };
    }
    return { status: 204, headers: {}, body: null };
  }

  // ── POST /stop ─────────────────────────────────────────────────────────────
  if (method === 'POST' && path === '/stop') {
    if (!checkToken(headers['x-wf-token'] ?? null)) return { status: 401, headers: {}, body: 'Unauthorized' };
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
async function startNodeServer(): Promise<number> {
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
    const t = url.searchParams.get('t') ?? (req.headers as any)['x-wf-token'];
    if (!checkToken(t)) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
    attachNodeWs(socket, req);
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as any).port as number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Bun server
// ─────────────────────────────────────────────────────────────────────────────
async function startBunServer(): Promise<number> {
  const Bun = (globalThis as any).Bun;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req: Request, srv: any) {
      const url = new URL(req.url);

      // WebSocket upgrade
      if (req.headers.get('upgrade') === 'websocket' && url.pathname === '/ws') {
        const t = url.searchParams.get('t') ?? req.headers.get('x-wf-token');
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
// Browser open
//
// Called from the LAUNCHER, not the detached daemon. On macOS, `open URL` from
// a detached/unrefed subprocess loses the user's LaunchServices session
// context and falls back to Safari regardless of the registered http handler.
// The launcher is still attached to the agent's shell, so its `open` honors
// the user's actual default browser.
// ─────────────────────────────────────────────────────────────────────────────
function openBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? `open "${url}"`
            : process.platform === 'win32'  ? `start "" "${url}"`
            : `xdg-open "${url}" 2>/dev/null || true`;
  exec(cmd, () => {/* best-effort */});
}

// ─────────────────────────────────────────────────────────────────────────────
// Daemon startup
// ─────────────────────────────────────────────────────────────────────────────
async function startDaemon(sessionDir: string): Promise<void> {
  SESSION_DIR   = sessionDir;
  SESSION_TOKEN = randomBytes(16).toString('hex');
  SERVER_PORT   = IS_BUN ? await startBunServer() : await startNodeServer();

  mkdirSync(SESSION_DIR, { recursive: true });
  // Minified — bin/wireframe parses this with grep, which assumes no whitespace
  // between key and value.
  writeFileSync(
    join(SESSION_DIR, 'server.json'),
    JSON.stringify({ port: SERVER_PORT, token: SESSION_TOKEN, pid: process.pid }),
  );

  // Heartbeat every 15s
  const heartbeat = setInterval(() => broadcast({ type: 'ping' }), 15_000);
  heartbeat.unref();

  // Tell the launcher we're listening so IT can open the browser. The daemon
  // does NOT call openBrowser itself — see comment above openBrowser().
  const browserUrl = `http://127.0.0.1:${SERVER_PORT}/?t=${SESSION_TOKEN}`;
  process.stdout.write(`WIREFRAME_LISTEN ${browserUrl}\n`);

  // Wait for first browser WS connection (up to 30s)
  await Promise.race([
    wsFirstConnect,
    new Promise<void>(r => setTimeout(r, 30_000)),
  ]);

  // Signal ready — launcher is reading this line
  process.stdout.write(`WIREFRAME_READY http://127.0.0.1:${SERVER_PORT} token=${SESSION_TOKEN}\n`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Launcher mode — forks daemon, opens browser on LISTEN, relays READY, exits
// ─────────────────────────────────────────────────────────────────────────────
function runLauncher(sessionDir: string): void {
  const args = [...process.execArgv, ...process.argv.slice(1)];
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, WF_DAEMON: '1' },
  });
  child.unref();

  // Give up after 60s
  const giveUp = setTimeout(() => {
    process.stderr.write('[wireframe] timed out waiting for server to start\n');
    process.exit(1);
  }, 60_000);
  giveUp.unref();

  let buf = '';
  let opened = false;
  child.stdout!.on('data', (chunk: Buffer) => {
    buf += chunk.toString();
    let nl: number;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);

      if (!opened && line.startsWith('WIREFRAME_LISTEN ')) {
        opened = true;
        const url = line.slice('WIREFRAME_LISTEN '.length).trim();
        if (url) openBrowser(url);
        continue;
      }

      if (line.startsWith('WIREFRAME_READY')) {
        clearTimeout(giveUp);
        process.stdout.write(line + '\n');
        child.stdout!.destroy();
        process.exit(0);
      }
    }
  });

  child.on('exit', (code: number | null) => {
    if (code !== null && code !== 0) {
      process.stderr.write(`[wireframe] server exited with code ${code}\n`);
      process.exit(1);
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────
const [cmd, sessionDir = './.wireframe-session'] = process.argv.slice(2);

if (cmd !== 'start') {
  process.stderr.write('Usage: serve.ts start <session-dir>\n');
  process.exit(1);
}

if (process.env.WF_DAEMON === '1') {
  startDaemon(sessionDir).catch(err => {
    process.stderr.write(`[wireframe] ${err}\n`);
    process.exit(1);
  });
} else {
  runLauncher(sessionDir);
}
