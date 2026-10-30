// Anthropic native sağlayıcı: OpenAI chat formatı ↔ Anthropic Messages API çevirisi (yalnız metin).
import { ProviderError, trimSlash, fetchWithTimeout, readJsonBody } from './base.js';

const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 4096;
const STOP_MAP = { end_turn: 'stop', max_tokens: 'length', stop_sequence: 'stop' };
const UNSUPPORTED = ['tools', 'tool_choice', 'functions', 'function_call', 'response_format', 'logprobs', 'top_logprobs'];
const ROLES = new Set(['system', 'user', 'assistant']);
const IGNORED_BLOCKS = new Set(['text', 'thinking', 'redacted_thinking']);
const SAFE_PART_TYPES = new Set(['image_url', 'input_audio', 'file']);
const badStop = () => new ProviderError('Üst sunucu tanınmayan bir durma nedeni döndürdü.', 502, 'upstream_stream_error');

const unsupported = (what) =>
  new ProviderError(`Anthropic sağlayıcısı ${what} desteklemiyor; kaldır ya da başka sağlayıcı kullan.`, 400, 'unsupported_parameter');
const refusal = () => new ProviderError('Sağlayıcı isteği politika gereği reddetti.', 422, 'content_policy');
const toolBlock = () => new ProviderError('Sağlayıcı desteklenmeyen içerik (araç çağrısı) döndürdü.', 502);
const streamErr = () => new ProviderError('Üst sunucu akış hatası.', 502, 'upstream_stream_error');

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (content === null || content === undefined) return '';
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (!p || typeof p !== 'object' || p.type !== 'text' || typeof p.text !== 'string') {
          const t = p && typeof p === 'object' ? p.type : undefined;
          throw unsupported(SAFE_PART_TYPES.has(t) ? `'${t}' içerik parçasını` : "'messages[].content[].type' değerini");
        }
        return p.text;
      })
      .join('');
  }
  throw new ProviderError("Geçersiz 'content' alanı (string ya da metin parçaları dizisi olmalı).", 400);
}

// OpenAI chat isteği → Anthropic Messages isteği. Desteklenmeyen alanlar → 400 (sessizce düşürme yok).
export function toAnthropicRequest(body, modelCfg) {
  for (const k of UNSUPPORTED) {
    const v = body?.[k];
    if (v !== undefined && v !== null && v !== false) throw unsupported(`'${k}' alanını`);
  }
  if (body?.n !== undefined && body?.n !== null && body.n !== 1) throw unsupported("'n' (≠1) alanını");

  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const systemParts = [];
  const out = [];
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    if (!ROLES.has(m.role)) throw unsupported("'messages[].role' değerini");
    if (m.tool_calls !== undefined && m.tool_calls !== null) throw unsupported("'tool_calls' alanını");
    if (m.function_call !== undefined && m.function_call !== null) throw unsupported("'function_call' alanını");
    const text = contentToText(m.content);
    if (m.role === 'system') {
      systemParts.push(text);
      continue;
    }
    out.push({ role: m.role, content: text });
  }

  const req = {
    model: modelCfg.model,
    max_tokens: body.max_tokens ?? body.max_completion_tokens ?? modelCfg.max_tokens ?? DEFAULT_MAX_TOKENS,
    messages: out,
  };
  if (systemParts.length) req.system = systemParts.join('\n\n');
  if (typeof body.temperature === 'number') req.temperature = body.temperature;
  if (typeof body.top_p === 'number') req.top_p = body.top_p;
  if (body.stop !== undefined && body.stop !== null) req.stop_sequences = Array.isArray(body.stop) ? body.stop : [body.stop];
  if (body.stream === true) req.stream = true;
  return req;
}

// Anthropic (non-stream) yanıtı → OpenAI chat.completion.
export function toOpenAIResponse(anthropic, modelName) {
  if (!anthropic || typeof anthropic !== 'object' || anthropic.type === 'error') {
    throw new ProviderError('Üst sunucudan geçersiz yanıt alındı.', 502);
  }
  if (anthropic.stop_reason === 'refusal') throw refusal();
  const blocks = Array.isArray(anthropic.content) ? anthropic.content : [];
  for (const b of blocks) if (!IGNORED_BLOCKS.has(b?.type)) throw toolBlock();
  if (anthropic.stop_reason === 'tool_use') throw toolBlock();
  if (typeof anthropic.stop_reason !== 'string' || !Object.hasOwn(STOP_MAP, anthropic.stop_reason)) {
    throw new ProviderError('Üst sunucu tanınmayan bir durma nedeni döndürdü.', 502);
  }
  const text = blocks.filter((b) => b.type === 'text').map((b) => (typeof b.text === 'string' ? b.text : '')).join('');
  const usage = anthropic.usage || {};
  const inTok = usage.input_tokens ?? 0;
  const outTok = usage.output_tokens ?? 0;
  return {
    id: anthropic.id || 'chatcmpl-anthropic',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: modelName,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: text },
        finish_reason: STOP_MAP[anthropic.stop_reason],
      },
    ],
    usage: { prompt_tokens: inTok, completion_tokens: outTok, total_tokens: inTok + outTok },
  };
}

