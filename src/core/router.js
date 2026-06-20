// Yönlendirme: model çöz → fallback zinciri → stream/JSON passthrough.
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { getProvider } from '../providers/index.js';

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
  if (status === undefined || status === null) return true; // ağ hatası
  if (status === 429) return true;
  return status >= 500;
}

async function pipeStream(webBody, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  if (!webBody) {
    res.end();
    return;
  }
  // Web ReadableStream → Node akışı → istemci. Başlık yazıldıktan sonra fallback yok.
  await pipeline(Readable.fromWeb(webBody), res);
}

export async function route({ body, cfg, modelIndex, res, log }) {
  const requested = body?.model;
  if (!requested || typeof requested !== 'string') {
    throw httpError(400, "İstekte 'model' alanı zorunlu.");
  }
  if (!modelIndex.has(requested)) {
    throw httpError(400, `Bilinmeyen model: '${requested}'.`);
  }

  const chain = buildChain(requested, cfg.routing?.fallbacks, modelIndex);
  const timeoutMs = cfg.routing?.timeout_ms ?? 120000;
  const wantStream = body?.stream === true;

  let lastErr;
  for (const name of chain) {
    const modelCfg = modelIndex.get(name);
    const provider = getProvider(modelCfg.provider);

    let upstream;
    try {
      upstream = await provider.chat(modelCfg, body, { timeoutMs });
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err?.status)) {
        throw err; // istemci hatası: başka modelde de tekrarlanır, boşuna deneme yok.
      }
      log?.warn?.(`model '${name}' başarısız (${err?.status ?? 'ağ'}); zincirde sıradaki deneniyor.`);
      continue;
    }

    // Buraya geldiysek upstream OK — bu yanıta bağlandık, artık fallback yok.
    if (wantStream) {
      await pipeStream(upstream.body, res);
      return;
    }

    const json = await upstream.json();
    // Model maskeleme: yanıttaki gerçek model adını istenen takma adla değiştir.
    json.model = requested;
    const payload = JSON.stringify(json);
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    });
    res.end(payload);
    return;
  }

  // Zincir tükendi.
  throw lastErr ?? httpError(502, 'Tüm modeller başarısız oldu.');
}
