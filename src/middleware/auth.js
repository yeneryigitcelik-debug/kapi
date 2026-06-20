// Sabit zamanlı API anahtarı kontrolü + per-key model scope.
// Anahtarlar SHA-256 hash'lenip crypto.timingSafeEqual ile karşılaştırılır.
import { createHash, timingSafeEqual } from 'node:crypto';

function sha256(value) {
  return createHash('sha256').update(String(value), 'utf8').digest(); // sabit 32 byte
}

export function makeAuth(cfg) {
  const requireKey = cfg?.security?.require_key === true;

  // keys: "düz-anahtar" | { key, models? }
  const entries = (cfg?.security?.keys ?? []).map((k) => {
    const value = typeof k === 'string' ? k : k?.key;
    const models = k && typeof k === 'object' && Array.isArray(k.models) ? k.models : null;
    const hash = sha256(value);
    return { hash, models, id: hash.toString('hex').slice(0, 8) };
  });

  return function checkAuth(req) {
    if (!requireKey) return { ok: true, keyId: null, models: null };

    const header = req.headers?.['authorization'] ?? '';
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match) {
      return { ok: false, reason: 'Authorization başlığı eksik veya hatalı (Bearer <anahtar> bekleniyor).' };
    }

    const presented = sha256(match[1].trim());
    let matched = null;
    // Tüm anahtarları dolaş (erken çıkış yok); hash uzunlukları sabit 32 byte.
    for (const e of entries) {
      if (presented.length === e.hash.length && timingSafeEqual(presented, e.hash)) {
        matched = e;
      }
    }
    if (!matched) return { ok: false, reason: 'Geçersiz API anahtarı.' };

    // models: null → kısıtsız; dizi → yalnız bu takma adlar.
    return { ok: true, keyId: matched.id, models: matched.models };
  };
}
