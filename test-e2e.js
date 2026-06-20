// Uçtan uca test — sahte upstream'lerle, gerçek model gerektirmez.
// PII birim testleri + gateway e2e (auth, maskeleme, fallback, stream, redaksiyon, scope, audit).
import http from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateway } from './src/core/server.js';
import { isValidTCKN, isValidIBAN_TR, redactText } from './src/security/pii.js';
import { toAnthropicRequest, toOpenAIResponse } from './src/providers/anthropic.js';

let passed = 0;
let failed = 0;
function assert(cond, label) {
  if (cond) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  } else {
    failed++;
    console.log(`  \x1b[31m✗\x1b[0m ${label}`);
  }
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function drainThen(req, fn) {
  req.on('data', () => {});
  req.on('end', fn);
}

// --- Sahte upstream 1: OK. Aldığı model adını + içeriği geri yansıtır. ---
const okServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    let parsed = {};
    try {
      parsed = JSON.parse(body || '{}');
    } catch {}
    const payload = JSON.stringify({
      id: 'chatcmpl-test',
      object: 'chat.completion',
      model: parsed.model, // gateway bunu takma adla maskeleyecek
      cevap: parsed.model, // özel alan: gerçek modeli doğrulamak için (maskelenmez)
      received_content: parsed.messages?.[0]?.content ?? null, // redaksiyonu doğrulamak için
      choices: [{ index: 0, message: { role: 'assistant', content: 'merhaba' }, finish_reason: 'stop' }],
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(payload);
  });
});

// --- Sahte upstream 2: her zaman 500. ---
const badServer = http.createServer((req, res) => {
  drainThen(req, () => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'patladi' }));
  });
});

// --- Sahte upstream 3: SSE stream (model alanı dahil — maskeleme testi için). ---
const streamServer = http.createServer((req, res) => {
  drainThen(req, () => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.write('data: {"model":"gercek-akan","choices":[{"delta":{"content":"Mer"}}]}\n\n');
    res.write('data: {"model":"gercek-akan","choices":[{"delta":{"content":"haba"}}]}\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
  });
});

// --- Sahte upstream 4: Anthropic Messages API (header + max_tokens katı). ---
const anthropicServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.headers['x-api-key'] !== 'anthropic-test-key' || !req.headers['anthropic-version']) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { message: 'auth' } }));
      return;
    }
    let p = {};
    try {
      p = JSON.parse(body || '{}');
    } catch {}
    if (typeof p.max_tokens !== 'number') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { message: 'max_tokens gerekli' } }));
      return;
    }
    // Aldıklarını metne yansıt → çeviriyi (model adı, system, max_tokens) doğrulamak için.
    const echo = `model=${p.model};system=${p.system || ''};mt=${p.max_tokens}`;
    if (p.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('event: message_start\ndata: {"type":"message_start","message":{"model":"' + p.model + '"}}\n\n');
      res.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Mer"}}\n\n');
      res.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"haba"}}\n\n');
      res.write('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n');
      res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
      res.end();
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: p.model,
          content: [{ type: 'text', text: echo }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 5, output_tokens: 3 },
        })
      );
    }
  });
});

