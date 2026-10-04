#!/usr/bin/env node
/**
 * cdp-probe.mjs — zero-dependency Chrome DevTools Protocol probe.
 *
 * Works against any CDP endpoint:
 *   - QtWebEngine with QWEBENGINE_REMOTE_DEBUGGING=<port>
 *   - NW.js / Chrome / Electron with --remote-debugging-port=<port>
 *   - Node / NW.js with --inspect (port 9229)
 *
 * Requires Node >= 21 (global fetch + global WebSocket). No npm installs.
 *
 * Usage:
 *   node scripts/cdp-probe.mjs --port 9222
 *       -> list targets (GET /json/list)
 *
 *   node scripts/cdp-probe.mjs --port 9222 --expr "1+1"
 *       -> Runtime.evaluate on the first 'page' target
 *
 *   node scripts/cdp-probe.mjs --port 9222 --expr "typeof DataManager" --target nwjs
 *       -> --target filters targets by substring match on url/title/type
 *
 *   node scripts/cdp-probe.mjs --port 9222 --eval-all --expr "location.href"
 *       -> run against EVERY reachable target (finds the interesting context)
 *
 *   node scripts/cdp-probe.mjs --port 9222 --probe
 *       -> run the built-in RPG Maker global probe against every target
 *
 *   node scripts/cdp-probe.mjs --host 127.0.0.1 --port 9222 --wait 30 --expr "1+1"
 *       -> poll for the endpoint to come up for 30s first
 *
 *   node scripts/cdp-probe.mjs --ws "ws://127.0.0.1:9222/devtools/page/ABCD" --expr "1+1"
 *       -> connect straight to a socket URL, skipping discovery
 *
 * Exit codes: 0 ok, 1 no endpoint / no targets, 2 eval error, 3 bad args.
 */

import { parseArgs } from 'node:util';

// Written in ES5 and avoiding `globalThis`: QtWebEngine 5.12 embeds Chromium 69,
// where `globalThis` does not exist yet. `typeof x` is used instead of eval lookups
// on window so that undeclared names never throw.
const RPGMAKER_PROBE_EXPR = `(function () {
  var names = ['DataManager','DataLoader','Game_Map','Game_Event','Scene_Manager','Scene_Map',
    'Scene_File','EditorExtend','EditorCommand','$editor','$dataMap','$dataMapInfos','$dataInfos',
    '$dataActors','$dataSystem','$dataCommonEvents','$dataTerms','$dataTroops','$gameMap',
    '$gameVariables','Graphics','Sprite','Bitmap','Window_Base','ConfigManager','StorageManager',
    'Utils','JsonEx','Qt','qrc','require','process','module','nw','chrome','cef'];
  var out = {};
  for (var i = 0; i < names.length; i++) {
    var n = names[i];
    try { out[n] = eval('typeof ' + n); } catch (e) { out[n] = 'threw: ' + e.message; }
  }
  var w = (typeof window !== 'undefined') ? window : null;
  var keys = 0, sample = [];
  try { if (w) { var ks = Object.keys(w); keys = ks.length; sample = ks.slice(0, 60); } } catch (e) {}
  return JSON.stringify({
    href: (typeof location !== 'undefined') ? String(location.href) : null,
    title: (typeof document !== 'undefined') ? String(document.title) : null,
    ua: (typeof navigator !== 'undefined') ? String(navigator.userAgent) : null,
    hasDocument: typeof document !== 'undefined',
    hasWindow: !!w,
    readyState: (typeof document !== 'undefined') ? String(document.readyState) : null,
    domChildren: (typeof document !== 'undefined' && document.body) ? document.body.children.length : null,
    globalsSeen: keys,
    sampleKeys: sample,
    typeofs: out
  }, null, 2);
})()`;

function usage(msg) {
  if (msg) console.error('error: ' + msg);
  console.error(
    [
      'usage: node scripts/cdp-probe.mjs [--host H] --port N [--expr E | --probe]',
      '        [--target SUBSTR] [--eval-all] [--wait SEC] [--ws URL] [--timeout MS]',
      '        [--json] [--list]',
    ].join('\n')
  );
  process.exit(3);
}

