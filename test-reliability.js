// kapı — reliability regression suite (node:test, Node >= 20, built-ins only).
// Every runtime test talks ONLY to synthetic, owned, random-port loopback fixtures.
// No config/env files, no real keys or providers, no CLI spawn. Temp files live under os.tmpdir().
//
// Root contracts encoded here:
//  - routing.timeout_ms is a TOTAL per-attempt deadline that includes the JSON body or the SSE body.
//    It is never an idle timer, so a continuous drip must still time out.
//  - A downstream disconnect (res 'close' before writableFinished) cancels the upstream.
//    The ordinary end of the request body never cancels a healthy response.
//  - Fallback applies to anything that fails before the first downstream byte.
//    After the first byte: no fallback, a terminal error frame, no fake [DONE], and a failed audit status.
//  - With global redact_pii enabled, model-default masking stays on for every non-Ollama provider, even on loopback.
//    Remote Ollama is masked; default or loopback Ollama is exempt; an explicit `redact` setting wins.
//  - Anthropic success requires message_stop, not merely message_delta(end_turn).
//    Malformed JSON events are failures even when followed by otherwise valid stop events.
//  - Provider redirects are rejected before contacting another origin with a prompt or credential.
//  - Errors returned to clients carry the public alias. They never carry the provider model name or a token.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateway } from './src/core/server.js';
import { resolveTypes } from './src/security/pii.js';
import { loadConfig, ConfigError } from './src/core/config.js';

const realFetch = globalThis.fetch;
const KINDS = ['openai', 'ollama', 'anthropic'];
const PATHS = { openai: '/chat/completions', ollama: '/v1/chat/completions', anthropic: '/v1/messages' };
const enc = new TextEncoder();
const SECRET = 'sk-fake-stream-secret-0042';

function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

// Per-test resource scope: timers, intervals, servers, global patches, temp dirs.
// Cleanup runs even when an assertion fails.
function scope(t) {
  const servers = [];
  const timers = new Set();
  const intervals = new Set();
  const defers = [];
  const finals = [];
  const s = {
    timer(fn, ms) {
      const h = setTimeout(() => {
        timers.delete(h);
        fn();
      }, ms);
      timers.add(h);
      return h;
    },
    interval(fn, ms) {
      const h = setInterval(fn, ms);
      intervals.add(h);
      return h;
    },
    sleep(ms) {
      return new Promise((r) => s.timer(r, ms));
    },
    async within(p, ms) {
      let h;
      const to = new Promise((r) => {
        h = s.timer(() => r(false), ms);
      });
      const ok = await Promise.race([Promise.resolve(p).then(() => true, () => true), to]);
      clearTimeout(h);
      return ok;
    },
    async poll(fn, ms = 1500, step = 20) {
      const end = Date.now() + ms;
      for (;;) {
        const v = fn();
        if (v) return v;
        if (Date.now() > end) return v;
        await s.sleep(step);
      }
    },
    defer(fn) {
      defers.push(fn);
    },
    final(fn) {
      finals.push(fn);
    },
    async listen(srv) {
      servers.push(srv);
      await new Promise((res, rej) => {
        srv.once('error', rej);
        srv.listen(0, '127.0.0.1', () => {
          srv.off('error', rej);
          res();
        });
      });
      return `http://127.0.0.1:${srv.address().port}`;
    },
    async cleanup() {
      for (const h of timers) clearTimeout(h);
      timers.clear();
      for (const h of intervals) clearInterval(h);
      intervals.clear();
      for (const fn of defers.splice(0).reverse()) {
        try {
          await fn();
        } catch {}
      }
      for (const srv of servers.splice(0)) {
        try {
          srv.closeAllConnections?.();
        } catch {}
        await new Promise((r) => {
          const h = setTimeout(r, 1000);
          h.unref?.();
          try {
            srv.close(() => {
              clearTimeout(h);
              r();
            });
          } catch {
            clearTimeout(h);
            r();
          }
        });
      }
      for (const fn of finals.splice(0)) {
        try {
          await fn();
        } catch {}
      }
    },
  };
  t.after(() => s.cleanup());
  return s;
}

// Owned fixture upstream. Drains the request fully, records it, then hands off to the handler.
// rec.aborted = the response closed before it finished, i.e. the gateway cancelled it.
async function upstream(s, handler) {
  const closed = deferred();
  const rec = { calls: 0, bodies: [], urls: [], headers: [], aborted: false, gate: deferred(), closed: closed.promise };
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (c) => {
      raw += c;
    });
    req.on('end', () => {
      rec.calls++;
      let body = {};
      try {
        body = JSON.parse(raw || '{}');
      } catch {}
      rec.bodies.push(body);
      rec.urls.push(req.url);
      rec.headers.push(req.headers);
      res.on('close', () => {
        if (!res.writableFinished) rec.aborted = true;
        closed.resolve();
      });
      handler(req, res, body, rec);
    });
  });
  rec.base = await s.listen(srv);
  return rec;
}

function sendJson(res, obj, status = 200) {
  const p = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(p) });
  res.end(p);
}
function sseHeaders(res) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  res.flushHeaders?.();
}
function safeWrite(res, chunk) {
  if (!res.destroyed && !res.writableEnded) res.write(chunk);
}

const aev = (name, obj) => `event: ${name}\ndata: ${JSON.stringify(obj)}\n\n`;
const oaiFrame = (real, delta, finish = null) =>
  'data: ' +
  JSON.stringify({ id: 'chatcmpl-fx', object: 'chat.completion.chunk', created: 1, model: real, choices: [{ index: 0, delta, finish_reason: finish }] }) +
  '\n\n';

