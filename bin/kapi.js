#!/usr/bin/env node
// kapı CLI giriş noktası. Komutlar dinamik import edilir (hızlı başlangıç).
import { parseArgs } from '../src/util/args.js';
import log, { bold, cyan, dim } from '../src/util/log.js';
import { ConfigError } from '../src/core/config.js';

const VERSION = '0.2.0';

function printHelp() {
  const b = bold;
  const lines = [
    '',
    `${b(cyan('kapı'))} v${VERSION} — KVKK-first yerel LLM gateway`,
    '',
    b('KULLANIM'),
    '  kapi <komut> [seçenekler]',
    '',
    b('KOMUTLAR'),
    `  ${cyan('up')}      Gateway'i başlat (OpenAI-uyumlu uç + fallback)`,
    `  ${cyan('init')}    Örnek kapi.yaml oluştur`,
    `  ${cyan('eval')}    Modelleri Türkçe görev setiyle ölç`,
    `  ${cyan('help')}    Bu yardımı göster`,
    '',
    b('SEÇENEKLER'),
    `  ${dim('-c, --config <yol>')}   Yapılandırma dosyası (varsayılan: kapi.yaml)`,
    `  ${dim('-p, --port <n>')}       up: dinlenecek port`,
    `  ${dim('    --host <ip>')}       up: dinlenecek adres (varsayılan 127.0.0.1)`,
    `  ${dim('-m, --model <ad>')}     eval: tek bir modeli ölç`,
    `  ${dim('-v, --verbose')}        eval: başarısız görevlerde model çıktısını göster`,
    `  ${dim('    --version')}         Sürümü yazdır`,
    `  ${dim('-h, --help')}           Yardım`,
    '',
    b('ÖRNEKLER'),
    '  kapi init',
    '  kapi up --port 4100',
    '  kapi eval -m yerel-hizli -v',
    '',
  ];
  console.log(lines.join('\n'));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];

  if (args.version && !cmd) {
    console.log(`kapı v${VERSION}`);
    return;
  }
  if (!cmd || cmd === 'help' || (args.help && !['up', 'init', 'eval'].includes(cmd))) {
    printHelp();
    return;
  }

  switch (cmd) {
    case 'up': {
      const { upCmd } = await import('../src/commands/up.js');
      await upCmd(args);
      break;
    }
    case 'init': {
      const { initCmd } = await import('../src/commands/init.js');
      await initCmd(args);
      break;
    }
    case 'eval': {
      const { evalCmd } = await import('../src/commands/eval.js');
      await evalCmd(args);
      break;
    }
    default:
      log.error(`Bilinmeyen komut: '${cmd}'.`);
      printHelp();
      process.exit(1);
  }
}

main().catch((err) => {
  if (err instanceof ConfigError) {
    log.error(err.message);
    process.exit(1);
  }
  log.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
