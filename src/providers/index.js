// Sağlayıcı kayıt defteri. Her adaptör chat(modelCfg, body, {timeoutMs}) → OpenAI-formatlı
// fetch Response döndürür (router provider-agnostik kalır; çeviri sağlayıcının işi).
import { ProviderError, trimSlash, fetchWithTimeout } from './base.js';
import { anthropic } from './anthropic.js';

export { ProviderError };

function buildHeaders(modelCfg) {
  const headers = { 'Content-Type': 'application/json', ...(modelCfg.headers || {}) };
  if (modelCfg.api_key) headers['Authorization'] = `Bearer ${modelCfg.api_key}`;
  return headers;
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
      throw new ProviderError(`Sağlayıcı hatası (${res.status}) — model '${modelCfg.name}'.`, res.status);
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
  anthropic,
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
