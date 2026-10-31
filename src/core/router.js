// Yönlendirme: scope → model çöz → fallback zinciri → (gerekirse) PII maskele →
// commit öncesi tam JSON / ilk SSE olayı → istemciye aktar (+ model maskeleme).
import { getProvider, ProviderError } from '../providers/index.js';
import { readJsonBody } from '../providers/base.js';
import { resolveTypes, redactMessages } from '../security/pii.js';

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function buildChain(requested, fallbacks, modelIndex) {
  const chain = [requested];
  for (const f of fallbacks?.[requested] ?? []) {
    if (!chain.includes(f) && modelIndex.has(f)) chain.push(f);
  }
  return chain;
}

// 5xx / 429 / ağ (status yok) → yedeğe geç. 4xx (≠429, 499 dahil) → hemen fırlat.
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
const FINISH = new Set(['stop', 'length', 'tool_calls', 'content_filter', 'function_call']);
const STREAM_CODES = new Set(['upstream_stream_error', 'upstream_stream_truncated']);
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Çerçeve-farkında SSE okuyucu: maskelenmiş OpenAI olaylarını tek tek verir.
// Geçerli sonlandırıcı: [DONE] ya da finish_reason. Yoksa/upstream hata çerçevesi → ProviderError.
function sseEvents(body, alias) {
  const reader = body.getReader();
  const dec = new TextDecoder();
  const queue = [];
  let buf = '';
  let done = false;
  let sawDone = false;
  let sawFinish = false;
  let sawChoice = false;
  const CAP = 256;
  const term = new Map();
  let overflow = false;

  const handle = (block) => {
    const other = [];
    const data = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      else if (line && !line.startsWith(':')) other.push(line);
    }
    if (!data.length) return;
    const payload = data.join('\n');
    if (payload.trim() === '[DONE]') {
      if (!sawChoice) {
        throw new ProviderError('Üst sunucu akışı erken kapandı.', 502, 'upstream_stream_truncated');
      }
      sawDone = true;
      queue.push('data: [DONE]');
      return;
    }
    let obj = null;
    try {
      obj = JSON.parse(payload);
    } catch {
      obj = null;
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj) || obj.error) {
      throw new ProviderError('Üst sunucu akış hatası.', 502, 'upstream_stream_error');
    }
    if (Object.hasOwn(obj, 'choices')) {
      if (!Array.isArray(obj.choices) || !obj.choices.every(isPlainObject) || (!sawChoice && obj.choices.length === 0)) {
        throw new ProviderError('Üst sunucu akış hatası.', 502, 'upstream_stream_error');
      }
      if (obj.choices.length) sawChoice = true;
      for (const c of obj.choices) {
        const fin = FINISH.has(c.finish_reason);
        const idx = c.index;
        if (Number.isSafeInteger(idx) && idx >= 0) {
          if (term.has(idx)) {
            if (fin) term.set(idx, true);
          } else if (term.size < CAP) {
            term.set(idx, fin);
          } else {
            overflow = true;
          }
        }
      }
    }
    if ('model' in obj) obj.model = alias;
    if (Array.isArray(obj.choices) && obj.choices.some((c) => FINISH.has(c?.finish_reason))) sawFinish = true;
    queue.push([...other, 'data: ' + JSON.stringify(obj)].join('\n'));
  };

  return {
    async next() {
      for (;;) {
        if (queue.length) return queue.shift();
        if (done) return null;
        let r;
        try {
          r = await reader.read();
        } catch (e) {
          throw e instanceof ProviderError ? e : new ProviderError('Üst sunucu akış hatası.', 502, 'upstream_stream_error');
        }
        buf += r.done ? dec.decode() : dec.decode(r.value, { stream: true });
        buf = buf.replace(/\r\n/g, '\n').replace(/\r(?=[^\n])/g, '\n');
        let i;
        while (!sawDone && (i = buf.indexOf('\n\n')) !== -1) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          handle(block);
        }
        if (sawDone) {
          done = true;
          reader.cancel().catch(() => {});
          continue;
        }
        if (r.done) {
          if (buf.replace(/\r/g, '').trim()) handle(buf.replace(/\r/g, ''));
          buf = '';
          done = true;
          if (!sawDone) {
            let complete = sawFinish;
            if (term.size > 0) {
              complete = !overflow;
              if (complete) {
                for (const v of term.values()) {
                  if (v !== true) {
                    complete = false;
                    break;
                  }
                }
              }
            }
            if (!complete) {
              queue.length = 0;
              throw new ProviderError('Üst sunucu akışı erken kapandı.', 502, 'upstream_stream_truncated');
            }
          }
        }
      }
    },
    cancel() {
      reader.cancel().catch(() => {});
    },
  };
}

// drain / close / istemci iptali → resolve; deneme başına mutlak deadline → 504 reject.
function waitDrain(res, signal, deadlineAt) {
  return new Promise((resolve, reject) => {
    if (signal.aborted || res.destroyed || res.writableEnded) return resolve();
    const remaining = deadlineAt - Date.now();
    if (!(remaining > 0)) return reject(new ProviderError('Üst sunucu zaman aşımı.', 504));
    let timer = null;
    const cleanup = () => {
      clearTimeout(timer);
      res.off('drain', fin);
      res.off('close', fin);
      signal.removeEventListener('abort', fin);
    };
    const fin = () => {
      cleanup();
      resolve();
    };
    timer = setTimeout(() => {
      cleanup();
      reject(new ProviderError('Üst sunucu zaman aşımı.', 504));
    }, remaining);
    res.on('drain', fin);
    res.on('close', fin);
    signal.addEventListener('abort', fin);
  });
}

