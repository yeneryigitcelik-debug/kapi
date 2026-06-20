// `kapi init` — örnek kapi.yaml üret (varsa üzerine yazma).
import { writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import log, { bold, cyan, green, dim } from '../util/log.js';

function template(sampleKey) {
  return `# kapı yapılandırması — KVKK-first yerel LLM gateway
# Güvenlik notları:
#   * Sadece 127.0.0.1 dinle (varsayılan). Dışa açacaksan require_key:true + güvenlik duvarı.
#   * API anahtarlarını buraya DÜZ METİN yazma. \${ENV_DEGISKEN} ile enjekte et.
#   * log_bodies'i prod'da asla açma (KVKK: prompt/yanıt içeriği diske yazılır).

server:
  host: 127.0.0.1
  port: 4100

security:
  # Yerel geliştirmede kapalı. Dışa açtığında true yap ve anahtar ekle.
  require_key: false
  keys: []
  # Örnek (env'den enjekte etmen önerilir):
  #   keys:
  #     - \${KAPI_KEY}            # export KAPI_KEY=${sampleKey}
  #     - key: \${UYGULAMA_KEY}   # scope'lu anahtar: yalnız listedeki modelleri görür
  #       models: [yerel-hizli]
  log_bodies: false

  # KVKK: dış sağlayıcıya gitmeden hassas veriyi maskele (yerel ollama hariç).
  redact_pii: false
  pii: [tckn, telefon, email, iban]
  # audit_log: kapi-audit.jsonl    # istek metadata'sı (içerik YOK)

routing:
  timeout_ms: 120000
  # Birincil çökerse (5xx/429/ağ) sırayla yedeğe geç. 4xx tetiklemez.
  fallbacks:
    yerel-hizli: [deepseek, yerel-buyuk]

models:
  # 1) Yerel Ollama — hızlı model.
  - name: yerel-hizli
    provider: ollama
    model: qwen2.5:7b
    # api_base: http://127.0.0.1:11434   # varsayılan; gerekirse değiştir

  # 2) Yerel Ollama — büyük model (son yedek).
  - name: yerel-buyuk
    provider: ollama
    model: qwen2.5:32b

  # 3) Uzak OpenAI-uyumlu sağlayıcı (DeepSeek örneği).
  #    NOT: Bu blok DEEPSEEK_API_KEY ortam değişkenini ister.
  #    Yoksa: ya 'export DEEPSEEK_API_KEY=...' ya da bu modeli ve
  #    fallbacks içindeki 'deepseek' referansını sil.
  - name: deepseek
    provider: openai-compatible
    api_base: https://api.deepseek.com
    model: deepseek-chat
    api_key: \${DEEPSEEK_API_KEY}
`;
}

export async function initCmd(args) {
  const target = resolve(process.cwd(), args.config ? String(args.config) : 'kapi.yaml');

  if (existsSync(target)) {
    log.error(`Zaten var: ${target} — üzerine yazmıyorum.`);
    process.exit(1);
  }

  const sampleKey = 'kapi-' + randomBytes(24).toString('hex');
  writeFileSync(target, template(sampleKey), 'utf8');
  log.ok(`Oluşturuldu: ${target}`);

  log.raw('');
  log.raw(bold('  Sonraki adımlar:'));
  log.raw(`    1) ${cyan('kapi.yaml')}'ı aç, model adlarını kendi kurulumuna göre düzelt.`);
  log.raw(`    2) DeepSeek örneğini kullanacaksan: ${cyan('export DEEPSEEK_API_KEY=...')}`);
  log.raw(`       (kullanmayacaksan o modeli ve fallback referansını sil.)`);
  log.raw(`    3) ${cyan('kapi up')} ile başlat.`);
  log.raw(`    4) ${cyan('kapi eval')} ile modellerin Türkçe skorlarını ölç.`);
  log.raw('');
  log.raw(dim(`  Üretilmiş örnek anahtar (istersen kullan): ${sampleKey}`));
  log.raw('');
}