// Anthropic SSE → OpenAI SSE. Kaynak hatası/erken EOF → stream ProviderError ile hata verir.
function translateStream(anthropicBody, modelName) {
  const reader = anthropicBody.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const id = 'chatcmpl-anthropic';
  const created = Math.floor(Date.now() / 1000);
  let buffer = '';
  let started = false;
  let finished = false;
  let pendingFinish = null;

  const chunk = (delta, finish = null) =>
    'data: ' +
    JSON.stringify({ id, object: 'chat.completion.chunk', created, model: modelName, choices: [{ index: 0, delta, finish_reason: finish }] }) +
    '\n\n';

  const handle = (line) => {
    if (!line.startsWith('data:')) return '';
    const payload = line.slice(5).trim();
    if (!payload) return '';
    let ev;
    try {
      ev = JSON.parse(payload);
    } catch {
      throw streamErr();
    }
    if (!ev || typeof ev !== 'object' || Array.isArray(ev)) throw streamErr();
    switch (ev.type) {
      case 'error':
        throw streamErr();
      case 'content_block_start':
        if (ev.content_block?.type && !IGNORED_BLOCKS.has(ev.content_block.type)) throw toolBlock();
        return '';
      case 'content_block_delta':
        if (ev.delta?.type === 'text_delta' && typeof ev.delta.text === 'string') {
          const d = started ? { content: ev.delta.text } : { role: 'assistant', content: ev.delta.text };
          started = true;
          return chunk(d);
        }
        return '';
      case 'message_delta': {
        const r = ev.delta?.stop_reason;
        if (!r) return '';
        if (r === 'refusal') throw refusal();
        if (r === 'tool_use') throw toolBlock();
        if (typeof r !== 'string' || !Object.hasOwn(STOP_MAP, r)) throw badStop();
        pendingFinish = STOP_MAP[r];
        return '';
      }
      case 'message_stop':
        if (!pendingFinish) throw streamErr();
        finished = true;
        return chunk({}, pendingFinish) + 'data: [DONE]\n\n';
      default:
        return '';
    }
  };

  return new ReadableStream({
    async pull(controller) {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
          let out = '';
          let nl;
          while (!finished && (nl = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            out += handle(line);
          }
          if (done && !finished && buffer.trim()) {
            out += handle(buffer.trim());
            buffer = '';
          }
          if (finished) {
            if (out) controller.enqueue(encoder.encode(out));
            controller.close();
            reader.cancel().catch(() => {});
            return;
          }
          if (out) controller.enqueue(encoder.encode(out));
          if (done) throw new ProviderError('Üst sunucu akışı erken kapandı.', 502, 'upstream_stream_truncated');
          if (out) return;
        }
      } catch (e) {
        reader.cancel().catch(() => {});
        controller.error(e instanceof ProviderError ? e : streamErr());
      }
    },
    cancel() {
      return reader.cancel().catch(() => {});
    },
  });
}

export const anthropic = {
  async chat(modelCfg, body, { timeoutMs, signal }) {
    const reqBody = JSON.stringify(toAnthropicRequest(body, modelCfg)); // ücretli çağrıdan önce doğrula
    const base = trimSlash(modelCfg.api_base) || 'https://api.anthropic.com';
    const url = `${base}/v1/messages`;
    const headers = {
      'Content-Type': 'application/json',
      'anthropic-version': modelCfg.anthropic_version || ANTHROPIC_VERSION,
      ...(modelCfg.headers || {}),
    };
    if (modelCfg.api_key) headers['x-api-key'] = modelCfg.api_key;

    const res = await fetchWithTimeout(url, { method: 'POST', headers, body: reqBody }, timeoutMs, signal);
    if (!res.ok) {
      res.cancelUpstream?.();
      throw new ProviderError(`Anthropic hatası (${res.status}) — model '${modelCfg.name}'.`, res.status);
    }

    if (body.stream === true) {
      if (!res.body) throw new ProviderError('Üst sunucu akışı boş.', 502, 'upstream_stream_truncated');
      const out = new Response(translateStream(res.body, modelCfg.model), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
      out.cancelUpstream = () => res.cancelUpstream?.();
      return out;
    }
    let openai;
    try {
      openai = toOpenAIResponse(await readJsonBody(res), modelCfg.model);
    } finally {
      res.cancelUpstream?.();
    }
    const out = new Response(JSON.stringify(openai), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
    out.cancelUpstream = () => {};
    return out;
  },
};
