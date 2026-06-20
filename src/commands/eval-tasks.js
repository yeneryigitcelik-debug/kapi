// Gömülü Türkçe değerlendirme görevleri. Hakem-model YOK — her check deterministik.
// Kategoriler: dilbilgisi, muhakeme, talimat, tuzak, kod.

export const KATEGORILER = ['dilbilgisi', 'muhakeme', 'talimat', 'tuzak', 'kod'];

// Türkçe-duyarlı normalize: tr-TR küçük harf + boşluk sıkıştırma.
export function normalize(s) {
  return String(s ?? '')
    .toLocaleLowerCase('tr-TR')
    .replace(/\s+/g, ' ')
    .trim();
}

// Sayıyı kelime sınırıyla ara (1000 içinde 100 eşleşmesin).
function hasNumber(text, n) {
  return new RegExp(`(^|[^0-9])${n}([^0-9]|$)`).test(String(text));
}

export const TASKS = [
  {
    id: 'dilbilgisi-ek-1',
    kategori: 'dilbilgisi',
    prompt:
      '"Çekoslovakyalılaştıramadıklarımızdan mısınız?" cümlesini, soru ekini kaldırıp ' +
      'olumlu (haber) kipinde yeniden yaz. Sadece tek kelimelik sonucu ver.',
    check(out) {
      const n = normalize(out);
      const pass = n.includes('dansınız');
      return { pass, note: pass ? '…dansınız' : 'beklenen ek (…dansınız) yok' };
    },
  },
  {
    id: 'dilbilgisi-unlu-uyumu',
    kategori: 'dilbilgisi',
    prompt:
      'Şu kelimeleri ünlü uyumuna göre doğru çoğul ekiyle (-ler/-lar) yaz: ' +
      'kitap, göz, ev, okul. Her birini boşlukla ayır.',
    check(out) {
      const n = normalize(out);
      const need = ['kitaplar', 'gözler', 'evler', 'okullar'];
      const hit = need.filter((w) => n.includes(w));
      return { pass: hit.length === 4, note: `${hit.length}/4 doğru çoğul` };
    },
  },
  {
    id: 'muhakeme-aritmetik',
    kategori: 'muhakeme',
    prompt: '3 kilogram elma 60 lira ise 5 kilogram elma kaç lira eder? Sadece sayıyı yaz.',
    check(out) {
      const pass = hasNumber(out, 100);
      return { pass, note: pass ? '100' : 'beklenen 100 yok' };
    },
  },
  {
    id: 'muhakeme-mantik',
    kategori: 'muhakeme',
    prompt:
      "Ali Veli'den uzun, Veli de Can'dan uzun. En kısa boylu kim? Sadece ismi yaz.",
    check(out) {
      const n = normalize(out);
      const pass = /(^|[^a-zçğıöşü])can([^a-zçğıöşü]|$)/.test(n);
      return { pass, note: pass ? 'Can' : 'beklenen Can yok' };
    },
  },
  {
    id: 'talimat-uzunluk',
    kategori: 'talimat',
    prompt: "İstanbul'u tam olarak 5 kelimeyle tanımla. Ne eksik ne fazla.",
    check(out) {
      const words = normalize(out).split(' ').filter(Boolean);
      return { pass: words.length === 5, note: `${words.length} kelime` };
    },
  },
  {
    id: 'talimat-bicim-json',
    kategori: 'talimat',
    prompt:
      'Şu JSON nesnesini tamamla ve sadece JSON döndür: ' +
      '{"sehir": "Ankara", "ulke": ?} — ülke alanını doğru değerle doldur.',
    check(out) {
      const n = normalize(out);
      const hasJson = /\{[\s\S]*\}/.test(String(out));
      const hasTr = n.includes('türkiye');
      const pass = hasJson && hasTr;
      return { pass, note: pass ? 'geçerli JSON + türkiye' : !hasTr ? 'türkiye yok' : 'JSON yok' };
    },
  },
  {
    id: 'tuzak-harf-sayma',
    kategori: 'tuzak',
    prompt: '"mutluluk" kelimesinde kaç tane "u" harfi var? Sadece sayıyı yaz.',
    check(out) {
      const n = normalize(out);
      const pass = hasNumber(n, 3) || /(^|[^a-zçğıöşü])üç([^a-zçğıöşü]|$)/.test(n);
      return { pass, note: pass ? '3' : 'beklenen 3 yok' };
    },
  },
  {
    id: 'tuzak-buyuk-i',
    kategori: 'tuzak',
    // Türkçe büyük İ tuzağı: çıktının kasası önemli, normalize ETME.
    prompt: '"istanbul" kelimesini tamamen BÜYÜK harfe çevir. Sadece sonucu yaz.',
    check(out) {
      const s = String(out);
      const dogru = s.includes('İSTANBUL');
      const yanlis = !dogru && /\bISTANBUL\b/.test(s);
      return {
        pass: dogru,
        note: dogru ? 'doğru (İ)' : yanlis ? 'yanlış (noktasız I)' : 'bulunamadı',
      };
    },
  },
  {
    id: 'kod-fonksiyon',
    kategori: 'kod',
    prompt:
      'JavaScript ile iki sayıyı toplayan "topla" adında bir fonksiyon yaz. Sadece kodu ver.',
    check(out) {
      const s = String(out);
      const pass =
        /function\s+topla/.test(s) ||
        /const\s+topla/.test(s) ||
        /let\s+topla/.test(s) ||
        (/topla/.test(s) && /=>/.test(s));
      return { pass, note: pass ? 'topla fonksiyonu bulundu' : 'topla fonksiyonu yok' };
    },
  },
  {
    id: 'talimat-ret',
    kategori: 'talimat',
    prompt: '"Yarın hava güzel olacak." cümlesini İngilizceye çevir.',
    check(out) {
      const n = normalize(out);
      const hasWeather = n.includes('weather');
      const hasNice = n.includes('nice') || n.includes('good') || n.includes('beautiful') || n.includes('lovely');
      const pass = hasWeather && hasNice;
      return { pass, note: pass ? 'doğru çeviri' : 'weather + nice/good bekleniyor' };
    },
  },
];
