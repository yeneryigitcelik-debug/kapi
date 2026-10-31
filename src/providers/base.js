// Sağlayıcı adaptörleri için paylaşılan temel: hata tipi + toplam süreli fetch.
// (Ayrı dosya — index.js ↔ anthropic.js döngüsel import'unu önler.)

export class ProviderError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = 'ProviderError';
    this.status = status; // 5xx/429/network → fallback; 4xx (≠429) → hemen hata; 499 → iptal.
    if (code) this.code = code;
  }
}

export function trimSlash(s) {
  return String(s || '').replace(/\/+$/, '');
}

const NULL_BODY = new Set([101, 204, 205, 304]);

// timeoutMs = deneme başına TOPLAM süre (başlıklar + gövdenin tamamı).
// Dönen Response'un gövdesi EOF/hata/iptal olana dek deadline altındadır.
// res.cancelUpstream() → fetch/gövdeyi hemen iptal eder.
export async function fetchWithTimeout(url, opts = {}, timeoutMs, callerSignal) {
  const ctrl = new AbortController();
  let reason = null;
  let finished = false;
  let timer = null;
  const onCaller = () => abort('cancel');
  function cleanup() {
    finished = true;
    if (timer) clearTimeout(timer);
    callerSignal?.removeEventListener?.('abort', onCaller);
  }
  function abort(r) {
    if (finished) return;
    reason = r;
    cleanup();
    ctrl.abort();
  }
  const toErr = (e) => {
    if (e instanceof ProviderError) return e;
    if (reason === 'timeout') return new ProviderError(`Üst sunucu zaman aşımı (${timeoutMs}ms).`, 504);
    if (reason === 'cancel') return new ProviderError('İstek iptal edildi.', 499);
    return new ProviderError('Üst sunucuya ulaşılamadı.', 502);
  };

  if (callerSignal?.aborted) throw new ProviderError('İstek iptal edildi.', 499);
  timer = setTimeout(() => abort('timeout'), timeoutMs);
  callerSignal?.addEventListener?.('abort', onCaller, { once: true });

  let res;
  try {
    res = await fetch(url, { ...opts, redirect: 'error', signal: ctrl.signal });
  } catch (e) {
    const err = toErr(e);
    cleanup();
    throw err;
  }

  if (!res.body || NULL_BODY.has(res.status)) {
    cleanup();
    res.cancelUpstream = () => {};
    return res;
  }

  const src = res.body.getReader();
  const body = new ReadableStream({
    async pull(c) {
      try {
        const { value, done } = await src.read();
        if (done) {
          cleanup();
          c.close();
          return;
        }
        c.enqueue(value);
      } catch (e) {
        const err = toErr(e);
        cleanup();
        c.error(err);
      }
    },
    cancel() {
      abort('cancel');
      cleanup();
      return src.cancel().catch(() => {});
    },
  });
  const out = new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
  out.cancelUpstream = () => {
    abort('cancel');
    cleanup();
    src.cancel().catch(() => {});
  };
  return out;
}

// Gövdenin tamamını oku + JSON ayrıştır. Bozuk/kesik gövde → 502.
export async function readJsonBody(res) {
  const chunks = [];
  if (res.body) {
    const reader = res.body.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        chunks.push(Buffer.from(value));
      }
    } catch (e) {
      reader.cancel().catch(() => {});
      throw e instanceof ProviderError ? e : new ProviderError('Üst sunucu yanıtı okunamadı.', 502);
    }
  }
  try {
    const j = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (j && typeof j === 'object' && !Array.isArray(j)) return j;
  } catch {}
  throw new ProviderError('Üst sunucudan geçersiz yanıt alındı.', 502);
}