export async function route({ body, cfg, modelIndex, res, log, ctx = {}, allowedModels = null }) {
  const requested = body?.model;
  if (!requested || typeof requested !== 'string') {
    throw httpError(400, "İstekte 'model' alanı zorunlu.");
  }
  if (!modelIndex.has(requested)) {
    throw httpError(400, `Bilinmeyen model: '${requested}'.`);
  }
  if (allowedModels && !allowedModels.includes(requested)) {
    throw httpError(403, `Bu anahtar '${requested}' modeline yetkili değil.`);
  }

  let chain = buildChain(requested, cfg.routing?.fallbacks, modelIndex);
  if (allowedModels) chain = chain.filter((m) => allowedModels.includes(m));

  const timeoutMs = cfg.routing?.timeout_ms ?? 120000;
  const wantStream = body?.stream === true;

  // İstemci kopması (yanıt bitmeden) → mevcut deneme iptal, fallback yok.
  const ac = new AbortController();
  const onClose = () => {
    if (!res.writableFinished) {
      ctx.clientAborted = true;
      ac.abort();
    }
  };
  res.on('close', onClose);
  if (res.destroyed || res.socket?.destroyed) onClose();

  try {
    let lastErr;
    let attempts = 0;
    for (const name of chain) {
      if (ac.signal.aborted) break;
      attempts++;
      const modelCfg = modelIndex.get(name);
      const provider = getProvider(modelCfg.provider);

      const types = resolveTypes(cfg, modelCfg);
      let sendBody = body;
      let redacted = {};
      if (types) {
        const r = redactMessages(body.messages, types);
        sendBody = { ...body, messages: r.messages };
        redacted = r.counts;
      }

      const deadlineAt = Date.now() + timeoutMs;
      let upstream;
      let events;
      let first;
      let json;
      try {
        upstream = await provider.chat(modelCfg, sendBody, { timeoutMs, signal: ac.signal });
        if (wantStream) {
          if (!upstream.body) throw new ProviderError('Üst sunucu akışı boş.', 502, 'upstream_stream_truncated');
          events = sseEvents(upstream.body, requested);
          first = await events.next(); // commit öncesi ilk olay
        } else {
          json = await readJsonBody(upstream);
          upstream.cancelUpstream?.();
          if (
            !json || typeof json !== 'object' || json.error ||
            !Array.isArray(json.choices) ||
            !json.choices.length ||
            !json.choices.every(isPlainObject)
          ) {
            throw new ProviderError('Üst sunucu geçersiz yanıt döndürdü.', 502, 'upstream_invalid_response');
          }
        }
      } catch (err) {
        events?.cancel();
        upstream?.cancelUpstream?.();
        if (ac.signal.aborted) break;
        lastErr = err;
        if (err?.hint) log?.warn?.(`model '${name}': ${err.hint}`);
        if (!isRetryable(err?.status)) throw err;
        log?.warn?.(`model '${name}' başarısız (${err?.status ?? 'ağ'}); zincirde sıradaki deneniyor.`);
        continue;
      }

      if (ac.signal.aborted) {
        events?.cancel();
        upstream?.cancelUpstream?.();
        break;
      }

      ctx.resolved = name;
      ctx.provider = modelCfg.provider;
      ctx.fallback = name !== requested;
      ctx.attempts = attempts;
      if (Object.keys(redacted).length) ctx.redacted = redacted;

      if (wantStream) {
        res.writeHead(200, STREAM_HEADERS);
        try {
          let ev = first;
          while (ev !== null && !ac.signal.aborted) {
            if (!res.write(ev + '\n\n')) await waitDrain(res, ac.signal, deadlineAt);
            if (ac.signal.aborted) break;
            ev = await events.next();
          }
        } catch (err) {
          if (!ac.signal.aborted && !res.destroyed) {
            const timedOut = err?.status === 504;
            const code = timedOut ? 'upstream_timeout' : STREAM_CODES.has(err?.code) ? err.code : 'upstream_stream_error';
            ctx.streamError = code;
            ctx.status = timedOut ? 504 : 502;
            res.write(
              'data: ' +
                JSON.stringify({ error: { message: 'Üst sunucu akışı kesildi.', type: 'api_error', code } }) +
                '\n\n'
            );
          }
        } finally {
          events.cancel();
          upstream.cancelUpstream?.();
          if (ac.signal.aborted) ctx.status = 499;
          else if (!res.destroyed) res.end();
        }
        return;
      }

      json.model = requested; // model maskeleme
      const payload = JSON.stringify(json);
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      });
      res.end(payload);
      return;
    }

    ctx.attempts = attempts;
    if (ac.signal.aborted) {
      ctx.status = 499;
      throw new ProviderError('İstemci isteği iptal etti.', 499);
    }
    throw lastErr ?? httpError(502, 'Tüm modeller başarısız oldu.');
  } finally {
    res.off('close', onClose);
  }
}
