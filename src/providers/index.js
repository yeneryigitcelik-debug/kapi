// Sağlayıcı adaptörleri. Her biri chat(modelCfg, body, {timeoutMs}) → ham fetch Response.
// Stream/JSON'u çağıran (router) işler.

export class ProviderError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ProviderError';
    this.status = status; // 5xx/429/network → fallback; 4xx (≠429) → hemen hata.
  }
}

async function fetchWithTimeout(url, opts, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } catch (e) {
    if (e?.name === 'AbortError') {
      throw new ProviderError(`Üst sunucu zaman aşımı (${timeoutMs}ms).`, 504);
    }
    // Ağ hatası: status yok → router bunu yedeklenebilir sayar.
    const err = new ProviderError(`Üst sunucuya ulaşılamadı: ${e?.message ?? e}`, undefined);
    err.cause = e;
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function buildHeaders(modelCfg) {
  const headers = { 'Content-Type': 'application/json', ...(modelCfg.headers || {}) };
  if (modelCfg.api_key) headers['Authorization'] = `Bearer ${modelCfg.api_key}`;
  return headers;
}

function trimSlash(s) {
  return String(s || '').replace(/\/+$/, '');
}

const openaiCompatible = {
  async chat(modelCfg, body, { timeoutMs }) {
    const base = trimSlash(modelCfg.api_base);
    if (!base) {
      throw new ProviderError(`Model '${modelCfg.name}' için api_base gerekli.`, 400);
    }
    const url = `${base}/chat/completions`;
    // Takma adı gerçek model adıyla değiştir.
    const payload = JSON.stringify({ ...body, model: modelCfg.model });
    const res = await fetchWithTimeout(
      url,
      { method: 'POST', headers: buildHeaders(modelCfg), body: payload },
      timeoutMs
    );
    if (!res.ok) {
      throw new ProviderError(
        `Sağlayıcı hatası (${res.status}) — model '${modelCfg.name}'.`,
        res.status
      );
    }
    return res;
  },
};

const ollama = {
  async chat(modelCfg, body, { timeoutMs }) {
    // Ollama'nın OpenAI-uyumlu ucu.
    const base = trimSlash(modelCfg.api_base) || 'http://127.0.0.1:11434';
    const url = `${base}/v1/chat/completions`;
    const payload = JSON.stringify({ ...body, model: modelCfg.model });
    const res = await fetchWithTimeout(
      url,
      { method: 'POST', headers: buildHeaders(modelCfg), body: payload },
      timeoutMs
    );
    if (!res.ok) {
      throw new ProviderError(
        `Ollama hatası (${res.status}) — model '${modelCfg.model}'. ` +
          `Modeli indirdin mi? 'ollama pull ${modelCfg.model}'.`,
        res.status
      );
    }
    return res;
  },
};

const REGISTRY = {
  'openai-compatible': openaiCompatible,
  ollama,
};

export function getProvider(name) {
  const provider = REGISTRY[name];
  if (!provider) {
    throw new ProviderError(
      `Bilinmeyen sağlayıcı: '${name}'. Geçerli: ${Object.keys(REGISTRY).join(', ')}.`,
      400
    );
  }
  return provider;
}