function okJson(kind, real, text) {
  if (kind === 'anthropic') {
    return { id: 'msg_fx', type: 'message', role: 'assistant', model: real, content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 3, output_tokens: 2 } };
  }
  return { id: 'chatcmpl-fx', object: 'chat.completion', created: 1, model: real, choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } };
}
function aMsgStart(real) {
  return aev('message_start', { type: 'message_start', message: { id: 'msg_fx', type: 'message', role: 'assistant', model: real, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 3, output_tokens: 0 } } });
}
function sseHead(kind, real) {
  if (kind !== 'anthropic') return '';
  return aMsgStart(real) + aev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
}
function sseDelta(kind, real, tok) {
  if (kind === 'anthropic') return aev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: tok } });
  return oaiFrame(real, { content: tok });
}
function sseEnd(kind, real) {
  if (kind === 'anthropic') {
    return (
      aev('content_block_stop', { type: 'content_block_stop', index: 0 }) +
      aev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } }) +
      aev('message_stop', { type: 'message_stop' })
    );
  }
  return oaiFrame(real, {}, 'stop') + 'data: [DONE]\n\n';
}

let __gwSeq = 0;
function backup(s) {
  return upstream(s, (req, res, body) => {
    if (body.stream) {
      sseHeaders(res);
      res.end(oaiFrame('backup-real', { role: 'assistant', content: 'BACKUP' }) + sseEnd('openai', 'backup-real'));
    } else {
      sendJson(res, okJson('openai', 'backup-real', 'BACKUP'));
    }
  });
}

function model(kind, alias, base) {
  return {
    name: alias,
    provider: kind === 'openai' ? 'openai-compatible' : kind,
    model: `real-${alias}-${kind}`,
    api_base: base,
    api_key: SECRET,
  };
}

async function gateway(s, models, { fallbacks = {}, timeoutMs = 1200 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), `kapi-rel-${++__gwSeq}-`));
  s.final(() => rmSync(dir, { recursive: true, force: true }));
  const auditPath = join(dir, 'audit.jsonl');
  const cfg = {
    security: { require_key: false, log_bodies: false, audit_log: auditPath },
    models,
    routing: { fallbacks, timeout_ms: timeoutMs },
  };
  const srv = createGateway(cfg);
  const base = await s.listen(srv);
  return { base, auditPath };
}

// Client total bound covers headers AND body read.
async function chat(s, base, alias, { stream = false, bound = 1500 } = {}) {
  const ac = new AbortController();
  const h = s.timer(() => ac.abort(), bound);
  const t0 = Date.now();
  const out = { status: 0, text: '', json: null, timedOut: false, elapsed: 0, headers: null };
  try {
    const r = await realFetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: alias, stream, messages: [{ role: 'user', content: 'hi' }] }),
      signal: ac.signal,
    });
    out.status = r.status;
    out.headers = r.headers;
    out.text = await r.text();
    try {
      out.json = JSON.parse(out.text);
    } catch {}
  } catch (e) {
    if (ac.signal.aborted) out.timedOut = true;
    else throw e;
  } finally {
    clearTimeout(h);
    out.elapsed = Date.now() - t0;
  }
  return out;
}

function readAudit(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return { raw: l };
      }
    });
}
async function waitAudit(s, path, n = 1) {
  return s.poll(() => {
    const a = readAudit(path);
    return a.length >= n ? a : null;
  });
}

function decodeSSE(text) {
  const datas = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/).filter((l) => l.startsWith('data:'));
    if (!lines.length) continue;
    const d = lines.map((l) => l.slice(5).replace(/^ /, '')).join('\n');
    if (d === '[DONE]') {
      datas.push({ done: true });
      continue;
    }
    try {
      datas.push({ json: JSON.parse(d) });
    } catch {
      datas.push({ raw: d });
    }
  }
  return datas;
}

function assertBackupJson(r, alias) {
  assert.equal(r.timedOut, false, 'client bound hit');
  assert.equal(r.status, 200, r.text);
  assert.ok(r.json, 'json body');
  assert.equal(r.json.choices[0].message.content, 'BACKUP');
  assert.equal(r.json.model, alias);
  assert.ok(!r.text.includes(SECRET));
  assert.ok(!r.text.includes('backup-real'));
}

function assertBackupSSE(r, alias) {
  assert.equal(r.timedOut, false, 'client bound hit');
  assert.equal(r.status, 200, r.text);
  const ev = decodeSSE(r.text);
  const content = ev
    .filter((e) => e.json?.choices)
    .map((e) => e.json.choices[0]?.delta?.content ?? '')
    .join('');
  assert.equal(content, 'BACKUP');
  assert.ok(ev.some((e) => e.done), 'missing [DONE]');
  for (const e of ev) if (e.json?.model) assert.equal(e.json.model, alias);
  assert.ok(!r.text.includes(SECRET));
  assert.ok(!r.text.includes('backup-real'));
}

