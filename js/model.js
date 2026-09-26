// Модель данных: стабильные идентификаторы, пиньинь, разбор импорта.

const TONE_MAP = {
  'ā':'a1','á':'a2','ǎ':'a3','à':'a4','ē':'e1','é':'e2','ě':'e3','è':'e4',
  'ī':'i1','í':'i2','ǐ':'i3','ì':'i4','ō':'o1','ó':'o2','ǒ':'o3','ò':'o4',
  'ū':'u1','ú':'u2','ǔ':'u3','ù':'u4','ǖ':'v1','ǘ':'v2','ǚ':'v3','ǜ':'v4','ü':'v'
};

/** «nǐ hǎo» → { display:'nǐ hǎo', numeric:'ni3 hao3', key:'ni3hao3' } */
export function normalizePinyin(raw) {
  const display = String(raw ?? '').normalize('NFC').trim().replace(/\s+/g, ' ');
  if (!display) return { display: '', numeric: '', key: '' };
  let numeric = '';
  for (const ch of display) numeric += TONE_MAP[ch] ?? TONE_MAP[ch.toLowerCase()] ?? ch;
  // уже цифровой пиньинь оставляем как есть; тон переносим в конец слога
  numeric = numeric.toLowerCase()
    .replace(/([a-zü]*)([1-5])([a-zü]+)/g, (_, a, t, b) => `${a}${b}${t}`)
    .replace(/\s+/g, ' ')
    .trim();
  const key = numeric.replace(/[^a-z0-9]/g, '');
  return { display, numeric, key };
}

/** FNV-1a — короткий детерминированный хеш для ключей и контрольных сумм. */
export function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36).padStart(7, '0');
}
export function checksum(obj) {
  const canon = JSON.stringify(obj, Object.keys(obj).sort ? undefined : undefined);
  let a = 0x811c9dc5, b = 0x9e3779b9;
  for (let i = 0; i < canon.length; i++) {
    a ^= canon.charCodeAt(i); a = Math.imul(a, 0x01000193) >>> 0;
    b = (b + canon.charCodeAt(i) * (i % 31 + 1)) >>> 0;
  }
  return `${a.toString(16).padStart(8,'0')}${b.toString(16).padStart(8,'0')}`;
}

/**
 * Стабильный id слова. Разные чтения и разные помеченные значения
 * НИКОГДА не сливаются: в ключ входят и пиньинь, и метка значения.
 */