async function main() {
  // ============ PII birim testleri (sunucusuz) ============
  console.log('\nkapı — PII birim testleri\n');
  assert(isValidTCKN('10000000146') === true, 'TCKN: geçerli numara kabul');
  assert(isValidTCKN('12345678901') === false, 'TCKN: checksum tutmayan reddedildi');
  assert(isValidIBAN_TR('TR330006100519786457841326') === true, 'IBAN: mod-97 geçerli kabul');
  assert(isValidIBAN_TR('TR000000000000000000000000') === false, 'IBAN: geçersiz reddedildi');
  {
    const r = redactText('TC 10000000146 mail ahmet@example.com', ['tckn', 'email']);
    assert(r.text.includes('[TCKN]') && !r.text.includes('10000000146'), 'redact: TCKN maskelendi, ham yok');
    assert(r.text.includes('[E-POSTA]') && !r.text.includes('ahmet@example.com'), 'redact: e-posta maskelendi');
  }

  console.log('\nkapı — Anthropic çeviri birim testleri\n');
  {
    const areq = toAnthropicRequest(
      { messages: [{ role: 'system', content: 'Sen yardımcısın' }, { role: 'user', content: 'selam' }] },
      { model: 'claude-x' }
    );
    assert(areq.system === 'Sen yardımcısın' && areq.messages.length === 1, 'anthropic: system mesajı üst seviyeye taşındı');
    assert(typeof areq.max_tokens === 'number' && areq.max_tokens > 0, 'anthropic: max_tokens varsayılanı eklendi');
    const oai = toOpenAIResponse(
      { id: 'm1', content: [{ type: 'text', text: 'cevap' }], stop_reason: 'end_turn', usage: { input_tokens: 7, output_tokens: 2 } },
      'claude-x'
    );
    assert(oai.choices[0].message.content === 'cevap' && oai.object === 'chat.completion', 'anthropic: yanıt OpenAI şekline çevrildi');
    assert(oai.usage.prompt_tokens === 7 && oai.usage.total_tokens === 9, 'anthropic: usage çevrildi');
  }

  // ============ Gateway e2e ============
  const okPort = await listen(okServer);
  const badPort = await listen(badServer);
  const streamPort = await listen(streamServer);
  const anthropicPort = await listen(anthropicServer);
  const okBase = `http://127.0.0.1:${okPort}`;
  const badBase = `http://127.0.0.1:${badPort}`;
  const streamBase = `http://127.0.0.1:${streamPort}`;
  const anthropicBase = `http://127.0.0.1:${anthropicPort}`;

  const KEY = 'gizli-anahtar';
  const SCOPED = 'scoped-anahtar';
  const auditPath = join(mkdtempSync(join(tmpdir(), 'kapi-audit-')), 'audit.jsonl');

  const cfg = {
    server: { host: '127.0.0.1', port: 0 },
    security: {
      require_key: true,
      keys: [KEY, { key: SCOPED, models: ['yerel-hizli'] }],
      log_bodies: false,
      redact_pii: true,
      pii: ['tckn', 'telefon', 'email', 'iban'],
      audit_log: auditPath,
    },
    routing: { fallbacks: { bozuk: ['yerel-hizli'] }, timeout_ms: 5000 },
    models: [
      { name: 'yerel-hizli', provider: 'openai-compatible', model: 'gercek-hizli', api_base: okBase },
      { name: 'yerel-buyuk', provider: 'openai-compatible', model: 'gercek-buyuk', api_base: okBase },
      { name: 'bozuk', provider: 'openai-compatible', model: 'gercek-bozuk', api_base: badBase },
      { name: 'bozuk-yalniz', provider: 'openai-compatible', model: 'gercek-bozuk-2', api_base: badBase },
      { name: 'akan', provider: 'openai-compatible', model: 'gercek-akan', api_base: streamBase },
      { name: 'yerel-ollama', provider: 'ollama', model: 'qwen-yerel', api_base: okBase }, // yerel → maskeleme YOK
      { name: 'claude', provider: 'anthropic', model: 'claude-gercek', api_base: anthropicBase, api_key: 'anthropic-test-key', max_tokens: 256 },
    ],
  };

  const gw = createGateway(cfg);
  const gwPort = await listen(gw);
  const base = `http://127.0.0.1:${gwPort}`;

  const chat = (model, { key, stream = false, content = 'selam' } = {}) =>
    fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({ model, messages: [{ role: 'user', content }], stream }),
    });

  console.log('\nkapı — gateway e2e\n');

  // --- AUTH + maskeleme ---
  assert((await chat('yerel-hizli')).status === 401, 'anahtarsız istek → 401');
  assert((await chat('yerel-hizli', { key: 'yanlis' })).status === 401, 'yanlış anahtar → 401');

  const good = await chat('yerel-hizli', { key: KEY });
  assert(good.status === 200, 'doğru anahtar → 200');
  const goodJson = await good.json();
  assert(goodJson.cevap === 'gercek-hizli', 'upstream gerçek model adını aldı (gercek-hizli)');
  assert(goodJson.model === 'yerel-hizli', 'yanıt takma ada maskelendi (yerel-hizli)');

  const modelsJson = await (await fetch(`${base}/v1/models`, { headers: { Authorization: `Bearer ${KEY}` } })).json();
  const ids = (modelsJson.data || []).map((m) => m.id);
  assert(ids.includes('yerel-hizli') && ids.includes('akan'), '/v1/models takma adları listeler');
  assert(!JSON.stringify(modelsJson).includes('gercek-hizli'), '/v1/models gerçek model adını sızdırmaz');

  const health = await fetch(`${base}/health`);
  const healthJson = await health.json();
  assert(health.status === 200 && healthJson.status === 'ok', "/health auth'suz → 200 ok");
  assert(healthJson.models === 7, '/health doğru model sayısını bildirir (7)');

  // --- FALLBACK + HATA ---
  const fb = await chat('bozuk', { key: KEY });
  assert(fb.status === 200, 'fallback: birincil(500) → yedek ile 200');
  assert((await fb.json()).cevap === 'gercek-hizli', 'fallback doğru yedek modele gitti');
  assert((await chat('bozuk-yalniz', { key: KEY })).status >= 500, 'yedeksiz tek model(500) → 5xx');
  assert((await chat('yok-boyle-model', { key: KEY })).status === 400, 'bilinmeyen model → 400');

  // --- STREAM (+ maskeleme) ---
  const sres = await chat('akan', { key: KEY, stream: true });
  assert((sres.headers.get('content-type') || '').includes('text/event-stream'), 'stream: content-type event-stream');
  const stext = await sres.text();
  assert(stext.includes('Mer') && stext.includes('haba'), 'stream: parçalar aktarıldı (Merhaba)');
  assert(stext.includes('[DONE]'), 'stream: [DONE] ile bitti');
  assert(stext.includes('"model":"akan"') && !stext.includes('gercek-akan'), 'stream: model alanı da maskelendi');

  // --- Anthropic native provider (OpenAI ↔ Messages çevirisi) ---
  const an = await chat('claude', { key: KEY });
  assert(an.status === 200, 'anthropic: non-stream → 200');
  const anJson = await an.json();
  assert(anJson.model === 'claude', 'anthropic: yanıt takma ada maskelendi');
  assert((anJson.choices?.[0]?.message?.content || '').includes('model=claude-gercek'), "anthropic: gerçek model adı upstream'e çevrildi");
  assert((anJson.choices?.[0]?.message?.content || '').includes('mt=256'), 'anthropic: max_tokens eklendi (Messages API zorunlu)');
  assert(anJson.usage?.prompt_tokens === 5, 'anthropic: usage OpenAI şekline çevrildi');

  const anSys = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: 'claude', messages: [{ role: 'system', content: 'Sistem-X' }, { role: 'user', content: 'selam' }] }),
  });
  assert(((await anSys.json()).choices?.[0]?.message?.content || '').includes('system=Sistem-X'), 'anthropic: system mesajı Messages system alanına çevrildi');

  const anStream = await chat('claude', { key: KEY, stream: true });
  assert((anStream.headers.get('content-type') || '').includes('text/event-stream'), 'anthropic stream: content-type event-stream');
  const anStreamText = await anStream.text();
  assert(anStreamText.includes('Mer') && anStreamText.includes('haba'), 'anthropic stream: Anthropic SSE → OpenAI delta çevrildi');
  assert(anStreamText.includes('[DONE]'), 'anthropic stream: [DONE] üretildi');
  assert(anStreamText.includes('"model":"claude"') && !anStreamText.includes('claude-gercek'), 'anthropic stream: model maskelendi');

  // --- PII redaksiyonu ---
  const PII = 'Müşteri TC 10000000146, tel 0532 123 45 67, mail ahmet@example.com, IBAN TR33 0006 1005 1978 6457 8413 26';
  const ext = await (await chat('yerel-hizli', { key: KEY, content: PII })).json();
  const rc = ext.received_content || '';
  assert(
    rc.includes('[TCKN]') && rc.includes('[E-POSTA]') && rc.includes('[TELEFON]') && rc.includes('[IBAN]'),
    'PII: dış sağlayıcıya giden içerik maskelendi (4 tip)'
  );
  assert(
    !rc.includes('10000000146') && !rc.includes('ahmet@example.com'),
    'PII: ham hassas veri dış sağlayıcıya GİTMEDİ'
  );
  const loc = await (await chat('yerel-ollama', { key: KEY, content: PII })).json();
  assert((loc.received_content || '').includes('10000000146'), 'PII: yerel ollama maskelenmez (ham içerik gider)');

  // --- Per-key scope ---
  assert((await chat('yerel-hizli', { key: SCOPED })).status === 200, 'scope: izinli model → 200');
  assert((await chat('yerel-buyuk', { key: SCOPED })).status === 403, 'scope: izinsiz model → 403');
  assert((await chat('bozuk', { key: SCOPED })).status === 403, 'scope: izinsiz (fallback yoluyla bile) → 403');
  const scopedModels = await (await fetch(`${base}/v1/models`, { headers: { Authorization: `Bearer ${SCOPED}` } })).json();
  const scopedIds = (scopedModels.data || []).map((m) => m.id);
  assert(scopedIds.length === 1 && scopedIds[0] === 'yerel-hizli', 'scope: /v1/models yalnız izinli modeli gösterir');

  // --- Audit log (metadata, içerik YOK) ---
  const auditRaw = readFileSync(auditPath, 'utf8');
  const auditLines = auditRaw.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert(
    auditLines.some((e) => e.model === 'yerel-hizli' && e.status === 200 && typeof e.ms === 'number'),
    'audit: metadata satırı yazıldı (model + status + ms)'
  );
  assert(
    !auditRaw.includes('selam') && !auditRaw.includes('10000000146') && !auditRaw.includes('ahmet@example.com'),
    'audit: prompt/PII içeriği loglanMADI (KVKK)'
  );

  // --- Özet ---
  console.log(`\n${passed}/${passed + failed} geçti\n`);

  await Promise.all([
    new Promise((r) => gw.close(r)),
    new Promise((r) => okServer.close(r)),
    new Promise((r) => badServer.close(r)),
    new Promise((r) => streamServer.close(r)),
    new Promise((r) => anthropicServer.close(r)),
  ]);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('test çöktü:', err);
  process.exit(1);
});
