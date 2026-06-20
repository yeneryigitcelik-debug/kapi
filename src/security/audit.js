// Denetim günlüğü (audit log) — istek başına SADECE metadata, JSONL.
// KVKK: prompt/yanıt içeriği ASLA yazılmaz. Sync append → dayanıklı + deterministik.
import { appendFileSync } from 'node:fs';

export function makeAudit(cfg) {
  const path = cfg?.security?.audit_log;
  if (!path) return () => {}; // kapalı

  const log = cfg?.__log;
  let warned = false;

  return function audit(entry) {
    try {
      appendFileSync(path, JSON.stringify(entry) + '\n');
    } catch (e) {
      // Audit yazımı isteği asla düşürmesin; bir kez uyar.
      if (!warned) {
        warned = true;
        log?.warn?.(`audit_log yazılamadı (${path}): ${e.message}`);
      }
    }
  };
}
