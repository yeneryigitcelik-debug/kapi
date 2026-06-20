// Yapılandırma: YAML yükle → DEFAULTS ile birleştir → ${ENV} enjekte et → doğrula.
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import YAML from 'yaml';

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

export const DEFAULTS = {
  server: { host: '127.0.0.1', port: 4100 },
  security: { require_key: false, keys: [], log_bodies: false },
  routing: { fallbacks: {}, timeout_ms: 120000 },
  models: [],
};

const CANDIDATES = ['kapi.yaml', 'kapi.yml', '.kapi.yaml'];

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Nesneleri özyinelemeli birleştir; diziler değiştirilir (birleştirilmez).
function deepMerge(base, over) {
  if (!isPlainObject(base) || !isPlainObject(over)) {
    return over === undefined ? base : over;
  }
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = isPlainObject(out[k]) && isPlainObject(v) ? deepMerge(out[k], v) : v;
  }
  return out;
}

// ${ENV_VAR} kalıplarını process.env'den doldur; tanımsızsa net hata fırlat.
function interpolate(node, where) {
  if (typeof node === 'string') {
    return node.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name) => {
      const val = process.env[name];
      if (val === undefined) {
        throw new ConfigError(
          `Ortam değişkeni tanımsız: \${${name}} (${where}). ` +
            `Kabuğunda 'export ${name}=...' ile tanımla; anahtarları config'e düz metin yazma.`
        );
      }
      return val;
    });
  }
  if (Array.isArray(node)) return node.map((n) => interpolate(n, where));
  if (isPlainObject(node)) {
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = interpolate(v, where);
    return out;
  }
  return node;
}

function validate(cfg) {
  if (!Array.isArray(cfg.models) || cfg.models.length === 0) {
    throw new ConfigError("En az bir model tanımlanmalı (models: [...]).");
  }

  const names = new Set();
  cfg.models.forEach((m, i) => {
    if (!isPlainObject(m)) {
      throw new ConfigError(`models[${i}] bir nesne olmalı.`);
    }
    for (const field of ['name', 'provider', 'model']) {
      if (typeof m[field] !== 'string' || m[field].length === 0) {
        throw new ConfigError(`models[${i}] '${field}' alanı zorunlu (string).`);
      }
    }
    if (names.has(m.name)) {
      throw new ConfigError(`Model adı benzersiz değil: '${m.name}'.`);
    }
    names.add(m.name);
  });

  const fallbacks = cfg.routing?.fallbacks ?? {};
  for (const [src, targets] of Object.entries(fallbacks)) {
    if (!names.has(src)) {
      throw new ConfigError(`Fallback kaynağı tanımsız modele işaret ediyor: '${src}'.`);
    }
    if (!Array.isArray(targets)) {
      throw new ConfigError(`Fallback hedefleri dizi olmalı: '${src}'.`);
    }
    for (const t of targets) {
      if (!names.has(t)) {
        throw new ConfigError(`Fallback hedefi tanımsız modele işaret ediyor: '${src}' → '${t}'.`);
      }
    }
  }

  if (cfg.security?.require_key === true) {
    const keys = cfg.security.keys;
    if (!Array.isArray(keys) || keys.length === 0) {
      throw new ConfigError('security.require_key:true iken security.keys boş olamaz.');
    }
  }
}

export function loadConfig(path) {
  let file = path;
  if (!file) {
    file = CANDIDATES.find((c) => existsSync(resolve(process.cwd(), c)));
    if (!file) {
      throw new ConfigError(
        `Yapılandırma bulunamadı (${CANDIDATES.join(', ')}). 'kapi init' ile örnek oluştur.`
      );
    }
  }

  const abs = resolve(process.cwd(), file);
  if (!existsSync(abs)) {
    throw new ConfigError(`Yapılandırma dosyası yok: ${abs}`);
  }

  let raw;
  try {
    raw = readFileSync(abs, 'utf8');
  } catch (e) {
    throw new ConfigError(`Dosya okunamadı (${abs}): ${e.message}`);
  }

  let parsed;
  try {
    parsed = YAML.parse(raw) ?? {};
  } catch (e) {
    throw new ConfigError(`YAML ayrıştırma hatası (${abs}): ${e.message}`);
  }
  if (!isPlainObject(parsed)) {
    throw new ConfigError(`Yapılandırma kökü bir nesne olmalı (${abs}).`);
  }

  const merged = deepMerge(DEFAULTS, parsed);
  const interpolated = interpolate(merged, abs);
  validate(interpolated);
  Object.defineProperty(interpolated, '__path', { value: abs, enumerable: false });
  return interpolated;
}

export function indexModels(cfg) {
  const map = new Map();
  for (const m of cfg.models) map.set(m.name, m);
  return map;
}