test('total per-attempt deadline includes JSON/SSE body; continuous drip times out', async (t) => {
  for (const kind of KINDS) {
    await t.test(`${kind}: dripped JSON body exceeds total deadline -> fallback`, async (t) => {
      const s = scope(t);
      const prim = await upstream(s, (req, res) => {
        const p = JSON.stringify(okJson(kind, `real-primary-${kind}`, 'PRIMARY'));
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(p) });
        res.flushHeaders?.();
        const size = Math.ceil(p.length / 10);
        let i = 0;
        const iv = s.interval(() => {
          if (i >= p.length) {
            clearInterval(iv);
            if (!res.destroyed) res.end();
            return;
          }
          safeWrite(res, p.slice(i, i + size));
          i += size;
        }, 50);
      });
      const bak = await backup(s);
      const gw = await gateway(s, [model(kind, 'primary', prim.base), model('openai', 'backup', bak.base)], {
        fallbacks: { primary: ['backup'] },
        timeoutMs: 180,
      });
      const r = await chat(s, gw.base, 'primary');
      assertBackupJson(r, 'primary');
      assert.ok(r.elapsed < 1200, `took ${r.elapsed}ms, deadline is not total`);
      assert.equal(prim.calls, 1);
      assert.equal(bak.calls, 1);
      assert.ok(await s.poll(() => prim.aborted), 'primary not cancelled');
      assert.ok(!r.text.includes(`real-primary-${kind}`));
    });

    await t.test(`${kind}: healthy JSON within deadline returns primary`, async (t) => {
      const s = scope(t);
      const prim = await upstream(s, (req, res) => sendJson(res, okJson(kind, `real-primary-${kind}`, 'PRIMARY')));
      const bak = await backup(s);
      const gw = await gateway(s, [model(kind, 'primary', prim.base), model('openai', 'backup', bak.base)], {
        fallbacks: { primary: ['backup'] },
        timeoutMs: 1200,
      });
      const r = await chat(s, gw.base, 'primary');
      assert.equal(r.timedOut, false);
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json.choices[0].message.content, 'PRIMARY');
      assert.equal(r.json.model, 'primary');
      assert.equal(bak.calls, 0);
      assert.ok(!r.text.includes(SECRET));
      const audit = await waitAudit(s, gw.auditPath);
      assert.ok(audit && audit.length >= 1, 'no audit entry');
      assert.ok(!readFileSync(gw.auditPath, 'utf8').includes(SECRET));
    });

    await t.test(`${kind}: continuous SSE drip still hits total deadline`, async (t) => {
      const s = scope(t);
      const real = `real-primary-${kind}`;
      const prim = await upstream(s, (req, res) => {
        sseHeaders(res);
        safeWrite(res, sseHead(kind, real));
        safeWrite(res, sseDelta(kind, real, 'tok'));
        s.interval(() => safeWrite(res, sseDelta(kind, real, 'tok')), 30);
      });
      const bak = await backup(s);
      const gw = await gateway(s, [model(kind, 'primary', prim.base), model('openai', 'backup', bak.base)], {
        fallbacks: { primary: ['backup'] },
        timeoutMs: 200,
      });
      const r = await chat(s, gw.base, 'primary', { stream: true });
      assert.equal(r.timedOut, false, 'drip kept stream alive past total deadline');
      assert.ok(r.elapsed < 1000, `took ${r.elapsed}ms`);
      const ev = decodeSSE(r.text);
      assert.ok(!ev.some((e) => e.done), 'fake [DONE] after mid-stream failure');
      assert.ok(ev.some((e) => e.json?.error), 'missing terminal JSON error frame');
      assert.ok(!ev.some(e => e.json?.choices?.some(c => c.finish_reason === 'stop')), 'timeout cannot claim finish stop');
      const rows = await waitAudit(s, gw.auditPath);
      assert.ok(rows?.at(-1)?.status >= 400, 'timeout stream audit must be a failure');
      assert.equal(bak.calls, 0, 'no fallback after first byte');
      assert.ok(await s.poll(() => prim.aborted), 'primary not cancelled');
      assert.ok(!r.text.includes(SECRET));
      assert.ok(!r.text.includes(real));
    });
  }
});

test('malformed or truncated JSON 200 from primary falls back before headers', async (t) => {
  for (const kind of KINDS) {
    for (const mode of ['malformed', 'truncated']) {
      await t.test(`${kind}: ${mode}`, async (t) => {
        const s = scope(t);
        const prim = await upstream(s, (req, res) => {
          const full = JSON.stringify(okJson(kind, `real-primary-${kind}`, 'PRIMARY'));
          if (mode === 'malformed') {
            const p = '{"choices":[{"message":{"content":"PRIM';
            res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(p) });
            res.end(p);
          } else {
            res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(full) });
            res.write(full.slice(0, Math.floor(full.length / 2)));
            s.timer(() => res.destroy(), 20);
          }
        });
        const bak = await backup(s);
        const gw = await gateway(s, [model(kind, 'primary', prim.base), model('openai', 'backup', bak.base)], {
          fallbacks: { primary: ['backup'] },
          timeoutMs: 1200,
        });
        const r = await chat(s, gw.base, 'primary');
        assertBackupJson(r, 'primary');
        assert.equal(prim.calls, 1);
        assert.equal(bak.calls, 1);
        assert.ok(!r.text.includes(`real-primary-${kind}`));
      });
    }
  }
});

test('empty SSE (headers then EOF) falls back before first downstream byte', async (t) => {
  for (const kind of KINDS) {
    await t.test(`${kind}: empty SSE`, async (t) => {
      const s = scope(t);
      const prim = await upstream(s, (req, res) => {
        sseHeaders(res);
        s.timer(() => res.end(), 20);
      });
      const bak = await backup(s);
      const gw = await gateway(s, [model(kind, 'primary', prim.base), model('openai', 'backup', bak.base)], {
        fallbacks: { primary: ['backup'] },
        timeoutMs: 1200,
      });
      const r = await chat(s, gw.base, 'primary', { stream: true });
      assertBackupSSE(r, 'primary');
      assert.equal(prim.calls, 1);
      assert.equal(bak.calls, 1);
      assert.equal(bak.bodies[0].stream, true);
      assert.ok(!r.text.includes(`real-primary-${kind}`));
    });
  }
});
// Integration/edge cases authored by Codex around the salvaged Opus fixture helpers.
const fxProviders = { openai: 'openai-compatible', ollama: 'ollama', anthropic: 'anthropic' };
const fxModel = (kind, name, base) => ({ name, provider: fxProviders[kind], model: `private-real-${kind}-${name}`, api_base: base, api_key: SECRET });
async function fxGateway(s, models, { timeoutMs = 1200, fallbacks = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'kapi-reliability-'));
  s.final(() => rmSync(dir, { recursive: true, force: true }));
  const auditPath = join(dir, 'audit.jsonl');
  const cfg = { server: { host: '127.0.0.1', port: 0 }, security: { require_key: false, keys: [], log_bodies: false, redact_pii: true, pii: ['tckn', 'email'], audit_log: auditPath }, routing: { timeout_ms: timeoutMs, fallbacks }, models };
  const server = createGateway(cfg);
  return { server, base: await s.listen(server), auditPath, cfg };
}
async function fxChat(s, gw, model, extra = {}, limit = 1800) {
  const ctrl = new AbortController();
  const timer = s.timer(() => ctrl.abort(), limit);
  const finish = () => clearTimeout(timer);
  let response;
  try {
    response = await realFetch(`${gw.base}/v1/chat/completions`, { method: 'POST', signal: ctrl.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, messages: [{ role: 'user', content: 'PRIVATE-PROMPT-FIXTURE-98' }], ...extra }) });
  } catch (e) { finish(); throw e; }
  return { response, ctrl, finish, async text() { try { return await response.text(); } finally { finish(); } } };
}
async function fxAudit(s, gw, predicate = () => true) {
  const rows = await s.poll(() => {
    if (!existsSync(gw.auditPath)) return null;
    const text = readFileSync(gw.auditPath, 'utf8').trim();
    const values = text ? text.split('\n').map(JSON.parse).filter(predicate) : [];
    return values.length ? values : null;
  });
  assert.ok(rows?.length, 'request must finish and append audit metadata');
  const raw = readFileSync(gw.auditPath, 'utf8');
  assert.ok(!raw.includes('PRIVATE-PROMPT-FIXTURE-98') && !raw.includes(SECRET) && !raw.includes('VISIBLE-PREFIX'), 'audit must not contain prompt/reply/token');
  return rows.at(-1);
}
function fxFrames(text) {
  return text.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).filter(Boolean).filter(p => p !== '[DONE]').map(p => JSON.parse(p));
}
function fxFailure(text, privateModel) {
  assert.ok(!text.includes('[DONE]'), 'failure must not manufacture DONE');
  const frames = fxFrames(text);
  assert.ok(frames.some(f => f.error && typeof f.error.message === 'string'), 'failure needs an explicit generic SSE error');
  assert.ok(!frames.some(f => f.choices?.some(c => c.finish_reason === 'stop')), 'failure must not manufacture a successful stop');
  assert.ok(!text.includes(SECRET) && !text.includes(privateModel), 'upstream diagnostic/model/token leaked');
}
async function fxPrefix(reader, marker) {
  const decoder = new TextDecoder();
  let text = '';
  while (!text.includes(marker)) {
    const { value, done } = await reader.read();
    assert.equal(done, false, 'stream ended before actual content reached the client');
    text += decoder.decode(value, { stream: true });
  }
  return text;
}
async function fxRest(reader, first) {
  let result = typeof first === 'string' ? first : new TextDecoder().decode(first);
  for (;;) { const { value, done } = await reader.read(); if (done) return result; result += new TextDecoder().decode(value); }
}

