// Sabit zamanlı API anahtarı kontrolü. Anahtarlar SHA-256 hash'lenip
// crypto.timingSafeEqual ile karşılaştırılır (düz metin karşılaştırma yok).
import { createHash, timingSafeEqual } from 'node:crypto';

function sha256(value) {
  return createHash('sha256').update(String(value), 'utf8').digest(); // sabit 32 byte
}

export function makeAuth(cfg) {
  const requireKey = cfg?.security?.require_key === true;
  const keyHashes = (cfg?.security?.keys ?? []).map(sha256);

  return function checkAuth(req) {
    if (!requireKey) return { ok: true };

    const header = req.headers?.['authorization'] ?? '';
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match) {
      return { ok: false, reason: 'Authorization başlığı eksik veya hatalı (Bearer <anahtar> bekleniyor).' };
    }

    const presented = sha256(match[1].trim());
    let ok = false;
    // Tüm kayıtlı anahtarlar üzerinde dön; hash uzunlukları sabit (32 byte).
    for (const known of keyHashes) {
      if (presented.length === known.length && timingSafeEqual(presented, known)) {
        ok = true;
      }
    }
    return ok ? { ok: true } : { ok: false, reason: 'Geçersiz API anahtarı.' };
  };
}
