<div align="center">

# kapı

**Security-first, KVKK/privacy-first local LLM gateway.**

Puts Ollama, Anthropic, and OpenAI-compatible providers behind one endpoint, fails over automatically when a model dies, scores models on Turkish-language tasks — and does it all with **a single dependency**.

[![ci](https://github.com/yeneryigitcelik-debug/kapi/actions/workflows/ci.yml/badge.svg)](https://github.com/yeneryigitcelik-debug/kapi/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen.svg)
![Dependencies](https://img.shields.io/badge/dependencies-1%20%C2%B7%20yaml-success.svg)
![Server](https://img.shields.io/badge/server-native%20node%3Ahttp-informational.svg)

[Türkçe](./README.md) · **English**

</div>

```
   Client                     kapı · 127.0.0.1                    Providers
  ┌──────────┐    alias     ┌────────────────────┐  real name  ┌───────────────┐
  │ OpenAI   │ ───────────▶ │ auth → router →    │ ──────────▶ │ Ollama        │
  │  SDK /   │              │ fallback → mask    │  5xx→backup │ Anthropic     │
  │  curl    │ ◀─────────── │                    │ ◀────────── │ OpenAI-compat │
  └──────────┘    alias     └────────────────────┘             └───────────────┘
                            one dependency: yaml · bodies never hit disk
```

---

## Contents

- [What is kapı?](#what-is-kapı)
- [Why kapı?](#why-kapı)
- [Install](#install)
- [Quick start](#quick-start)
- [Deployment (Docker, PM2)](#deployment-docker-pm2)
- [Configuration](#configuration)
- [Endpoints](#endpoints)
- [Turkish evaluation](#turkish-evaluation)
- [Security model](#security-model)
- [Architecture](#architecture)
- [Development and tests](#development-and-tests)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [License](#license)

> **Note on language.** `kapı` is built for the Turkish market: it is KVKK-first (Türkiye's
> data-protection law, akin to GDPR) and all of its **user-facing text is Turkish** (CLI
> banners, errors, the eval scorecard). This page documents it in English; the canonical
> README is [Turkish](./README.md).

---

## What is kapı?

`kapı` ("door/gate" in Turkish) is an **LLM gateway** that runs on your own machine or
server. It exposes a single OpenAI-compatible endpoint at the front and lets you wire up
providers like Ollama, Anthropic (Claude), DeepSeek, vLLM, or OpenRouter behind it. Your
client only ever sees an alias (e.g. `yerel-hizli`, "local-fast") — the real model name,
`api_base`, and keys stay behind the gateway.

In one line: **a small, resilient, privacy-respecting door between your apps and your model
providers.**

```bash
curl http://127.0.0.1:4100/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"yerel-hizli","messages":[{"role":"user","content":"Hello"}]}'
```

---

## Why kapı?

An LLM gateway sits at the **most sensitive point** of your app: every prompt, response,
and API key passes through it. So the thing you want most from a gateway is *less* — less
code, fewer dependencies, less leaked.

- **🪶 Minimal attack surface.** One runtime dependency: `yaml`. The HTTP server is written
  on native `node:http` — no Express/Fastify. (Remember LiteLLM's March 2026 PyPI
  supply-chain attack: the smaller a gateway's dependency tree, the fewer places it can be
  hit from. Here `npm ls --all` shows **a single package**.)
- **🇹🇷 KVKK-first defaults.** Listens on `127.0.0.1` only. Prompt/response content is
  **never written to disk** (`log_bodies: false`). Data stays on your server; it does not
  take a mandatory trip abroad.
- **🧹 PII redaction.** Before content **leaves to an external provider**, Turkish ID numbers
  (TCKN, checksum-validated), phone numbers, e-mails, and IBANs (mod-97 validated) are
  masked. Local `ollama` is exempt — the data never leaves the machine anyway.
  (`redact_pii: true`)
- **🪪 Per-key model scope.** A key sees and can call only the models assigned to it; even
  the fallback chain **cannot escape** the scope (403). `/v1/models` is filtered by scope too.
- **📋 Audit log.** Per request, only metadata (model, status, ms, fallback, how many PII
  items were masked) is appended as JSONL — **never the content.** (`audit_log`)
- **🎭 Model masking.** The client only sees the alias. The real model name and `api_base`
  never leak into responses — even in streaming mode the `model` field is rewritten to the alias.
- **🔑 Keys never sit in code/config as plaintext.** They are injected via `${ENV}`; if a
  variable is missing the gateway **fails loudly instead of silently running blank.**
- **⏱ Constant-time authentication.** Keys are SHA-256 hashed and compared with
  `crypto.timingSafeEqual` — no timing leak.
- **🔁 Smart fallback.** If a model returns `5xx/429/network` errors, the next backup is
  tried. A `4xx` (client error) does **not** trigger fallback — the same error would just
  repeat on another model, so no pointless retries.

---

## Install

Requires **Node ≥ 20.**

```bash
git clone https://github.com/yeneryigitcelik-debug/kapi.git
cd kapi
npm install          # single dependency: yaml
npm link             # to use the 'kapi' command globally (optional)
```

If you skip `npm link`, invoke it as `node bin/kapi.js <command>`.

> 📦 Global install via npm is on the [roadmap](#roadmap).

---

## Quick start

```bash
kapi init                 # generate an example kapi.yaml
# edit kapi.yaml: set model names and (if any) ${ENV} keys
kapi up                   # start the gateway → http://127.0.0.1:4100
```

On start you get a clean banner (in Turkish):

```
  kapı — KVKK-first yerel LLM gateway

  adres   http://127.0.0.1:4100
  model   2 adet — yerel-hizli, yerel-buyuk
  güvenlik anahtar zorunlu (1), içerik loglanmıyor

  uçlar  POST /v1/chat/completions · GET /v1/models · GET /health
  durdur Ctrl+C
```

To send requests, just point any OpenAI client's `base_url` at `http://127.0.0.1:4100/v1`:

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:4100/v1", api_key="your-kapi-key")
client.chat.completions.create(
    model="yerel-hizli",
    messages=[{"role": "user", "content": "Hello"}],
)
```

---

## Deployment (Docker, PM2)

### Docker

```bash
docker build -t kapi .
docker run --rm -p 127.0.0.1:4100:4100 \
  -v "$PWD/kapi.yaml:/app/kapi.yaml:ro" \
  kapi up --host 0.0.0.0
```

The image stays KVKK-first: bind the host port to **`127.0.0.1`** (as above) so it is only
reachable locally. Inside a container you need `--host 0.0.0.0` (the banner warns about it);
if you really expose it, `require_key: true` is a must.

### PM2 (e.g. on Hetzner)

```bash
pm2 start ecosystem.config.cjs   # kapi.yaml must be in the working directory
pm2 save && pm2 startup          # come back up automatically after reboot
```

Provide keys via the system (`export KAPI_KEY=...`); PM2 inherits the environment (don't
write keys as plaintext in the config).

---

## Configuration

`kapı` looks for `kapi.yaml` / `kapi.yml` / `.kapi.yaml` in the working directory
(override with `-c <path>`). Fully annotated example: [`kapi.example.yaml`](./kapi.example.yaml).

```yaml
server:
  host: 127.0.0.1          # KVKK-first: local only. If you expose it, firewall + key!
  port: 4100

security:
  require_key: false       # set true in production
  keys:                    # not plaintext — inject from env
    - ${KAPI_KEY}          # unrestricted key
    - key: ${APP_KEY}      # scoped: only sees/calls these models
      models: [yerel-hizli]
  log_bodies: false        # NEVER enable in prod (writes prompt/response to disk)
  redact_pii: true         # mask PII before it leaves to an external provider (local ollama exempt)
  pii: [tckn, telefon, email, iban]
  audit_log: kapi-audit.jsonl   # request metadata (NO content)

routing:
  timeout_ms: 120000
  fallbacks:               # 5xx/429/network → try in order (4xx does not trigger)
    yerel-hizli: [deepseek, yerel-buyuk]

models:
  - name: yerel-hizli      # ← the alias the client sees
    provider: ollama
    model: qwen2.5:7b      # ← the real model (stays hidden)

  - name: yerel-buyuk
    provider: ollama
    model: qwen2.5:32b

  - name: deepseek
    provider: openai-compatible
    api_base: https://api.deepseek.com
    model: deepseek-chat
    api_key: ${DEEPSEEK_API_KEY}    # if missing, kapı errors clearly instead of running blank
```

**Providers:** `ollama`, `openai-compatible` (DeepSeek/vLLM/OpenRouter/Together…), and
`anthropic` (Claude — kapı handles the OpenAI ↔ Messages translation, including `max_tokens`
and streaming).

**Validation is built in.** At least one model is required; `name`/`provider`/`model` are
mandatory; names must be unique; every fallback must point to a defined model; if
`require_key: true`, `keys` cannot be empty. A bad config yields a single-line, clear error
(in Turkish).

---

## Endpoints

| Endpoint | Auth | Description |
| --- | :---: | --- |
| `POST /v1/chat/completions` | ✓ | OpenAI-compatible chat. Supports `stream: true`. Fallback + masking + PII redaction happen here. |
| `GET /v1/models` | ✓ | Lists aliases (filtered for scoped keys). Real model name / `api_base` **never leak**. |
| `GET /health` · `/healthz` | — | `{ "status": "ok", "models": N }`. No auth required. |

Errors come back in the OpenAI error envelope: `{ "error": { "message", "type", "code" } }`.
CORS is open (`*`), `OPTIONS` → `204`. Request body cap is **10MB** (over it → `413`).

---

## Turkish evaluation

`kapi eval` scores your models with **no judge model** — every check is deterministic. Each
task probes a place where Turkish genuinely trips models up:

| Category | Example task |
| --- | --- |
| `dilbilgisi` (grammar) | Vowel-harmony plural suffix (kitap**lar**, göz**ler**), stripping a question particle |
| `muhakeme` (reasoning) | Proportion (3 kg = 60₺ → 5 kg?), ordering logic |
| `talimat` (instruction) | "Describe in exactly 5 words", strict JSON shape |
| `tuzak` (traps) | How many `u` in "mutluluk"? · `istanbul` → **İSTANBUL** (dotted-İ trap) |
| `kod` (code) | Produce a working `topla` (add) function |

```bash
kapi eval                  # score all models in the config
kapi eval -m yerel-hizli   # a single model
kapi eval -v               # also show model output on failed tasks
```

You get a scorecard like this (numbers depend on your models; output is in Turkish):

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

Because it's deterministic, it doubles as a CI regression gate — if a model update drops its
Turkish score, you'll see it.

---

## Security model

| Threat | kapı's answer |
| --- | --- |
| Dependency / supply-chain attack | One runtime dep (`yaml`). `npm ls --all` = single package. |
| Data leaving the country (KVKK) | Defaults to `127.0.0.1`; content never written to disk. |
| Sensitive data (PII) reaching an external provider | `redact_pii`: TCKN/phone/e-mail/IBAN masked before sending (local ollama exempt). |
| Key leakage (repo/log) | Keys come from `${ENV}`; never plaintext in config. |
| Unauthorized access | `require_key` + SHA-256 hash + `timingSafeEqual` (constant time). |
| One key calling unauthorized models / cost | Per-key scope: a key only calls allowed models, fallback can't escape. |
| Traceability / audit | `audit_log`: metadata-only JSONL (who, which model, status, ms) — no content. |
| Model/infra fingerprinting | Masking: nothing but the alias leaks (streaming included). |
| Needless retries / cost | `4xx` does not trigger fallback; backups only on transient errors. |

> Before exposing it: use `require_key: true`, a strong `${KAPI_KEY}`, a firewall, and a
> reverse proxy (TLS). If you set `host: 0.0.0.0`, kapı warns you in the banner.

If you find a security issue, please reach out privately rather than opening a public issue.

---

## Architecture

```
bin/kapi.js              CLI entry point (commands are dynamically imported)
src/
  util/args.js           dependency-free argument parser
  util/log.js            dependency-free, TTY-aware logger
  core/config.js         load YAML + inject ${ENV} + validate
  core/router.js         resolve model + fallback + PII redaction + stream masking
  core/server.js         native http, OpenAI-compatible endpoints, audit
  providers/index.js     registry: ollama · openai-compatible · anthropic
  providers/base.js      shared ProviderError + fetch-with-timeout
  providers/anthropic.js Anthropic Messages API translation (OpenAI ↔ Claude)
  middleware/auth.js     constant-time key check + per-key scope
  security/pii.js        PII detectors (TCKN/IBAN validated) + redaction
  security/audit.js      metadata-only audit log (JSONL)
  commands/
    up.js                start gateway + banner + graceful shutdown
    init.js              generate an example kapi.yaml
    eval.js              Turkish eval engine + scorecard
    eval-tasks.js        embedded, deterministic Turkish task set
test-e2e.js              end-to-end test with fake upstreams
```

**Request flow:** `server` reads the body (≤10MB) → `auth` validates the key and resolves
scope → `router` builds the attempt chain (`[requested, ...fallbacks]`, filtered by scope) →
if the provider is external, **PII is masked** → `provider` calls upstream → on success the
response (model name) is masked and written to the client, on a transient error it moves to
the next model → finally only metadata is appended to `audit_log`.

---

## Development and tests

```bash
node test-e2e.js     # unit + end-to-end — 46 assertions, all must pass
npm test             # = the above
npm ls --all         # only yaml@2 should appear — the project's whole thesis
```

The tests need no real model: PII + Anthropic-translation unit tests + four fake upstreams
(OK / always-500 / SSE / Anthropic) verify auth, masking, fallback, error paths, streaming,
PII redaction, per-key scope, the audit log, and the Anthropic OpenAI↔Messages translation.

**CI:** GitHub Actions runs the test matrix (Node 20/22/24) + the single-dependency guard +
a Docker build on every push/PR.

---

## Roadmap

- [x] **0.3.0** — Anthropic native provider (OpenAI ↔ Messages translation, streaming included)
- [x] **0.2.0** — PII redaction, per-key model scope, audit log, stream model masking
- [ ] Per-model rate limiting
- [ ] `eval --export json` (CI regression tracking)
- [ ] Prometheus `/metrics` (counters — not content)
- [ ] `npm publish` (if `kapi` is available; otherwise `kapi-gateway`)

---

## Contributing

Issues and PRs are welcome →
[github.com/yeneryigitcelik-debug/kapi](https://github.com/yeneryigitcelik-debug/kapi)

The design compass is simple: **add no dependencies.** If a feature needs a new runtime
package, open an issue to discuss first — the whole value of this project is in that single
`yaml` line.

---

## License

[MIT](./LICENSE) © 2026 Yener Yiğit Çelik