const { values: opt } = parseArgs({
  options: {
    host: { type: 'string', default: '127.0.0.1' },
    port: { type: 'string' },
    ws: { type: 'string' },
    expr: { type: 'string' },
    target: { type: 'string' },
    'eval-all': { type: 'boolean', default: false },
    probe: { type: 'boolean', default: false },
    list: { type: 'boolean', default: false },
    wait: { type: 'string', default: '0' },
    timeout: { type: 'string', default: '10000' },
    json: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
  allowPositionals: false,
});

if (opt.help) usage();
if (!opt.ws && !opt.port) usage('need --port or --ws');

const TIMEOUT = Number(opt.timeout);
if (!Number.isFinite(TIMEOUT) || TIMEOUT <= 0) usage('--timeout must be a positive number');

function base() {
  return `http://${opt.host}:${opt.port}`;
}

/** Fetch a CDP HTTP endpoint, optionally polling until --wait seconds elapse. */
async function getJson(pathname, waitSec) {
  const deadline = Date.now() + waitSec * 1000;
  let lastErr = null;
  for (;;) {
    try {
      const r = await fetch(base() + pathname, { signal: AbortSignal.timeout(4000) });
      const text = await r.text();
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0, 200)}`);
      return JSON.parse(text);
    } catch (e) {
      lastErr = e;
      if (Date.now() >= deadline) break;
      await new Promise((res) => setTimeout(res, 500));
    }
  }
  throw new Error(
    `cannot reach CDP endpoint ${base()}${pathname}: ${lastErr && lastErr.message}\n` +
      `(is something listening? try: curl -s ${base()}/json/version)`
  );
}

/** Minimal promise-based CDP client over the global WebSocket. */
class Cdp {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
  }
  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;
      const boom = (m) => reject(new Error(m));
      ws.onerror = (e) => boom(`websocket error on ${this.wsUrl}: ${e.message || 'unknown'}`);
      ws.onopen = () => resolve();
      ws.onmessage = (ev) => {
        let msg;
        try {
          msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
        } catch {
          return;
        }
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const { resolve: res, reject: rej, timer } = this.pending.get(msg.id);
          clearTimeout(timer);
          this.pending.delete(msg.id);
          if (msg.error) rej(new Error(JSON.stringify(msg.error)));
          else res(msg.result);
        } else if (msg.method) {
          this.events.push(msg);
        }
      };
      ws.onclose = (e) => {
        for (const { reject: rej, timer } of this.pending.values()) {
          clearTimeout(timer);
          rej(new Error(`websocket closed (code ${e.code})`));
        }
        this.pending.clear();
      };
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout after ${TIMEOUT}ms waiting for ${method}`));
      }, TIMEOUT);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }
  close() {
    try {
      this.ws && this.ws.close();
    } catch {}
  }
}

/** Runtime.evaluate that understands exceptions and non-string returns. */
async function evaluate(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  });
  const res = r.result || {};
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    const text =
      (d.exception && (d.exception.description || d.exception.value)) || d.text || 'unknown';
    return { ok: false, error: String(text), subtype: d.exception && d.exception.subtype };
  }
  let value = res.value;
  if (value === undefined) value = res.description || `[${res.type}]`;
  return { ok: true, type: res.type, subtype: res.subtype, value };
}

function pickTargets(targets) {
  const filter = opt.target ? opt.target.toLowerCase() : null;
  let list = targets.filter((t) => t.webSocketDebuggerUrl);
  if (filter) {
    list = list.filter((t) =>
      [t.url, t.title, t.type, t.description].filter(Boolean).join(' ').toLowerCase().includes(filter)
    );
  }
  if (!opt.evalAll && !filter) {
    const page = list.find((t) => t.type === 'page');
    list = page ? [page] : list.slice(0, 1);
  }
  return list;
}

async function main() {
  const waitSec = Number(opt.wait);
  let targets;
  if (opt.ws) {
    targets = [{ webSocketDebuggerUrl: opt.ws, url: '(direct ws)', type: 'page', title: '' }];
  } else {
    targets = await getJson('/json/list', waitSec);
  }

  if (!Array.isArray(targets)) targets = [targets];

  if (opt.list || (!opt.expr && !opt.probe)) {
    console.log(`# ${targets.length} target(s) from ${opt.ws ? opt.ws : base() + '/json/list'}`);
    for (const t of targets) {
      console.log(
        `- [${t.type}] ${t.title || '(no title)'}\n    url:   ${t.url}\n    ws:    ${t.webSocketDebuggerUrl || '(none)'}\n    id:    ${t.id}`
      );
    }
    if (!targets.length) {
      console.log('(endpoint answered but listed no targets)');
      process.exit(1);
    }
  }

  const exprs = [];
  if (opt.probe) exprs.push({ label: 'rpgmaker-probe', expr: RPGMAKER_PROBE_EXPR });
  if (opt.expr) exprs.push({ label: 'expr', expr: opt.expr });
  if (!exprs.length) return;

  const chosen = pickTargets(targets);
  if (!chosen.length) {
    console.error('no target with a webSocketDebuggerUrl matched the filter');
    process.exit(1);
  }

  let failures = 0;
  for (const t of chosen) {
    const cdp = new Cdp(t.webSocketDebuggerUrl);
    const head = `[${t.type}] ${t.title || t.url}`;
    try {
      await cdp.connect();
    } catch (e) {
      console.error(`${head}\n  CONNECT FAILED: ${e.message}`);
      failures++;
      continue;
    }
    console.log(`\n== ${head}\n   url: ${t.url}`);
    for (const { label, expr } of exprs) {
      try {
        const out = await evaluate(cdp, expr);
        if (out.ok) {
          if (opt.json) {
            console.log(JSON.stringify({ target: t.url, label, ok: true, value: out.value }));
          } else {
            console.log(`  ${label} => ${typeof out.value === 'string' ? out.value : JSON.stringify(out.value)}`);
          }
        } else {
          failures++;
          console.log(`  ${label} => EXCEPTION: ${out.error}`);
        }
      } catch (e) {
        failures++;
        console.log(`  ${label} => ERROR: ${e.message}`);
      }
    }
    cdp.close();
  }
  process.exit(failures && failures === chosen.length ? 2 : 0);
}

main().catch((e) => {
  console.error(String(e && e.message ? e.message : e));
  process.exit(1);
});
