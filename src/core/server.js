// Native node:http gateway. OpenAI-uyumlu uçlar. Express/Fastify YOK.
import http from 'node:http';
import { route } from './router.js';
import { makeAuth } from '../middleware/auth.js';
import { makeAudit } from '../security/audit.js';
import { indexModels } from './config.js';

const MAX_BODY = 10 * 1024 * 1024; // 10 MB

const NOOP_LOG = { info() {}, warn() {}, error() {}, ok() {}, raw() {} };

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
}

function errType(status) {
  if (status === 401) return 'authentication_error';
  if (status === 404) return 'not_found_error';
  if (status === 413) return 'invalid_request_error';
  if (status === 429) return 'rate_limit_error';
  if (status >= 500) return 'api_error';
  return 'invalid_request_error';
}

function sendJson(res, status, obj) {
  if (res.headersSent) return;
  const payload = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendError(res, status, message, code = null) {
  if (res.headersSent) {
    try {
      res.end();
    } catch {}
    return;
  }
  sendJson(res, status, { error: { message, type: errType(status), code } });
}

function readBody(req, max) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let chunks = [];
    let settled = false;
    const onData = (chunk) => {
      size += chunk.length;
      if (size > max) {
        req.off('data', onData);
        req.off('end', onEnd);
        chunks = [];
        if (!settled) {
          settled = true;
          const err = new Error('İstek gövdesi çok büyük.');
          err.code = 'TOO_LARGE';
          reject(err);
        }
        req.resume();
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', (e) => {
      if (settled) return;
      settled = true;
      reject(e);
    });
  });
}

export function createGateway(cfg) {
  const modelIndex = indexModels(cfg);
  const checkAuth = makeAuth(cfg);
  const audit = makeAudit(cfg);
  const logBodies = cfg?.security?.log_bodies === true;
  const log = cfg?.__log ?? NOOP_LOG;

  const server = http.createServer(async (req, res) => {
    setCors(res);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    let pathname;
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      sendError(res, 400, 'Geçersiz istek yolu.');
      return;
    }

    if (req.method === 'GET' && (pathname === '/health' || pathname === '/healthz')) {
      sendJson(res, 200, { status: 'ok', models: modelIndex.size });
      return;
    }

    const auth = checkAuth(req);
    if (!auth.ok) {
      sendError(res, 401, auth.reason || 'Yetkisiz.', 'invalid_api_key');
      return;
    }

    if (req.method === 'GET' && pathname === '/v1/models') {
      const data = [...modelIndex.values()]
        .filter((m) => !auth.models || auth.models.includes(m.name))
        .map((m) => ({ id: m.name, object: 'model', owned_by: m.provider }));
      sendJson(res, 200, { object: 'list', data });
      return;
    }

    if (req.method === 'POST' && pathname === '/v1/chat/completions') {
      const t0 = Date.now();
      let raw;
      try {
        raw = await readBody(req, MAX_BODY);
      } catch (e) {
        if (e?.code === 'TOO_LARGE') {
          if (!res.headersSent) res.setHeader('Connection', 'close');
          sendError(res, 413, 'İstek gövdesi çok büyük (en fazla 10MB).');
          audit({
            ts: new Date().toISOString(),
            ip: req.socket?.remoteAddress ?? null,
            key: auth.keyId ?? null,
            model: null,
            resolved: null,
            provider: null,
            status: 413,
            ms: Date.now() - t0,
            fallback: false,
            stream: false,
          });
        } else {
          sendError(res, 400, 'İstek gövdesi okunamadı.');
        }
        return;
      }

      let body;
      try {
        body = JSON.parse(raw || '{}');
      } catch {
        sendError(res, 400, 'Geçersiz JSON gövdesi.');
        return;
      }

      if (logBodies) log.info(`POST /v1/chat/completions ← ${raw}`);

      const ctx = { keyId: auth.keyId ?? null };
      try {
        await route({ body, cfg, modelIndex, res, log, ctx, allowedModels: auth.models });
      } catch (err) {
        const status = Number.isInteger(err?.status) ? err.status : 500;
        if (ctx.clientAborted || res.destroyed) {
          ctx.status = 499;
        } else if (!res.headersSent) {
          sendError(res, status, err?.message || 'Sunucu hatası.', err?.code ?? null);
        } else {
          try {
            res.end();
          } catch {}
        }
      }

      // Denetim günlüğü: SADECE metadata.
      audit({
        ts: new Date().toISOString(),
        ip: req.socket?.remoteAddress ?? null,
        key: ctx.keyId,
        model: typeof body?.model === 'string' ? body.model : null,
        resolved: ctx.resolved ?? null,
        provider: ctx.provider ?? null,
        status: ctx.status ?? res.statusCode,
        ms: Date.now() - t0,
        fallback: ctx.fallback ?? false,
        stream: body?.stream === true,
        ...(ctx.streamError ? { stream_error: ctx.streamError } : {}),
        ...(ctx.redacted ? { redacted: ctx.redacted } : {}),
      });
      return;
    }

    if (req.method === 'POST' && pathname === '/v1/completions') {
      sendError(res, 400, 'Bu uç desteklenmiyor; /v1/chat/completions kullan.');
      return;
    }

    sendError(res, 404, 'Bulunamadı.', 'not_found');
  });

  server.on('clientError', (_err, socket) => {
    try {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    } catch {}
  });

  return server;
}
