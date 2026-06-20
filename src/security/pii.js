// PII redaksiyonu — dış sağlayıcıya gitmeden hassas veriyi maskele. Bağımlılıksız.
// Deterministik regex + (TCKN/IBAN için) doğrulama. Türkçe-odaklı.

export const ALL_TYPES = ['tckn', 'telefon', 'email', 'iban'];

// Eş anlamlıları kanonik tipe indir.
const ALIASES = {
  tc: 'tckn',
  kimlik: 'tckn',
  phone: 'telefon',
  tel: 'telefon',
  'e-posta': 'email',
  eposta: 'email',
  mail: 'email',
};
export function normalizeType(t) {
  const k = String(t).toLocaleLowerCase('tr-TR').trim();
  return ALIASES[k] || k;
}

// --- Doğrulayıcılar (yanlış-pozitifi kır) ---

export function isValidTCKN(s) {
  if (!/^[1-9]\d{10}$/.test(s)) return false;
  const d = [...s].map(Number);
  const odd = d[0] + d[2] + d[4] + d[6] + d[8];
  const even = d[1] + d[3] + d[5] + d[7];
  const c10 = (((odd * 7 - even) % 10) + 10) % 10;
  if (c10 !== d[9]) return false;
  const c11 = d.slice(0, 10).reduce((a, b) => a + b, 0) % 10;
  return c11 === d[10];
}

export function isValidIBAN_TR(raw) {
  const s = String(raw).toUpperCase().replace(/\s/g, '');
  if (!/^TR\d{24}$/.test(s)) return false;
  const rearranged = s.slice(4) + s.slice(0, 4);
  let rem = 0;
  for (const ch of rearranged) {
    const code = /[0-9]/.test(ch) ? ch : (ch.charCodeAt(0) - 55).toString();
    for (const dc of code) rem = (rem * 10 + Number(dc)) % 97;
  }
  return rem === 1;
}

// --- Dedektörler ---

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const IBAN_RE = /TR\d{2}(?:[ ]?\d){22}/gi;
const TCKN_RE = /(?<!\d)\d{11}(?!\d)/g;
// Telefon: +90 ya da 0 öneki gerekli (yanlış-pozitifi azaltır).
const PHONE_RE = /(?:\+90[\s-]?|0)\(?\d{3}\)?[\s-]?\d{3}[\s-]?\d{2}[\s-]?\d{2}/g;

const DETECTORS = {
  email: (text) => {
    let n = 0;
    const out = text.replace(EMAIL_RE, () => (n++, '[E-POSTA]'));
    return { out, n };
  },
  iban: (text) => {
    let n = 0;
    const out = text.replace(IBAN_RE, (m) => (isValidIBAN_TR(m) ? (n++, '[IBAN]') : m));
    return { out, n };
  },
  tckn: (text) => {
    let n = 0;
    const out = text.replace(TCKN_RE, (m) => (isValidTCKN(m) ? (n++, '[TCKN]') : m));
    return { out, n };
  },
  telefon: (text) => {
    let n = 0;
    const out = text.replace(PHONE_RE, () => (n++, '[TELEFON]'));
    return { out, n };
  },
};

// Sıra önemli: spesifik/doğrulanan önce, en bulanık (telefon) sonda.
const ORDER = ['email', 'iban', 'tckn', 'telefon'];

export function redactText(text, types) {
  if (typeof text !== 'string' || !Array.isArray(types) || types.length === 0) {
    return { text, counts: {} };
  }
  let out = text;
  const counts = {};
  for (const t of ORDER) {
    if (!types.includes(t)) continue;
    const { out: o, n } = DETECTORS[t](out);
    out = o;
    if (n) counts[t] = (counts[t] || 0) + n;
  }
  return { text: out, counts };
}

// messages[].content (string veya çok-parçalı dizi) içindeki PII'yi maskele.
export function redactMessages(messages, types) {
  if (!Array.isArray(messages) || !Array.isArray(types) || types.length === 0) {
    return { messages, counts: {}, total: 0 };
  }
  const counts = {};
  let total = 0;
  const add = (c) => {
    for (const [k, v] of Object.entries(c)) {
      counts[k] = (counts[k] || 0) + v;
      total += v;
    }
  };
  const out = messages.map((m) => {
    if (!m || typeof m !== 'object') return m;
    if (typeof m.content === 'string') {
      const r = redactText(m.content, types);
      add(r.counts);
      return { ...m, content: r.text };
    }
    if (Array.isArray(m.content)) {
      const content = m.content.map((part) => {
        if (part && typeof part === 'object' && typeof part.text === 'string') {
          const r = redactText(part.text, types);
          add(r.counts);
          return { ...part, text: r.text };
        }
        return part;
      });
      return { ...m, content };
    }
    return m;
  });
  return { messages: out, counts, total };
}

// Bu istek için hangi tipler maskelenecek? null → maskeleme yok.
// Varsayılan: yerel 'ollama' hariç dış sağlayıcılarda maskele. modelCfg.redact override eder.
export function resolveTypes(cfg, modelCfg) {
  const sec = cfg?.security || {};
  if (sec.redact_pii !== true) return null;

  let on;
  if (modelCfg?.redact === true) on = true;
  else if (modelCfg?.redact === false) on = false;
  else on = modelCfg?.provider !== 'ollama';
  if (!on) return null;

  const list = Array.isArray(sec.pii) && sec.pii.length ? sec.pii : ALL_TYPES;
  const types = [...new Set(list.map(normalizeType))].filter((t) => ALL_TYPES.includes(t));
  return types.length ? types : null;
}