// Normal body end is a positive control: cancellation is about downstream response close.
test('4 downstream disconnect cancels pending JSON and SSE upstreams for every adapter', { timeout: 15000 }, async t => {
  for (const kind of KINDS) for (const stream of [false, true]) await t.test(`${kind} ${stream ? 'SSE' : 'JSON'}`, async st => {
    const s = scope(st);
    const up = await upstream(s, (_req, res, _body, rec) => {
      if (stream) { sseHeaders(res); safeWrite(res, sseHead(kind, 'private-disconnect') + sseDelta(kind, 'private-disconnect', 'VISIBLE-PREFIX')); }
      else { res.writeHead(200, { 'content-type': 'application/json' }); res.flushHeaders(); safeWrite(res, '{"id":"pending",'); }
      rec.gate.resolve(); // deliberately never ends until cancelled/cleanup
    });
    const ok = await upstream(s, (_req, res) => sendJson(res, okJson(kind, 'private-healthy', 'HEALTHY')));
    const gw = await fxGateway(s, [fxModel(kind, 'cancel-target', up.base), fxModel(kind, 'healthy', ok.base)], { timeoutMs: 1400 });
    const ac = new AbortController();
    const responsePromise = realFetch(`${gw.base}/v1/chat/completions`, { method: 'POST', signal: ac.signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'cancel-target', stream, messages: [{ role: 'user', content: 'fixture' }] }) });
    const observed = responsePromise.catch(() => null);
    assert.ok(await s.within(up.gate.promise, 1200), 'upstream did not receive full request');
    if (stream) { const r = await responsePromise; const reader = r.body.getReader(); await fxPrefix(reader, 'VISIBLE-PREFIX'); ac.abort(); await reader.cancel().catch(() => {}); }
    else ac.abort();
    await observed;
    assert.ok(await s.poll(() => up.aborted, 700), 'client disconnected but upstream generation stayed alive');
    const healthy = await fxChat(s, gw, 'healthy');
    assert.equal(healthy.response.status, 200);
    assert.equal(JSON.parse(await healthy.text()).choices[0].message.content, 'HEALTHY', 'ordinary request-body end must not cancel the response');
  });
});

// Artificial pressure mirrors Node's write(false)+writableNeedDrain contract, not OS buffer sizes.
test('5 backpressure pauses reads; drain/cancel/deadline paths release listeners', { timeout: 12000 }, async t => {
  for (const mode of ['drain', 'cancel', 'deadline']) await t.test(mode, async st => {
    const s = scope(st);
    const up = await upstream(s, (_req, res, _body, rec) => { rec.unexpected = true; res.destroy(); });
    const gw = await fxGateway(s, [fxModel('openai', 'pressure', up.base)], { timeoutMs: mode === 'deadline' ? 220 : 1400 });
    let pulls = 0, cancelled = false, aborted = false, controller, responseNode;
    let pressure = false;
    const blocked = deferred();
    gw.server.prependListener('request', (_req, res) => {
      responseNode = res;
      const originalWrite = res.write.bind(res);
      let first = true;
      const protoDrain = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Object.getPrototypeOf(res)), 'writableNeedDrain');
      Object.defineProperty(res, 'writableNeedDrain', { configurable: true, get() { return pressure || (protoDrain?.get?.call(res) ?? false); } });
      res.write = function (...args) { const result = originalWrite(...args); if (first) { first = false; pressure = true; blocked.resolve(); return false; } return result; };
    });
    const patchedFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      if (new URL(url).origin !== up.base) return realFetch(url, opts);
      const signal = opts?.signal;
      const body = new ReadableStream({
        start(c) { controller = c; signal?.addEventListener('abort', () => { aborted = true; try { c.error(new DOMException('fixture abort', 'AbortError')); } catch {} }, { once: true }); },
        pull(c) { pulls++; c.enqueue(enc.encode(pulls <= 30 ? oaiFrame('private-pressure', { content: String(pulls) }) : 'data: [DONE]\n\n')); if (pulls > 30) c.close(); },
        cancel() { cancelled = true; },
      }, { highWaterMark: 0 });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };
    s.defer(() => { globalThis.fetch = patchedFetch; try { controller?.close(); } catch {} responseNode?.emit('drain'); });
    const request = await fxChat(s, gw, 'pressure', { stream: true }, 1800);
    assert.equal(up.calls, 0, 'custom fetch fixture did not intercept the owned upstream');
    assert.ok(await s.within(blocked.promise, 700));
    await s.sleep(60);
    const held = pulls; await s.sleep(60);
    assert.ok(held < 15 && pulls === held, `stream consumed through backpressure (${held}→${pulls})`);
    if (mode === 'drain') {
      pressure = false; responseNode.emit('drain');
      assert.ok((await request.text()).includes('[DONE]'), 'drain must let a healthy stream finish');
      assert.equal((await fxAudit(s, gw)).status, 200);
    } else if (mode === 'cancel') {
      request.ctrl.abort(); await request.response.body.cancel().catch(() => {}); request.finish();
      assert.ok(await s.poll(() => aborted || cancelled, 700), 'cancel did not propagate while waiting for drain');
    } else {
      // No drain and no client close: the upstream TOTAL deadline still has to finish the route.
      const text = await request.text(); fxFailure(text, 'private-pressure');
      assert.ok((await fxAudit(s, gw)).status >= 400, 'deadline failure audit must not say 200');
    }
    assert.ok(await s.poll(() => responseNode.listenerCount('drain') === 0, 700), 'drain listener leaked after terminal path');
  });
});

