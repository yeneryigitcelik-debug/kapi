// Uçtan uca test — sahte upstream'lerle, gerçek model gerektirmez.
// createGateway'i doğrudan kullanır. 16 assertion; hepsi geçmeli.
import http from 'node:http';
import { createGateway } from './src/core/server.js';

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

// --- Sahte upstream 1: OK. Aldığı gerçek model adını `cevap` alanında geri verir. ---
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
      cevap: parsed.model, // özel alan: maskelenmez, gerçek modeli doğrulamak için
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

// --- Sahte upstream 3: SSE stream (Mer + haba + [DONE]). ---
const streamServer = http.createServer((req, res) => {
  drainThen(req, () => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.write('data: {"choices":[{"delta":{"content":"Mer"}}]}\n\n');
    res.write('data: {"choices":[{"delta":{"content":"haba"}}]}\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
  });
});

async function main() {
  const okPort = await listen(okServer);
  const badPort = await listen(badServer);
  const streamPort = await listen(streamServer);

  const okBase = `http://127.0.0.1:${okPort}`;
  const badBase = `http://127.0.0.1:${badPort}`;
  const streamBase = `http://127.0.0.1:${streamPort}`;

  const KEY = 'gizli-anahtar';
  const cfg = {
    server: { host: '127.0.0.1', port: 0 },
    security: { require_key: true, keys: [KEY], log_bodies: false },
    routing: { fallbacks: { bozuk: ['yerel-hizli'] }, timeout_ms: 5000 },
    models: [
      { name: 'yerel-hizli', provider: 'openai-compatible', model: 'gercek-hizli', api_base: okBase },
      { name: 'yerel-buyuk', provider: 'openai-compatible', model: 'gercek-buyuk', api_base: okBase },
      { name: 'bozuk', provider: 'openai-compatible', model: 'gercek-bozuk', api_base: badBase },
      { name: 'bozuk-yalniz', provider: 'openai-compatible', model: 'gercek-bozuk-2', api_base: badBase },
      { name: 'akan', provider: 'openai-compatible', model: 'gercek-akan', api_base: streamBase },
    ],
  };

  const gw = createGateway(cfg);
  const gwPort = await listen(gw);
  const base = `http://127.0.0.1:${gwPort}`;

  const chat = (model, { key, stream = false } = {}) =>
    fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'selam' }], stream }),
    });

  console.log('\nkapı — uçtan uca test\n');

  // --- AUTH ---
  const noKey = await chat('yerel-hizli');
  assert(noKey.status === 401, 'anahtarsız istek → 401');

  const wrongKey = await chat('yerel-hizli', { key: 'yanlis' });
  assert(wrongKey.status === 401, 'yanlış anahtar → 401');

  const good = await chat('yerel-hizli', { key: KEY });
  assert(good.status === 200, 'doğru anahtar → 200');
  const goodJson = await good.json();
  assert(goodJson.cevap === 'gercek-hizli', 'upstream gerçek model adını aldı (gercek-hizli)');
  assert(goodJson.model === 'yerel-hizli', 'yanıt takma ada maskelendi (yerel-hizli)');

  // --- /v1/models (model maskeleme) ---
  const modelsRes = await fetch(`${base}/v1/models`, { headers: { Authorization: `Bearer ${KEY}` } });
  const modelsJson = await modelsRes.json();
  const ids = (modelsJson.data || []).map((m) => m.id);
  assert(ids.includes('yerel-hizli') && ids.includes('akan'), '/v1/models takma adları listeler');
  assert(!JSON.stringify(modelsJson).includes('gercek-hizli'), '/v1/models gerçek model adını sızdırmaz');

  // --- /health (auth'suz) ---
  const health = await fetch(`${base}/health`);
  const healthJson = await health.json();
  assert(health.status === 200 && healthJson.status === 'ok', '/health auth\'suz → 200 ok');
  assert(healthJson.models === 5, '/health doğru model sayısını bildirir (5)');

  // --- FALLBACK ---
  const fb = await chat('bozuk', { key: KEY }); // bozuk(500) → yerel-hizli
  assert(fb.status === 200, 'fallback: birincil(500) → yedek ile 200');
  const fbJson = await fb.json();
  assert(fbJson.cevap === 'gercek-hizli', 'fallback doğru yedek modele gitti (gercek-hizli)');

  // --- HATA ---
  const lonely = await chat('bozuk-yalniz', { key: KEY }); // yedeksiz 500
  assert(lonely.status >= 500, 'yedeksiz tek model(500) → 5xx');

  const unknown = await chat('yok-boyle-model', { key: KEY });
  assert(unknown.status === 400, 'bilinmeyen model → 400');

  // --- STREAM ---
  const sres = await chat('akan', { key: KEY, stream: true });
  const ctype = sres.headers.get('content-type') || '';
  assert(ctype.includes('text/event-stream'), 'stream: content-type event-stream');
  const stext = await sres.text();
  assert(stext.includes('Mer') && stext.includes('haba'), 'stream: parçalar aktarıldı (Merhaba)');
  assert(stext.includes('[DONE]'), 'stream: [DONE] ile bitti');

  // --- Özet ---
  console.log(`\n${passed}/${passed + failed} geçti\n`);

  await Promise.all([
    new Promise((r) => gw.close(r)),
    new Promise((r) => okServer.close(r)),
    new Promise((r) => badServer.close(r)),
    new Promise((r) => streamServer.close(r)),
  ]);

  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('test çöktü:', err);
  process.exit(1);
});
