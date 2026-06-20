// `kapi up` — gateway'i başlat, banner bas, temiz kapan.
import { loadConfig } from '../core/config.js';
import { createGateway } from '../core/server.js';
import log, { bold, cyan, green, yellow, red, dim } from '../util/log.js';

function banner(cfg) {
  const { host, port } = cfg.server;
  const sec = cfg.security || {};
  const lines = [];

  lines.push('');
  lines.push(bold(cyan('  kapı')) + dim(' — KVKK-first yerel LLM gateway'));
  lines.push('');
  lines.push(`  ${dim('adres ')} http://${host}:${port}`);

  const modelList = cfg.models.map((m) => m.name).join(', ');
  lines.push(`  ${dim('model ')} ${cfg.models.length} adet — ${modelList}`);

  const keyState = sec.require_key
    ? green(`anahtar zorunlu (${(sec.keys || []).length})`)
    : yellow('anahtar KAPALI (yerel geliştirme)');
  const bodyState = sec.log_bodies ? red('log_bodies AÇIK') : green('içerik loglanmıyor');
  lines.push(`  ${dim('güvenlik')} ${keyState}, ${bodyState}`);

  if (host === '0.0.0.0' || host === '::') {
    lines.push('');
    lines.push(
      '  ' + red('⚠ ') + yellow(`${host} dinleniyor — gateway dışa açık. `) +
        dim('Güvenlik duvarı + require_key şart.')
    );
  }

  lines.push('');
  lines.push(dim('  uçlar  POST /v1/chat/completions · GET /v1/models · GET /health'));
  lines.push(dim('  durdur Ctrl+C'));
  lines.push('');
  return lines.join('\n');
}

export async function upCmd(args) {
  const cfg = loadConfig(args.config);

  // CLI override.
  if (args.port !== undefined) cfg.server.port = Number(args.port);
  if (args.host !== undefined) cfg.server.host = String(args.host);

  cfg.__log = log; // sunucu log_bodies için kullanabilsin.

  const server = createGateway(cfg);
  const { host, port } = cfg.server;

  server.on('error', (err) => {
    if (err?.code === 'EADDRINUSE') {
      log.error(`Port dolu: ${host}:${port}. Başka bir port seç: kapi up --port <n>.`);
    } else {
      log.error(`Sunucu hatası: ${err?.message ?? err}`);
    }
    process.exit(1);
  });

  server.listen(port, host, () => {
    log.raw(banner(cfg));
  });

  let closing = false;
  const shutdown = (sig) => {
    if (closing) return;
    closing = true;
    log.warn(`${sig} alındı — kapatılıyor...`);
    const safety = setTimeout(() => {
      log.error('Zaman aşımı; zorla çıkılıyor.');
      process.exit(1);
    }, 3000);
    safety.unref?.();
    server.close(() => {
      clearTimeout(safety);
      log.ok('Temiz kapatıldı.');
      process.exit(0);
    });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