test('6 failure after real downstream bytes stays on that attempt and reports an honest terminal frame', { timeout: 12000 }, async t => {
  for (const [kind, failure] of [['openai', 'reset'], ['ollama', 'reset'], ['anthropic', 'error'], ['anthropic', 'end-turn-eof'], ['openai', 'malformed'], ['anthropic', 'malformed']]) await t.test(`${kind} ${failure}`, async st => {
    const s = scope(st), privateModel = `private-${kind}-${failure}`;
    const up = await upstream(s, (_req, res, _body, rec) => {
      sseHeaders(res); safeWrite(res, sseHead(kind, privateModel) + sseDelta(kind, privateModel, 'VISIBLE-PREFIX'));
      rec.fail = () => {
        if (failure === 'reset') res.destroy();
        else if (failure === 'error') res.end(aev('error', { type: 'error', error: { type: 'overloaded_error', message: `${privateModel} ${SECRET}` } }));
        else if (failure === 'malformed') res.end(
          `data: {"type":"content_block_delta","model":"${privateModel}","token":"${SECRET}" BROKEN}\n\n` +
          (kind === 'anthropic' ? sseEnd(kind, privateModel) : '')
        );
        else res.end(aev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' } }));
      };
    });
    const backup = await upstream(s, (_req, res) => { sseHeaders(res); res.end(oaiFrame('private-backup', { content: 'BACKUP' }) + 'data: [DONE]\n\n'); });
    const m = fxModel(kind, 'broken-stream', up.base), gw = await fxGateway(s, [m, fxModel('openai', 'backup', backup.base)], { fallbacks: { 'broken-stream': ['backup'] } });
    const request = await fxChat(s, gw, 'broken-stream', { stream: true });
    const reader = request.response.body.getReader();
    const first = await fxPrefix(reader, 'VISIBLE-PREFIX');
    up.fail();
    const text = await fxRest(reader, first); request.finish();
    fxFailure(text, privateModel); assert.equal(backup.calls, 0, 'cannot change models after content reached the client');
    const row = await fxAudit(s, gw); assert.ok(row.status >= 400, 'failed stream audit must not be 200');
  });
});

test('7 malformed first SSE frame never leaks raw private diagnostics and can fall back before committing', { timeout: 6000 }, async t => {
  for (const kind of KINDS) await t.test(kind, async st => {
    const s = scope(st), privateModel = 'private-malformed-first';
    const up = await upstream(s, (_req, res) => {
      sseHeaders(res);
      res.end((kind === 'anthropic' ? aMsgStart(privateModel) : '') +
        `data: {"type":"content_block_delta","model":"${privateModel}","key":"${SECRET}" BROKEN}\n\n` +
        (kind === 'anthropic' ? sseEnd(kind, privateModel) : ''));
    });
    const back = await upstream(s, (_req, res) => { sseHeaders(res); res.end(oaiFrame('private-back', { content: 'BACKUP' }) + 'data: [DONE]\n\n'); });
    const gw = await fxGateway(s, [fxModel(kind, 'malformed-first', up.base), fxModel('openai', 'backup', back.base)], { fallbacks: { 'malformed-first': ['backup'] } });
    const request = await fxChat(s, gw, 'malformed-first', { stream: true }); const text = await request.text();
    assert.equal(request.response.status, 200); assert.ok(text.includes('BACKUP') && text.includes('[DONE]')); assert.equal(back.calls, 1);
    assert.ok(!text.includes(privateModel) && !text.includes(SECRET)); assert.equal((await fxAudit(s, gw)).fallback, true);
  });
});

test('8 Anthropic rejects unsupported input explicitly while text and OpenAI passthrough stay usable', { timeout: 10000 }, async t => {
  const s = scope(t);
  const up = await upstream(s, (_req, res, body) => sendJson(res, okJson('anthropic', body.model, 'TEXT-OK')));
  const compatible = await upstream(s, (_req, res, body) => sendJson(res, okJson('openai', body.model, 'PASSTHROUGH')));
  const gw = await fxGateway(s, [fxModel('anthropic', 'claude', up.base), fxModel('openai', 'compatible', compatible.base)]);
  const cases = [
    ['tools', { tools: [{ type: 'function', function: { name: 'fixture', parameters: { type: 'object' } } }] }],
    ['tool_choice', { tool_choice: 'auto' }],
    ['response_format', { response_format: { type: 'json_object' } }],
    ['json_schema', { response_format: { type: 'json_schema', json_schema: { name: 'fixture', schema: { type: 'object' } } } }],
    ['tool message', { messages: [{ role: 'tool', tool_call_id: 'x', content: 'fixture' }] }],
    ['tool_calls', { messages: [{ role: 'assistant', content: null, tool_calls: [{ id: 'x', type: 'function', function: { name: 'fixture', arguments: '{}' } }] }] }],
    ['image', { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://fixture.invalid/not-fetched.png' } }] }] }],
  ];
  for (const [name, body] of cases) await t.test(name, async () => {
    const before = up.calls; const request = await fxChat(s, gw, 'claude', body); const text = await request.text();
    assert.equal(request.response.status, 400, 'unsupported input must not silently become plain text');
    assert.ok(JSON.parse(text).error?.message); assert.equal(up.calls, before, 'unsupported input reached provider'); assert.ok(!text.includes(SECRET));
  });
  const text = await fxChat(s, gw, 'claude', { messages: [{ role: 'user', content: [{ type: 'text', text: 'allowed' }] }] });
  assert.equal(text.response.status, 200); assert.equal(JSON.parse(await text.text()).choices[0].message.content, 'TEXT-OK');
  const pass = { tools: cases[0][1].tools, response_format: { type: 'json_object' } };
  const oai = await fxChat(s, gw, 'compatible', pass); assert.equal(oai.response.status, 200); await oai.text();
  assert.deepEqual(compatible.bodies.at(-1).tools, pass.tools); assert.deepEqual(compatible.bodies.at(-1).response_format, pass.response_format);
});

test('9 unexpected Anthropic tool_use response is a 502, never a fake finish or dropped tool call', { timeout: 6000 }, async t => {
  for (const stream of [false, true]) await t.test(stream ? 'SSE' : 'JSON', async st => {
    const s = scope(st), privateModel = 'private-unexpected-tool';
    const up = await upstream(s, (_req, res) => {
      const block = { type: 'tool_use', id: 'tool_fx', name: 'fixture', input: { diagnostic: `${privateModel} ${SECRET}` } };
      if (stream) { sseHeaders(res); res.end(aMsgStart(privateModel) + aev('content_block_start', { type: 'content_block_start', index: 0, content_block: block }) + aev('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' } }) + aev('message_stop', { type: 'message_stop' })); }
      else sendJson(res, { ...okJson('anthropic', privateModel, ''), content: [block], stop_reason: 'tool_use' });
    });
    const gw = await fxGateway(s, [fxModel('anthropic', 'claude-unexpected', up.base)]);
    const request = await fxChat(s, gw, 'claude-unexpected', { stream }); const text = await request.text();
    assert.equal(request.response.status, 502); assert.ok(JSON.parse(text).error?.message); assert.ok(!text.includes('[DONE]') && !text.includes(privateModel) && !text.includes(SECRET));
  });
});

test('10 with global redaction enabled model-default PII policy stays conservative and errors expose only aliases', { timeout: 10000 }, async t => {
  const cfg = { security: { redact_pii: true, pii: ['tckn', 'email'] } };
  await t.test('destination classification and overrides', () => {
    assert.ok(resolveTypes(cfg, { provider: 'ollama', api_base: 'https://fixture.invalid' })?.includes('tckn'));
    for (const api_base of [undefined, 'http://127.0.0.1:12345', 'http://localhost:12345', 'http://[::1]:12345']) assert.equal(resolveTypes(cfg, { provider: 'ollama', api_base }), null);
    for (const provider of ['openai-compatible', 'anthropic']) assert.ok(resolveTypes(cfg, { provider, api_base: 'http://127.0.0.1:12345' })?.includes('tckn'), 'non-Ollama loopback defaults must NOT be weakened');
    assert.equal(resolveTypes(cfg, { provider: 'ollama', api_base: 'https://fixture.invalid', redact: false }), null);
    assert.ok(resolveTypes(cfg, { provider: 'ollama', redact: true })?.includes('tckn'));
  });
  for (const kind of KINDS) await t.test(`${kind} actual request/privacy/error`, async st => {
    const s = scope(st);
    const up = await upstream(s, (_req, res, body) => sendJson(res, okJson(kind, body.model, 'OK')));
    const bad = await upstream(s, (_req, res, body) => sendJson(res, { error: { message: `${body.model} ${SECRET} ${bad.base}` } }, 404));
    const ok = fxModel(kind, 'privacy', up.base), err = fxModel(kind, 'error-alias', bad.base);
    const gw = await fxGateway(s, [ok, err]);
    const request = await fxChat(s, gw, 'privacy', { messages: [{ role: 'user', content: '10000000146 fixture@example.invalid' }] }); assert.equal(request.response.status, 200); await request.text();
    const captured = JSON.stringify(up.bodies.at(-1).messages);
    if (kind === 'ollama') assert.ok(captured.includes('10000000146'), 'explicit loopback Ollama remains exempt');
    else { assert.ok(captured.includes('[TCKN]') && captured.includes('[E-POSTA]')); assert.ok(!captured.includes('10000000146') && !captured.includes('fixture@example.invalid')); }
    const failed = await fxChat(s, gw, 'error-alias'); const text = await failed.text(); assert.ok(failed.response.status >= 400); assert.ok(JSON.parse(text).error?.message);
    assert.ok(text.includes('error-alias') && !text.includes(err.model) && !text.includes(SECRET) && !text.includes(bad.base), 'client error leaked backend details');
    await fxAudit(s, gw);
  });
});

test('11 provider 307 redirects never forward prompts, credentials, or custom headers to another origin', { timeout: 12000 }, async t => {
  for (const kind of KINDS) for (const stream of [false, true]) await t.test(`${kind} ${stream ? 'SSE' : 'JSON'}`, async st => {
    const s = scope(st);
    // Two genuinely separate origins: the recipient would accept and complete the redirected POST.
    // A zero count proves that fetch did not follow the redirect at all; it cannot hide a leak by
    // merely stripping one known header. All values below are synthetic sentinels.
    const recipient = await upstream(s, (_req, res, body) => {
      if (body.stream) { sseHeaders(res); res.end(sseHead(kind, body.model) + sseDelta(kind, body.model, 'REDIRECTED') + sseEnd(kind, body.model)); }
      else sendJson(res, okJson(kind, body.model, 'REDIRECTED'));
    });
    const redirect = await upstream(s, (req, res) => { res.writeHead(307, { location: recipient.base + req.url }); res.end(); });
    const back = await backup(s);
    const guarded = fxModel(kind, 'redirect', redirect.base);
    guarded.headers = { 'x-fixture-private-header': 'PRIVATE-HEADER-SENTINEL-52' };
    const noFallback = { ...guarded, name: 'redirect-no-fallback' };
    const gw = await fxGateway(s, [guarded, noFallback, fxModel('openai', 'backup', back.base)], { fallbacks: { redirect: ['backup'] } });

    const recovered = await fxChat(s, gw, 'redirect', { stream });
    const recoveredText = await recovered.text();
    const failed = await fxChat(s, gw, 'redirect-no-fallback', { stream });
    const failedText = await failed.text();

    assert.equal(redirect.calls, 2, 'configured upstream must receive both complete POST attempts');
    assert.ok(redirect.bodies.every(body => JSON.stringify(body).includes('PRIVATE-PROMPT-FIXTURE-98')));
    assert.ok(redirect.headers.every(headers => headers['x-fixture-private-header'] === 'PRIVATE-HEADER-SENTINEL-52'));
    if (kind === 'anthropic') assert.ok(redirect.headers.every(headers => headers['x-api-key'] === SECRET));
    else assert.ok(redirect.headers.every(headers => headers.authorization === `Bearer ${SECRET}`));
    assert.equal(recipient.calls, 0, 'cross-origin recipient must receive no request/body/header');
    assert.equal(back.calls, 1, 'rejected redirect should retry only the configured backup');
    assert.equal(recovered.response.status, 200);
    if (stream) assert.ok(recoveredText.includes('BACKUP') && recoveredText.includes('[DONE]'));
    else assert.equal(JSON.parse(recoveredText).choices[0].message.content, 'BACKUP');
    assert.equal(failed.response.status, 502);
    assert.ok(JSON.parse(failedText).error?.message);
    assert.ok(!failedText.includes(SECRET) && !failedText.includes(guarded.model) && !failedText.includes(recipient.base) && !failedText.includes(redirect.base));
    const rows = await s.poll(() => {
      if (!existsSync(gw.auditPath)) return null;
      const rows = readFileSync(gw.auditPath, 'utf8').trim().split('\n').map(JSON.parse);
      return rows.length === 2 ? rows : null;
    });
    assert.equal(rows?.length, 2);
    assert.equal(rows[0].fallback, true);
    assert.equal(rows[0].status, 200);
    assert.equal(rows[1].status, 502);
  });
});


// ---------------------------------------------------------------------------
// Group 12: final Fable findings F1/F2/F3.
// Provenance: root findings F1/F2/F3 come from Fable review. Earlier helpers/cases have mixed Opus and Codex provenance as recorded in the review receipt.
// These F1/F2/F3 cases were authored by Opus, integrated and executed by Codex, and add no runtime dependencies.
// Every fixture is an owned random-port loopback server or a temp file under os.tmpdir(). All values are synthetic.
// ---------------------------------------------------------------------------

const F1_MARKER = 'PRIVATE-OVERSIZE-MARKER-1313';
const F1_SIZE = 11 * 1024 * 1024; // 11 MB, exceeding the 10 MB limit

function f1Body(alias) {
  const head = `{"model":"${alias}","messages":[{"role":"user","content":"${F1_MARKER} `;
  const tail = '"}]}';
  const pad = F1_SIZE - Buffer.byteLength(head) - Buffer.byteLength(tail);
  const buf = Buffer.from(head + 'a'.repeat(pad) + tail);
  assert.equal(buf.length, F1_SIZE);
  return buf;
}

// Raw http.request lets the test send the whole known-size body.
// It also lets the test tell a real 413 response apart from a socket reset.
function f1Post(s, base, buf, bound = 5000) {
  return new Promise((resolve) => {
    const u = new URL(`${base}/v1/chat/completions`);
    const out = { status: 0, headers: null, text: '', error: null, timedOut: false };
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(out); } };
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': buf.length } }, (res) => {
      out.status = res.statusCode;
      out.headers = res.headers;
      res.setEncoding('utf8');
      res.on('data', (c) => { out.text += c; });
      res.on('end', done);
      res.on('error', (e) => { out.error = e; done(); });
    });
    s.timer(() => { out.timedOut = true; req.destroy(); done(); }, bound);
    req.on('error', (e) => { if (!out.status) out.error = e; done(); });
    req.end(buf);
  });
}

