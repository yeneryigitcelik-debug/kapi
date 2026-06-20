// Bağımlılıksız, TTY-duyarlı logger. Yapısal satırlar stderr'e; ham çıktı stdout'a.

const COLOR = process.stderr.isTTY && !process.env.NO_COLOR;

function wrap(code) {
  return (s) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : String(s));
}

export const dim = wrap('2');
export const bold = wrap('1');
export const red = wrap('31');
export const green = wrap('32');
export const yellow = wrap('33');
export const cyan = wrap('36');

function ts() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function line(tag, colorFn, msg) {
  return `${dim(ts())} ${colorFn(tag)} ${msg}`;
}

export const log = {
  info: (m) => console.error(line('•', cyan, m)),
  warn: (m) => console.error(line('!', yellow, m)),
  error: (m) => console.error(line('✗', red, m)),
  ok: (m) => console.error(line('✓', green, m)),
  // Banner / skor kartı gibi kullanıcıya dönük çıktılar stdout'a.
  raw: (m = '') => console.log(m),
};

export default log;
