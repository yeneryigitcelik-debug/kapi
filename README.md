<div align="center">

# kapı

**Güvenlik öncelikli, KVKK-first yerel LLM gateway.**

Ollama ve OpenAI-uyumlu sağlayıcıları tek bir uçta toplar, model çökerse otomatik yedeğe geçer, modelleri Türkçe görevlerle değerlendirir — ve bunu **tek bağımlılıkla** yapar.

[![Lisans: MIT](https://img.shields.io/badge/lisans-MIT-blue.svg)](./LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen.svg)
![Bağımlılık](https://img.shields.io/badge/ba%C4%9F%C4%B1ml%C4%B1l%C4%B1k-1%20%C2%B7%20yaml-success.svg)
![Sunucu](https://img.shields.io/badge/sunucu-native%20node%3Ahttp-informational.svg)

</div>

```
   İstemci                    kapı · 127.0.0.1                   Sağlayıcılar
  ┌──────────┐   takma ad   ┌────────────────────┐  gerçek ad  ┌───────────────┐
  │ OpenAI   │ ───────────▶ │ auth → router →    │ ──────────▶ │ Ollama        │
  │  SDK /   │              │ fallback → maske   │   5xx→yedek  │ DeepSeek      │
  │  curl    │ ◀─────────── │                    │ ◀────────── │ vLLM/OpenRouter│
  └──────────┘   takma ad   └────────────────────┘             └───────────────┘
                            tek dep: yaml · içerik diske yazılmaz
```

---

## İçindekiler

- [kapı nedir?](#kapı-nedir)
- [Neden kapı?](#neden-kapı)
- [Kurulum](#kurulum)
- [Hızlı başlangıç](#hızlı-başlangıç)
- [Yapılandırma](#yapılandırma)
- [Uçlar](#uçlar)
- [Türkçe değerlendirme](#türkçe-değerlendirme)
- [Güvenlik modeli](#güvenlik-modeli)
- [Mimari](#mimari)
- [Geliştirme ve test](#geliştirme-ve-test)
- [Yol haritası](#yol-haritası)
- [Katkı](#katkı)
- [Lisans](#lisans)

---

## kapı nedir?

`kapı`, kendi makinende veya sunucunda çalışan bir **LLM ağ geçidi**dir. Önüne bir
OpenAI-uyumlu uç koyar; arkasına Ollama, DeepSeek, vLLM, OpenRouter gibi sağlayıcıları
dizersin. İstemcin tek bir takma ad (`yerel-hizli`) görür — gerçek model adı, `api_base`
ve anahtarlar gateway'in arkasında kalır.

Tek satırda: **uygulamaların ile model sağlayıcıların arasına giren, KVKK-uyumlu, az
yer kaplayan, dayanıklı bir kapı.**

```bash
curl http://127.0.0.1:4100/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"yerel-hizli","messages":[{"role":"user","content":"Merhaba"}]}'
```

---

## Neden kapı?

LLM gateway'leri uygulamanın **en hassas noktasına** oturur: tüm prompt'lar, yanıtlar ve
API anahtarları oradan geçer. O yüzden bir gateway'de en çok istediğin şey *az şey*tir.

- **🪶 Minimal saldırı yüzeyi.** Tek runtime bağımlılığı: `yaml`. HTTP sunucusu native
  `node:http` ile yazıldı — Express/Fastify yok. (Mart 2026'da LiteLLM'in PyPI üzerinden
  yediği supply-chain saldırısını hatırla: bir gateway'in dependency ağacı ne kadar küçükse,
  o kadar az yerden vurulabilir. Burada `npm ls --all` çıktısı **tek bir paket**.)
- **🇹🇷 KVKK-first varsayılanlar.** Yalnızca `127.0.0.1` dinler. Prompt/yanıt içeriği
  **diske yazılmaz** (`log_bodies: false`). Veriler senin sunucunda kalır; yurt dışına
  zorunlu bir tur atmaz.
- **🧹 PII redaksiyonu.** İçerik **dış sağlayıcıya gitmeden** TCKN (checksum doğrulamalı),
  telefon, e-posta ve IBAN (mod-97 doğrulamalı) maskelenir. Yerel `ollama` muaftır — veri
  zaten makineden çıkmıyor. (`redact_pii: true`)
- **🪪 Per-key model scope.** Bir anahtar yalnız kendine tanımlı modelleri görür ve çağırır;
  fallback zinciri bile scope dışına **kaçamaz** (403). `/v1/models` de scope'a göre filtrelenir.
- **📋 Denetim günlüğü.** İstek başına yalnız metadata (model, status, ms, fallback, kaç PII
  maskelendi) JSONL'e yazılır — **içerik asla.** (`audit_log`)
- **🎭 Model maskeleme.** İstemci sadece takma adı görür. Gerçek model adı ve `api_base`
  yanıtlara sızmaz — stream modunda bile `model` alanı takma adla yeniden yazılır.
- **🔑 Anahtarlar koda/config'e düz metin girmez.** `${ENV}` ile enjekte edilir; değişken
  eksikse gateway **sessizce boş geçmez, net hata fırlatır.**
- **⏱ Sabit zamanlı kimlik doğrulama.** Anahtarlar SHA-256 hash'lenip
  `crypto.timingSafeEqual` ile karşılaştırılır — zamanlama sızıntısı yok.
- **🔁 Akıllı fallback.** Bir model `5xx/429/ağ` hatası verirse sıradaki yedeğe geçilir.
  `4xx` (istemci hatası) fallback **tetiklemez** — aynı hata başka modelde de tekrarlanacağı
  için boşuna deneme yapılmaz.

---

## Kurulum

Gereksinim: **Node ≥ 20.**

```bash
git clone https://github.com/yeneryigitcelik-debug/kapi.git
cd kapi
npm install          # tek bağımlılık: yaml
npm link             # 'kapi' komutunu global kullanmak için (opsiyonel)
```

`npm link` yapmadıysan komutu `node bin/kapi.js <komut>` olarak çağırabilirsin.

> 📦 npm üzerinden global kurulum yol haritasında — [Yol haritası](#yol-haritası).

---

## Hızlı başlangıç

```bash
kapi init                 # örnek kapi.yaml üret
# kapi.yaml'ı aç: model adlarını ve (varsa) ${ENV} anahtarlarını ayarla
kapi up                   # gateway'i başlat → http://127.0.0.1:4100
```

Başlatınca temiz bir banner görürsün:

```
  kapı — KVKK-first yerel LLM gateway

  adres   http://127.0.0.1:4100
  model   2 adet — yerel-hizli, yerel-buyuk
  güvenlik anahtar zorunlu (1), içerik loglanmıyor

  uçlar  POST /v1/chat/completions · GET /v1/models · GET /health
  durdur Ctrl+C
```

İstek atmak için herhangi bir OpenAI istemcisini `base_url`'i `http://127.0.0.1:4100/v1`
yapacak şekilde ayarlaman yeterli:

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:4100/v1", api_key="senin-kapi-anahtarin")
client.chat.completions.create(
    model="yerel-hizli",
    messages=[{"role": "user", "content": "Merhaba"}],
)
```

---

## Yapılandırma

`kapı`, çalıştığın dizinde `kapi.yaml` / `kapi.yml` / `.kapi.yaml` arar (`-c <yol>` ile
özelleştirilebilir). Tam açıklamalı örnek: [`kapi.example.yaml`](./kapi.example.yaml).

```yaml
server:
  host: 127.0.0.1          # KVKK-first: yalnız yerel. Dışa açarsan güvenlik duvarı + key!
  port: 4100

security:
  require_key: false       # üretimde true yap
  keys:                    # düz metin değil — env'den enjekte et
    - ${KAPI_KEY}          # kısıtsız anahtar
    - key: ${UYGULAMA_KEY} # scope'lu: yalnız bu modelleri görür/çağırır
      models: [yerel-hizli]
  log_bodies: false        # prod'da ASLA açma (prompt/yanıt içeriği diske yazılır)
  redact_pii: true         # dış sağlayıcıya gitmeden PII maskele (yerel ollama hariç)
  pii: [tckn, telefon, email, iban]
  audit_log: kapi-audit.jsonl   # istek metadata'sı (içerik YOK)

routing:
  timeout_ms: 120000
  fallbacks:               # 5xx/429/ağ → sırayla dene (4xx tetiklemez)
    yerel-hizli: [deepseek, yerel-buyuk]

models:
  - name: yerel-hizli      # ← istemcinin gördüğü takma ad
    provider: ollama
    model: qwen2.5:7b      # ← gerçek model (gizli kalır)

  - name: yerel-buyuk
    provider: ollama
    model: qwen2.5:32b

  - name: deepseek
    provider: openai-compatible
    api_base: https://api.deepseek.com
    model: deepseek-chat
    api_key: ${DEEPSEEK_API_KEY}    # eksikse kapı net hata verir, sessiz geçmez
```

**Doğrulama dahili.** En az bir model zorunludur; `name`/`provider`/`model` alanları
gerekli; isimler benzersiz olmalı; her fallback tanımlı bir modele işaret etmeli;
`require_key: true` ise `keys` boş olamaz. Hatalı config → tek satırlık, Türkçe, net hata.

---

## Uçlar

| Uç | Auth | Açıklama |
| --- | :---: | --- |
| `POST /v1/chat/completions` | ✓ | OpenAI-uyumlu sohbet. `stream: true` destekli. Fallback + maskeleme + PII redaksiyonu burada. |
| `GET /v1/models` | ✓ | Takma adları listeler (scope'lu anahtarda filtrelenir). Gerçek model adı / `api_base` **sızmaz**. |
| `GET /health` · `/healthz` | — | `{ "status": "ok", "models": N }`. Auth gerektirmez. |

Hatalar OpenAI hata zarfında döner: `{ "error": { "message", "type", "code" } }`.
CORS açık (`*`), `OPTIONS` → `204`. İstek gövdesi üst sınırı **10MB** (aşılırsa `413`).

---

## Türkçe değerlendirme

`kapi eval`, modellerini **hakem-model kullanmadan**, tamamen deterministik kontrollerle
puanlar. Her görev Türkçe'nin gerçekten zorladığı bir yeri test eder:

| Kategori | Örnek görev |
| --- | --- |
| `dilbilgisi` | Ünlü uyumuna göre çoğul eki (kitap**lar**, göz**ler**), soru ekini sökme |
| `muhakeme` | Orantı (3 kg = 60₺ → 5 kg?), sıralama mantığı |
| `talimat` | "Tam 5 kelimeyle tanımla", katı JSON biçimi |
| `tuzak` | "mutluluk"ta kaç `u` var? · `istanbul` → **İSTANBUL** (noktalı İ tuzağı) |
| `kod` | Çalışan bir `topla` fonksiyonu üret |

```bash
kapi eval                  # config'teki tüm modelleri ölç
kapi eval -m yerel-hizli   # tek model
kapi eval -v               # başarısız görevlerde model çıktısını da göster
```

Şuna benzer bir skor kartı alırsın (sayılar modellerine göre değişir):

```
▶ yerel-hizli (ollama:qwen2.5:7b)
  ✓ dilbilgisi dilbilgisi-unlu-uyumu  4/4 doğru çoğul
  ✓ tuzak      tuzak-buyuk-i          doğru (İ)
  ✗ tuzak      tuzak-harf-sayma       beklenen 3 yok
  …

  skor kartı — yerel-hizli
    dilbilgisi ████████████ 2/2 100%
    muhakeme   ██████░░░░░░ 1/2  50%
    talimat    ████████░░░░ 2/3  67%
    tuzak      ██████░░░░░░ 1/2  50%
    kod        ████████████ 1/1 100%

    toplam     ████████░░░░ 7/10 70%  ort. 820ms

  karşılaştırma
    🥇 deepseek       90%  (9/10, ort. 1240ms)
    🥈 yerel-hizli    70%  (7/10, ort. 820ms)
```

Deterministik olduğu için CI'da regresyon takibine de uygundur — bir model güncellemesi
Türkçe skorunu düşürürse görürsün.

---

## Güvenlik modeli

| Tehdit | kapı'nın yanıtı |
| --- | --- |
| Bağımlılık / supply-chain saldırısı | Tek runtime dep (`yaml`). `npm ls --all` = tek paket. |
| Veri yurt dışına çıkışı (KVKK) | Varsayılan `127.0.0.1`; içerik diske yazılmaz. |
| Hassas veri (PII) dış sağlayıcıya gider | `redact_pii`: TCKN/telefon/e-posta/IBAN, gönderim öncesi maskelenir (yerel ollama hariç). |
| Anahtar sızıntısı (repo/log) | Anahtarlar `${ENV}`'den; config'e düz metin girmez. |
| Yetkisiz erişim | `require_key` + SHA-256 hash + `timingSafeEqual` (sabit zaman). |
| Bir anahtarla izinsiz model/maliyet | Per-key scope: anahtar yalnız izinli modelleri çağırır, fallback bile kaçamaz. |
| İzlenebilirlik / denetim | `audit_log`: metadata-only JSONL (kim, hangi model, status, ms) — içerik yok. |
| Model/altyapı parmak izi | Maskeleme: takma ad dışında hiçbir şey sızmaz (stream dahil). |
| Gereksiz yeniden deneme / maliyet | `4xx` fallback tetiklemez; yalnız geçici hatalarda yedek. |

> Dışa açmadan önce: `require_key: true`, güçlü bir `${KAPI_KEY}`, güvenlik duvarı ve
> ters proxy (TLS) kullan. `host: 0.0.0.0` verirsen kapı banner'da seni uyarır.

Güvenlik açığı bulursan lütfen herkese açık issue yerine doğrudan iletişime geç.

---

## Mimari

```
bin/kapi.js              CLI giriş noktası (komutlar dinamik import)
src/
  util/args.js           bağımlılıksız argüman ayrıştırıcı
  util/log.js            bağımlılıksız, TTY-duyarlı logger
  core/config.js         YAML yükle + ${ENV} enjekte + doğrula
  core/router.js         model çöz + fallback + PII redaksiyon + stream maskeleme
  core/server.js         native http, OpenAI-uyumlu uçlar, audit
  providers/index.js     ollama + openai-compatible adaptörleri
  middleware/auth.js     sabit zamanlı anahtar kontrolü + per-key scope
  security/pii.js        PII dedektörleri (TCKN/IBAN doğrulamalı) + redaksiyon
  security/audit.js      metadata-only denetim günlüğü (JSONL)
  commands/
    up.js                gateway başlat + banner + graceful shutdown
    init.js              örnek kapi.yaml üret
    eval.js              Türkçe eval motoru + skor kartı
    eval-tasks.js        gömülü, deterministik Türkçe görev seti
test-e2e.js              sahte upstream'lerle uçtan uca test
```

**İstek akışı:** `server` gövdeyi (≤10MB) okur → `auth` anahtarı doğrular ve scope'u çözer →
`router` deneme zincirini (`[istenen, ...fallbacks]`, scope'la filtreli) kurar → dış sağlayıcıysa
**PII maskelenir** → `provider` upstream'e gider → başarıda yanıt (model adı) maskelenip istemciye
yazılır, geçici hatada sıradaki modele geçilir → sonda yalnız metadata `audit_log`'a düşer.

---

## Geliştirme ve test

```bash
node test-e2e.js     # PII birim + uçtan uca — 32 assertion, hepsi geçmeli
npm test             # = yukarısı
npm ls --all         # yalnızca yaml@2 görünmeli — projenin konumlama iddiası
```

Test, gerçek model gerektirmez: PII dedektörlerinin birim testleri + üç sahte upstream
(OK / hep-500 / SSE-stream) ile auth, maskeleme, fallback, hata yolları, streaming,
PII redaksiyonu, per-key scope ve audit logunu doğrular.

---

## Yol haritası

- [x] **0.2.0** — PII redaksiyonu, per-key model scope, denetim günlüğü, stream model maskeleme
- [ ] Anthropic native sağlayıcı
- [ ] Model-bazlı rate limit
- [ ] `eval --export json` (CI regresyon takibi)
- [ ] Prometheus `/metrics` (sayaç — içerik değil)
- [ ] `npm publish` (`kapi` adı müsaitse; değilse `kapi-gateway`)

---

## Katkı

Issue ve PR'lar memnuniyetle karşılanır →
[github.com/yeneryigitcelik-debug/kapi](https://github.com/yeneryigitcelik-debug/kapi)

Tasarım pusulası basit: **bağımlılık eklemeden.** Bir özellik yeni bir runtime paketi
gerektiriyorsa, önce bir issue açıp tartışalım — projenin tüm değeri o tek `yaml`
satırında.

---

## Lisans

[MIT](./LICENSE) © 2026 Yener Yiğit Çelik

<details>
<summary>🇬🇧 English summary</summary>

**kapı** is a security-first, privacy-by-default local LLM gateway. It puts a single
OpenAI-compatible endpoint in front of Ollama and OpenAI-compatible providers (DeepSeek,
vLLM, OpenRouter), with automatic fallback on `5xx/429/network` errors, response-side
model masking (streaming included), constant-time key auth, **PII redaction** (TCKN/phone/
email/IBAN scrubbed before content leaves to external providers), **per-key model scoping**,
a metadata-only **audit log**, and a built-in, judge-free Turkish evaluation suite
(`kapi eval`). Its defining constraint: **a single runtime dependency (`yaml`)** and a
native `node:http` server — a deliberately tiny attack surface. Localhost-only by default;
prompt/response bodies are never written to disk. Requires Node ≥ 20.

```bash
git clone https://github.com/yeneryigitcelik-debug/kapi.git
cd kapi && npm install
node bin/kapi.js init && node bin/kapi.js up
```

</details>
