// Anthropic native sağlayıcı: OpenAI chat formatı ↔ Anthropic Messages API çevirisi.
// İstemci OpenAI konuşur; kapı Claude'a çevirir (JSON + streaming) ve OpenAI'a geri çevirir.
import { ProviderError, trimSlash, fetchWithTimeout } from './base.js';

const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 4096;
const STOP_MAP = { end_turn: 'stop', max_tokens: 'length', stop_sequence: 'stop', tool_use: 'tool_calls' };

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((p) => (p && typeof p.text === 'string' ? p.text : '')).join('');
  }
  return '';
}

// OpenAI chat isteği → Anthropic Messages isteği.
export function toAnthropicRequest(body, modelCfg) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const systemParts = [];
  const out = [];
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    if (m.role === 'system') {
      systemParts.push(contentToText(m.content));
      continue;
    }
    // user/assistant geçer; diğer roller (tool vb.) user'a indirgenir.
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    out.push({ role, content: contentToText(m.content) });
  }

  const req = {
    model: modelCfg.model,
    // Anthropic max_tokens ZORUNLU — yoksa makul varsayılan.
    max_tokens: body.max_tokens ?? body.max_completion_tokens ?? modelCfg.max_tokens ?? DEFAULT_MAX_TOKENS,
    messages: out,
  };
  if (systemParts.length) req.system = systemParts.join('\n\n');
  if (typeof body.temperature === 'number') req.temperature = body.temperature;
  if (typeof body.top_p === 'number') req.top_p = body.top_p;
  if (body.stop !== undefined) req.stop_sequences = Array.isArray(body.stop) ? body.stop : [body.stop];
  if (body.stream === true) req.stream = true;
  return req;
}

// Anthropic (non-stream) yanıtı → OpenAI chat.completion.
export function toOpenAIResponse(anthropic, modelName) {
  const text = Array.isArray(anthropic?.content)
    ? anthropic.content.filter((b) => b?.type === 'text').map((b) => b.text).join('')
    : '';
  const usage = anthropic?.usage || {};
  const inTok = usage.input_tokens ?? 0;
  const outTok = usage.output_tokens ?? 0;
  return {
    id: anthropic?.id || 'chatcmpl-anthropic',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: modelName,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: text },
        finish_reason: STOP_MAP[anthropic?.stop_reason] || 'stop',
      },
    ],
    usage: { prompt_tokens: inTok, completion_tokens: outTok, total_tokens: inTok + outTok },
  };
}

// Anthropic SSE akışı → OpenAI SSE akışı (web ReadableStream).
function translateStream(anthropicBody, modelName) {
  const reader = anthropicBody.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const id = 'chatcmpl-anthropic';
  const created = Math.floor(Date.now() / 1000);
  let buffer = '';
  let started = false;
  let doneEmitted = false;

  const chunk = (delta, finish = null) =>
    'data: ' +
    JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created,
      model: modelName,
      choices: [{ index: 0, delta, finish_reason: finish }],
    }) +
    '\n\n';

  return new ReadableStream({
    async pull(controller) {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) {
          if (!doneEmitted) controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
          return;
        }
        buffer += decoder.decode(value, { stream: true });

        let emitted = '';
        let nl;
        while ((nl = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line.startsWith('data:')) continue; // 'event:' satırlarını yok say
          const payload = line.slice(5).trim();
          if (!payload) continue;
          let ev;
          try {
            ev = JSON.parse(payload);
          } catch {
            continue;
          }
          if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
            const delta = started ? { content: ev.delta.text } : { role: 'assistant', content: ev.delta.text };
            started = true;
            emitted += chunk(delta);
          } else if (ev.type === 'message_delta' && ev.delta?.stop_reason) {
            emitted += chunk({}, STOP_MAP[ev.delta.stop_reason] || 'stop');
          } else if (ev.type === 'message_stop') {
            if (!doneEmitted) {
              emitted += 'data: [DONE]\n\n';
              doneEmitted = true;
            }
          }
        }
        if (emitted) {
          controller.enqueue(encoder.encode(emitted));
          return;
        }
        // Tam satır çıkmadıysa döngüde kalıp daha fazla oku.
      }
    },
    cancel() {
      try {
        reader.cancel();
      } catch {}
    },
  });
}

export const anthropic = {
  async chat(modelCfg, body, { timeoutMs }) {
    const base = trimSlash(modelCfg.api_base) || 'https://api.anthropic.com';
    const url = `${base}/v1/messages`;
    const headers = {
      'Content-Type': 'application/json',
      'anthropic-version': modelCfg.anthropic_version || ANTHROPIC_VERSION,
      ...(modelCfg.headers || {}),
    };
    if (modelCfg.api_key) headers['x-api-key'] = modelCfg.api_key;

    const res = await fetchWithTimeout(
      url,
      { method: 'POST', headers, body: JSON.stringify(toAnthropicRequest(body, modelCfg)) },
      timeoutMs
    );
    if (!res.ok) {
      throw new ProviderError(`Anthropic hatası (${res.status}) — model '${modelCfg.model}'.`, res.status);
    }

    // Her iki yönde de OpenAI formatına çevirip döndür (router provider-agnostik kalır).
    if (body.stream === true) {
      return new Response(translateStream(res.body, modelCfg.model), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }
    const openai = toOpenAIResponse(await res.json(), modelCfg.model);
    return new Response(JSON.stringify(openai), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  },
};
