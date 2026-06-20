// Bağımlılıksız argüman ayrıştırıcı.
// Destekler: --bayrak, --anahtar=deger, --anahtar deger, -c/-p/-h/-m/-v alias,
// konumsal argümanlar `_` dizisine.

const BOOLEAN_FLAGS = new Set(['verbose', 'help', 'version']);

// Kısa alias → uzun ad. (-v = verbose; sürüm için --version kullan.)
const ALIASES = {
  c: 'config',
  p: 'port',
  h: 'help',
  m: 'model',
  v: 'verbose',
};

function camel(s) {
  return s.replace(/-([a-z0-9])/gi, (_, c) => c.toUpperCase());
}

function parseVal(v) {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+$/.test(v)) return Number(v);
  return v;
}

export function parseArgs(argv) {
  const out = { _: [] };
  const args = Array.isArray(argv) ? argv.slice() : [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];

    // "--" sonrası her şey konumsaldır.
    if (a === '--') {
      out._.push(...args.slice(i + 1));
      break;
    }

    // Uzun bayrak: --anahtar / --anahtar=deger / --anahtar deger
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      let key = camel(eq === -1 ? a.slice(2) : a.slice(2, eq));
      const inline = eq === -1 ? undefined : a.slice(eq + 1);

      if (BOOLEAN_FLAGS.has(key)) {
        out[key] = inline === undefined ? true : parseVal(inline);
        continue;
      }
      if (inline !== undefined) {
        out[key] = parseVal(inline);
        continue;
      }
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        out[key] = parseVal(next);
        i++;
      } else {
        out[key] = true;
      }
      continue;
    }

    // Kısa bayrak: -c / -p deger / -p=deger
    if (a.length > 1 && a.startsWith('-')) {
      const body = a.slice(1);
      const eq = body.indexOf('=');
      const rawKey = eq === -1 ? body : body.slice(0, eq);
      const inline = eq === -1 ? undefined : body.slice(eq + 1);
      const key = ALIASES[rawKey] || camel(rawKey);

      if (BOOLEAN_FLAGS.has(key)) {
        out[key] = inline === undefined ? true : parseVal(inline);
        continue;
      }
      if (inline !== undefined) {
        out[key] = parseVal(inline);
        continue;
      }
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        out[key] = parseVal(next);
        i++;
      } else {
        out[key] = true;
      }
      continue;
    }

    // Konumsal (komut adı vb.) — ham string olarak sakla.
    out._.push(a);
  }

  return out;
}
