// Yönlendirme: scope → model çöz → fallback zinciri → (gerekirse) PII maskele →
// stream/JSON passthrough (+ stream'de model maskeleme).
import { getProvider } from '../providers/index.js';
import { resolveTypes, redactMessages } from '../security/pii.js';

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// Deneme sırası = [istenen, ...fallbacks[istenen]] (dedup + yalnız tanımlı modeller).
function buildChain(requested, fallbacks, modelIndex) {
  const chain = [requested];
  for (const f of fallbacks?.[requested] ?? []) {
    if (!chain.includes(f) && modelIndex.has(f)) chain.push(f);
  }
  return chain;
}

// 5xx / 429 / ağ (status yok) → yedeğe geç. 4xx (≠429) → hemen fırlat.
function isRetryable(status) {
  if (status === undefined || status === null) return true;
  if (status === 429) return true;
  return status >= 500;
}

const STREAM_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
};

// Tek bir SSE satırında `model` alanını takma adla değiştir (maskeleme sızıntısını kapat).
function maskSseLine(line, alias) {
  const m = /^(data:\s*)(.*)$/.exec(line);
  if (!m) return line;
  const payload = m[2];
  if (payload === '[DONE]' || payload.trim() === '') return line;
  try {
    const obj = JSON.parse(payload);
    if (obj && typeof obj === 'object' && 'model' in obj) {
      obj.model = alias;
      return m[1] + JSON.stringify(obj);
    }
  } catch {
    /* JSON değilse olduğu gibi geç */
  }
  return line;
}

// Web ReadableStream'i satır satır okuyup maskeleyerek Node res'e aktar.
// Başlık yazıldıktan sonra fallback yok.
async function pipeMaskedStream(webBody, res, alias) {
  res.writeHead(200, STREAM_HEADERS);
  if (!webBody) {
    res.end();
    return;
  }
  const reader = webBody.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      res.write(maskSseLine(line, alias) + '\n');
    }
  }
  buffer += decoder.decode();
  if (buffer) res.write(maskSseLine(buffer, alias));
  res.end();
}

export async function route({ body, cfg, modelIndex, res, log, ctx = {}, allowedModels = null }) {
  const requested = body?.model;
  if (!requested || typeof requested !== 'string') {
    throw httpError(400, "İstekte 'model' alanı zorunlu.");
  }
  if (!modelIndex.has(requested)) {
    throw httpError(400, `Bilinmeyen model: '${requested}'.`);
  }
  // Per-key scope: anahtar bu modele yetkili mi?
  if (allowedModels && !allowedModels.includes(requested)) {
    throw httpError(403, `Bu anahtar '${requested}' modeline yetkili değil.`);
  }

  let chain = buildChain(requested, cfg.routing?.fallbacks, modelIndex);
  // Scope, fallback zincirinden de kaçışı engeller.
  if (allowedModels) chain = chain.filter((m) => allowedModels.includes(m));

  const timeoutMs = cfg.routing?.timeout_ms ?? 120000;
  const wantStream = body?.stream === true;

  let lastErr;
  let attempts = 0;
  for (const name of chain) {
    attempts++;
    const modelCfg = modelIndex.get(name);
    const provider = getProvider(modelCfg.provider);

    // PII redaksiyonu: yalnız dış sağlayıcıya giden gövde maskelenir (orijinali değişmez).
    const types = resolveTypes(cfg, modelCfg);
    let sendBody = body;
    let redacted = {};
    if (types) {
      const r = redactMessages(body.messages, types);
      sendBody = { ...body, messages: r.messages };
      redacted = r.counts;
    }

    let upstream;
    try {
      upstream = await provider.chat(modelCfg, sendBody, { timeoutMs });
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err?.status)) throw err;
      log?.warn?.(`model '${name}' başarısız (${err?.status ?? 'ağ'}); zincirde sıradaki deneniyor.`);
      continue;
    }

    // Upstream OK — bu yanıta bağlandık. Audit bağlamını doldur.
    ctx.resolved = name;
    ctx.provider = modelCfg.provider;
    ctx.fallback = name !== requested;
    ctx.attempts = attempts;
    if (Object.keys(redacted).length) ctx.redacted = redacted;

    if (wantStream) {
      await pipeMaskedStream(upstream.body, res, requested);
      return;
    }

    const json = await upstream.json();
    json.model = requested; // model maskeleme: gerçek adı istenen takma adla değiştir
    const payload = JSON.stringify(json);
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    });
    res.end(payload);
    return;
  }

  ctx.attempts = attempts;
  throw lastErr ?? httpError(502, 'Tüm modeller başarısız oldu.');
}