test('12 final F1/F2/F3 regressions', { timeout: 20000 }, async (t) => {
  // F1: an oversized body must get a real 413 JSON response, not a reset socket. It must also leave one metadata-only audit row.
  await t.test('F1 >10MB body -> 413 invalid_request_error, Connection: close, one audit row', async (st) => {
    const s = scope(st);
    const prim = await upstream(s, (_req, res) => sendJson(res, okJson('openai', 'private-real-f1', 'NO')));
    const gw = await gateway(s, [model('openai', 'primary', prim.base)]);
    const r = await f1Post(s, gw.base, f1Body('primary'));
    assert.equal(r.timedOut, false, 'client bound hit');
    assert.equal(r.error?.code, undefined, `socket error instead of 413: ${r.error?.code}`);
    assert.equal(r.status, 413, r.text);
    assert.match(String(r.headers['content-type']), /application\/json/);
    assert.equal(String(r.headers.connection).toLowerCase(), 'close');
    const j = JSON.parse(r.text);
    assert.equal(j.error?.type, 'invalid_request_error');
    assert.ok(!r.text.includes(F1_MARKER) && !r.text.includes(SECRET));
    assert.equal(prim.calls, 0, 'oversized body reached provider');
    const rows = await waitAudit(s, gw.auditPath, 1);
    await s.sleep(100);
    const all = readAudit(gw.auditPath);
    assert.ok(rows, 'no audit row for 413');
    assert.equal(all.length, 1, 'exactly one audit row');
    assert.equal(all[0].status, 413);
    const raw = readFileSync(gw.auditPath, 'utf8');
    assert.ok(!raw.includes(F1_MARKER) && !raw.includes(SECRET) && !raw.includes('aaaaaaaaaa'), 'audit leaked payload');
  });

  // F2: a provider error envelope sent with HTTP 200 counts as a failure that can fall back. It is never a success.
  await t.test('F2 HTTP 200 {error} -> backup fallback; no backup -> 502 generic', async (st) => {
    const s = scope(st);
    const errBody = { error: { message: 'private-real-x overloaded ' + SECRET } };
    const prim = await upstream(s, (_req, res) => sendJson(res, errBody, 200));
    const bak = await backup(s);
    const gw = await gateway(s, [model('openai', 'primary', prim.base), model('openai', 'solo', prim.base), model('openai', 'backup', bak.base)], { fallbacks: { primary: ['backup'] } });
    const r1 = await chat(s, gw.base, 'primary');
    assert.ok(Array.isArray(r1.json?.choices), 'HTTP 200 error envelope was not converted to a backup completion');
    assertBackupJson(r1, 'primary');
    assert.ok(!r1.text.includes('private-real-x') && !r1.text.includes('overloaded'));
    assert.equal(bak.calls, 1);
    const r2 = await chat(s, gw.base, 'solo');
    assert.equal(r2.status, 502, r2.text);
    assert.ok(typeof r2.json?.error?.message === 'string');
    assert.ok(!r2.text.includes('private-real-x') && !r2.text.includes('overloaded') && !r2.text.includes(SECRET));
    assert.equal(bak.calls, 1, 'solo alias has no fallback');
    const rows = await waitAudit(s, gw.auditPath, 2);
    assert.equal(rows?.length, 2);
    assert.equal(rows[0].status, 200);
    assert.equal(rows[0].fallback, true);
    assert.equal(rows[1].status, 502);
    assert.equal(rows[1].fallback, false);
    assert.ok(!readFileSync(gw.auditPath, 'utf8').includes(SECRET));
  });

  for (const [name, payload] of [
    ['missing choices', { id: 'x', object: 'chat.completion', model: 'private-real-y', private_field: 'PRIVATE-FIELD-77' }],
    ['choices not array', { id: 'x', object: 'chat.completion', model: 'private-real-y', choices: 'PRIVATE-FIELD-77' }],
  ]) {
    await t.test(`F2 ${name} -> 502 without raw fields`, async (st) => {
      const s = scope(st);
      const prim = await upstream(s, (_req, res) => sendJson(res, payload, 200));
      const gw = await gateway(s, [model('openai', 'shape', prim.base)]);
      const r = await chat(s, gw.base, 'shape');
      assert.equal(r.status, 502, r.text);
      assert.ok(typeof r.json?.error?.message === 'string');
      assert.ok(!r.text.includes('private-real-y') && !r.text.includes('PRIVATE-FIELD-77'));
    });
  }

  // Positive control: a legitimate object with error:null and an extra safe field must not be rejected.
  await t.test('F2 control: valid choices + error:null + extra field preserved', async (st) => {
    const s = scope(st);
    const prim = await upstream(s, (_req, res) => sendJson(res, { ...okJson('openai', 'private-real-z', 'PRIMARY'), error: null, system_fingerprint: 'fp_safe_fixture' }));
    const gw = await gateway(s, [model('openai', 'good', prim.base)]);
    const r = await chat(s, gw.base, 'good');
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.choices[0].message.content, 'PRIMARY');
    assert.equal(r.json.system_fingerprint, 'fp_safe_fixture');
    assert.equal(r.json.model, 'good');
  });

  // F3: security.pii must reject unknown or non-string entries at load time. Each case uses an explicit absolute temp path.
  const f3Load = (s, security) => {
    const dir = mkdtempSync(join(tmpdir(), 'kapi-f3-'));
    s.final(() => rmSync(dir, { recursive: true, force: true }));
    const p = join(dir, 'fixture-kapi.yaml');
    const doc = { models: [{ name: 'fixture', provider: 'ollama', model: 'synthetic' }] };
    if (security !== undefined) doc.security = security;
    writeFileSync(p, JSON.stringify(doc));
    return () => loadConfig(p);
  };
  for (const [name, pii] of [['unknown-only', ['tc_kimlik']], ['mixed', ['tckn', 'bad_type']], ['non-string', [null, 42, {}]]]) {
    await t.test(`F3 rejects ${name} pii list`, (st) => {
      const s = scope(st);
      assert.throws(f3Load(s, { redact_pii: true, pii }), ConfigError);
    });
  }
  await t.test('F3 canonical+alias list loads, preserved, resolves all 4 for non-Ollama', (st) => {
    const s = scope(st);
    const list = [' TC ', 'phone', 'e-posta', 'iban'];
    const cfg = f3Load(s, { redact_pii: true, pii: list })();
    assert.deepEqual(cfg.security.pii, list);
    const types = resolveTypes(cfg, { provider: 'openai-compatible', api_base: 'http://127.0.0.1:1' });
    assert.deepEqual([...types].sort(), ['email', 'iban', 'tckn', 'telefon']);
  });
  await t.test('F3 empty list + global true uses ALL_TYPES', (st) => {
    const s = scope(st);
    const cfg = f3Load(s, { redact_pii: true, pii: [] })();
    assert.deepEqual([...resolveTypes(cfg, { provider: 'anthropic' })].sort(), ['email', 'iban', 'tckn', 'telefon']);
  });
  await t.test('F3 omitted security keeps redaction off', (st) => {
    const s = scope(st);
    const cfg = f3Load(s, undefined)();
    assert.equal(cfg.security.redact_pii, false);
    assert.equal(resolveTypes(cfg, { provider: 'openai-compatible' }), null);
  });
});
