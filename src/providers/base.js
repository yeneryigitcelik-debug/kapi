// Sağlayıcı adaptörleri için paylaşılan temel: hata tipi + timeout'lu fetch.
// (Ayrı dosya — index.js ↔ anthropic.js döngüsel import'unu önler.)

export class ProviderError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ProviderError';
    this.status = status; // 5xx/429/network → fallback; 4xx (≠429) → hemen hata.
  }
}

export function trimSlash(s) {
  return String(s || '').replace(/\/+$/, '');
}

export async function fetchWithTimeout(url, opts, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } catch (e) {
    if (e?.name === 'AbortError') {
      throw new ProviderError(`Üst sunucu zaman aşımı (${timeoutMs}ms).`, 504);
    }
    const err = new ProviderError(`Üst sunucuya ulaşılamadı: ${e?.message ?? e}`, undefined);
    err.cause = e;
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