export function makeEntryId({ hanzi, pinyin, sense = '', ns = 'w' }) {
  const p = normalizePinyin(pinyin).key;
  const s = String(sense ?? '').trim();
  const base = `${hanzi}#${p}${s ? '~' + s : ''}`;
  return `${ns}:${hash32(base)}`;
}
export const makeLinkId = (entryId, lessonId) => `lnk:${hash32(entryId + '|' + lessonId)}`;
export const uid = (prefix = 'id') =>
  `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;

export function makeEntry(row, { source, collectionId }) {
  const hanzi = String(row.hanzi ?? '').normalize('NFC').trim();
  const pin = normalizePinyin(row.pinyin);
  const sense = String(row.sense ?? '').trim();
  // senseKey участвует только в идентификаторе: словарь различает 点 и 点#2,
  // но показывать пользователю служебную метку незачем.
  const senseKey = String(row.senseKey ?? sense).trim();
  const id = makeEntryId({ hanzi, pinyin: pin.display, sense: senseKey, ns: collectionId === 'hsk' ? 'h' : 't' });
  return {
    id, hanzi,
    pinyin: pin.display, pinyinNum: pin.numeric, pinyinKey: pin.key,
    sense, senseKey,
    ru: String(row.ru ?? '').trim(),
    pos: String(row.pos ?? '').trim(),
    hskLevel: row.hskLevel ? String(row.hskLevel).trim() : '',
    confidence: normalizeConfidence(row.confidence),
    examples: Array.isArray(row.examples) ? row.examples.map(normalizeExample).filter(Boolean) : [],
    source, createdAt: new Date().toISOString()
  };
}
/** 'low' | 'низкая' | '?' → 'check': строка помечена неуверенной и ждёт сверки с книгой. */
export function normalizeConfidence(v) {
  const t = String(v ?? '').trim().toLowerCase();
  if (!t) return 'confirmed';
  return /^(low|низк|сомнит|\?|проверить|check|maybe)/.test(t) ? 'check' : 'confirmed';
}

function normalizeExample(ex) {
  if (!ex) return null;
  const zh = String(ex.zh ?? ex.hanzi ?? '').trim();
  if (!zh) return null;
  return { zh, pinyin: normalizePinyin(ex.pinyin).display, ru: String(ex.ru ?? '').trim() };
}

export const ENTRY_REQUIRED = ['hanzi', 'ru'];
export function validateRow(row, index) {
  const problems = [];
  const hanzi = String(row.hanzi ?? '').trim();
  if (!hanzi) problems.push('пустое поле 汉字');
  else if (!/[㐀-鿿豈-﫿]/.test(hanzi)) problems.push('в поле 汉字 нет китайских иероглифов');
  if (!String(row.ru ?? '').trim()) problems.push('пустой перевод');
  if (hanzi.length > 24) problems.push('слишком длинная запись для слова');
  return problems.length ? { line: index + 1, hanzi, problems } : null;
}

/**
 * Разбор CSV с кавычками, любым переводом строк и BOM.
 * Разделитель определяется по строке заголовка, поэтому точка с запятой
 * внутри перевода («расти; старший») не рвёт строку на лишние колонки.
 */
export function detectDelimiter(firstLine) {
  const counts = [[',', 0], [';', 0], ['\t', 0]];
  let q = false;
  for (const ch of firstLine) {
    if (ch === '"') q = !q;
    else if (!q) for (const c of counts) if (ch === c[0]) c[1]++;
  }
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ',';
}

export function parseCSV(text, delimiter = null) {
  const src = String(text).replace(/^\uFEFF/, '');
  const sep = delimiter || detectDelimiter(src.split(/\r?\n/, 1)[0] || '');
  const rows = []; let field = ''; let row = []; let q = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === '"') { if (src[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === sep) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(v => v.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some(v => v.trim() !== '')) rows.push(row);
  if (!rows.length) return { header: [], rows: [], delimiter: sep };
  const header = rows[0].map(h => h.trim().toLowerCase());
  return { header, delimiter: sep, rows: rows.slice(1).map(r => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim()]))) };
}

const ALIASES = {
  hanzi: ['hanzi', '汉字', 'иероглиф', 'слово', 'word', 'h', 'chinese'],
  pinyin: ['pinyin', '拼音', 'пиньинь', 'p', 'reading'],
  ru: ['ru', 'перевод', 'русский', 'translation', 'meaning', 'r'],
  pos: ['pos', 'часть речи', 'part of speech', 'k'],
  sense: ['sense', 'значение', 'смысл'],
  lesson: ['lesson', 'урок', '课', 'номер урока', 'l'],
  confidence: ['confidence', 'уверенность', 'проверить', 'check'],
  hskLevel: ['hsk', 'level', 'уровень', 'hsklevel'],
  page: ['page', 'страница', 'стр'],
  example: ['example', 'пример', '例句'],
  examplePinyin: ['example_pinyin', 'пример_пиньинь'],
  exampleRu: ['example_ru', 'пример_перевод']
};
/** Приводит произвольные заголовки колонок к полям модели. */
export function mapColumns(header) {
  const map = {};
  for (const [field, names] of Object.entries(ALIASES)) {
    const hit = header.find(h => names.includes(h));
    if (hit) map[field] = hit;
  }
  return map;
}

/** Строки CSV/JSON → { entries, links, issues } */
export function buildImport(rawRows, { collectionId, lessonId = null, source }) {
  const entries = new Map(); const links = new Map(); const issues = [];
  rawRows.forEach((row, i) => {
    const bad = validateRow(row, i);
    if (bad) { issues.push(bad); return; }
    const entry = makeEntry(row, { source, collectionId });
    const prev = entries.get(entry.id);
    if (prev) {                       // тот же иероглиф + чтение + значение — дополняем, не плодим
      if (entry.ru && !prev.ru.includes(entry.ru)) prev.ru += '; ' + entry.ru;
      prev.examples.push(...entry.examples);
    } else entries.set(entry.id, entry);
    // номер урока из строки файла → урок учебника; урок, переданный вызовом, берётся как есть
    // (раньше и он проходил через преобразование, и «hsk.hsk1» превращался в «bc40.l01»)
    const fromRow = row.lesson != null && String(row.lesson).trim() !== '';
    const targets = fromRow ? String(row.lesson).split(/[,;\s]+/).filter(Boolean) : (lessonId ? [lessonId] : []);
    for (const t of targets) {
      const lid = !fromRow || /^bc40\./.test(t) ? t : `bc40.l${String(t).replace(/\D/g, '').padStart(2, '0')}`;
      if (!/^bc40\.l\d{2}$/.test(lid) && !lessonId) { issues.push({ line: i + 1, hanzi: entry.hanzi, problems: [`непонятный номер урока «${t}»`] }); continue; }
      const id = makeLinkId(entry.id, lid);
      if (!links.has(id)) links.set(id, {
        id, entryId: entry.id, lessonId: lid, collectionId,
        order: links.size, page: row.page ? String(row.page) : '', source,
        confidence: entry.confidence,
        createdAt: new Date().toISOString()
      });
    }
  });
  return { entries: [...entries.values()], links: [...links.values()], issues };
}
