// Каталог: коллекции, уроки, слова, связи, скачивание наборов для офлайна.
import * as db from './db.js';
import { buildImport, makeEntry, makeEntryId, makeLinkId, normalizePinyin, parseCSV, mapColumns, uid, checksum } from './model.js';

export const TEXTBOOK_ID = 'bc40';
export const HSK_ID = 'hsk';
const MANIFEST_URL = 'data/textbook/basic-chinese-40/manifest.json';
const HSK_INDEX_URL = 'data/hsk/index.json';
const DEMO_URL = 'data/demo/demo-ru.json';

/** Загрузка JSON с проверкой: страница 404 в виде HTML не должна попасть в базу. */
export async function fetchJSON(url, { signal } = {}) {
  const res = await fetch(url, { signal, cache: 'no-cache' });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  const text = await res.text();
  const head = text.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html')) throw new Error(`${url}: пришёл HTML, а не JSON (вероятно, страница ошибки)`);
  if (!ct.includes('json') && !head.startsWith('{') && !head.startsWith('[')) throw new Error(`${url}: неожиданный тип ответа ${ct || '—'}`);
  try { return JSON.parse(text); }
  catch (e) { throw new Error(`${url}: содержимое не разбирается как JSON (${e.message})`); }
}

/* ---------- первичное заполнение ---------- */
export async function seedTextbook() {
  const m = await fetchJSON(MANIFEST_URL);
  await db.put('collections', {
    id: TEXTBOOK_ID, kind: 'textbook', title: m.titleRu, titleZh: m.titleZh,
    edition: m.edition, editors: m.editors, publisher: m.publisher,
    volumes: m.volumes, sources: m.sources, disclaimer: m.disclaimer
  });
  const existing = new Map((await db.byIndex('lessons', 'byCollection', IDBKeyRange.only(TEXTBOOK_ID))).map(l => [l.id, l]));
  const rows = m.lessons.map(l => ({
    ...l, collectionId: TEXTBOOK_ID, kind: 'lesson',
    part: /^语音/.test(l.titleZh) ? 'phonetics' : 'text',          // 1–5: фонетические уроки
    titleRu: existing.get(l.id)?.titleRu ?? l.titleRu,   // ручной перевод названия не затираем
    ...(existing.get(l.id)?.bookCoverage ? { bookCoverage: existing.get(l.id).bookCoverage, vocabularyStatus: existing.get(l.id).vocabularyStatus } : {}),
    ...(existing.get(l.id)?.confirmedSource ? { confirmedSource: existing.get(l.id).confirmedSource, vocabularyStatus: existing.get(l.id).vocabularyStatus } : {})
  }));
  for (const r of m.reviews) rows.push({ ...r, collectionId: TEXTBOOK_ID, kind: 'review', vocabularyStatus: 'n/a' });
  (m.appendices || []).forEach((a, i) => rows.push({ ...a, id: `bc40.a${i + 1}`, collectionId: TEXTBOOK_ID, kind: 'appendix', vocabularyStatus: 'n/a' }));
  await db.putMany('lessons', rows);
  await db.metaSet('textbookManifestAt', new Date().toISOString());
  return m;
}

export async function seedDemo() {
  const pack = await fetchJSON(DEMO_URL);
  await db.put('collections', { id: 'demo', kind: 'demo', title: pack.title, warning: pack.warning });
  const { entries, links } = buildImport(pack.words, { collectionId: 'demo', lessonId: 'demo.all', source: 'demo' });
  await db.put('lessons', { id: 'demo.all', collectionId: 'demo', kind: 'lesson', number: 0, titleZh: '', titleRu: pack.title, vocabularyStatus: 'confirmed', sources: ['demo'] });
  await db.putMany('entries', entries);
  await db.putMany('links', links);
  return entries.length;
}

export async function removeDemo() {
  const links = await db.byIndex('links', 'byCollection', IDBKeyRange.only('demo'));
  for (const l of links) await db.del('links', l.id);
  for (const e of await db.getAll('entries')) if (e.source === 'demo') await db.del('entries', e.id);
  await db.del('lessons', 'demo.all');
  await db.del('collections', 'demo');
  return links.length;
}

/**
 * Починка связей, созданных старой версией скачивания HSK: слова набора hsk1…hsk6
 * были привязаны к урокам учебника 1–6 (и hsk7-9 к несуществующему bc40.l79).
 * Слова и прогресс не трогаются — прогресс привязан к слову, а не к связи.
 */
export async function repairHskLinks() {
  if (await db.metaGet('fix:hskLinks@1')) return 0;
  const bad = (await db.getAll('links')).filter(l => l.collectionId === HSK_ID && String(l.lessonId).startsWith('bc40.'));
  const fixed = bad.map(l => {
    const pack = String(l.source || '').replace(/^hsk:/, '');
    const lessonId = `hsk.${pack}`;
    return { ...l, id: makeLinkId(l.entryId, lessonId), lessonId, repairedFrom: l.lessonId };
  });
  if (bad.length) {
    await db.tx('links', 'readwrite', t => { const os = t.objectStore('links'); for (const l of bad) os.delete(l.id); for (const l of fixed) os.put(l); });
    for (const lid of new Set(bad.map(l => l.lessonId))) await refreshLessonStatus(lid);
  }
  await db.metaSet('fix:hskLinks@1', { at: new Date().toISOString(), moved: bad.length });
  return bad.length;
}

/**
 * Слова учебника, найденные на страницах книги (data/textbook/…/words.json).
 * Только подтверждённые страницей строки; повторный запуск ничего не дублирует,
 * прогресс не трогается (он привязан к слову, а не к связи).
 */
// На публичном адресе (GitHub Pages) этого файла нет: словарь уроков составлен по скану книги и не публикуется.
// Пользователь загружает свой файл словаря на устройство («Данные» → «Словарь учебника»); копия хранится в базе
// (meta bookWordsFile), поэтому уроки работают без сети и пересобираются при обновлении приложения.
const BOOK_WORDS_URL = 'data/textbook/basic-chinese-40/words.json';
export const BOOK_WORDS_SCHEMA = 'hanzi-hsk123/textbook-words@1';
export function checkBookWords(data) {
  if (!data || data.schema !== BOOK_WORDS_SCHEMA) return 'это не файл словаря учебника (' + (data?.schema || data?.format || 'формат не указан') + ')';
  if (!Array.isArray(data.items) || !data.items.length) return 'в файле нет слов';
  const bad = data.items.findIndex(it => !it || !it.hanzi || !it.lesson);
  return bad >= 0 ? `строка ${bad + 1}: нет иероглифов или номера урока` : null;
}
/** Загрузить словарь учебника из файла пользователя: проверка, копия в базе, те же идентификаторы слов. */
export async function importBookWords(data, { name = '' } = {}) {
  const problem = checkBookWords(data);
  if (problem) throw new Error(problem);
  await db.metaSet('bookWordsFile', { data, name, checksum: checksum(data), at: new Date().toISOString() });
  return syncTextbookWords();
}
export async function bookWordsStatus() {
  const [meta, file] = [await db.metaGet('bookWords'), await db.metaGet('bookWordsFile')];
  return { loaded: !!meta?.count, count: meta?.count || 0, at: meta?.at || null, from: meta?.from || null, fileName: file?.name || '', fileAt: file?.at || null };
}
export async function syncTextbookWords() {
  let data = null, from = 'сайт';
  try { data = await fetchJSON(BOOK_WORDS_URL); if (checkBookWords(data)) data = null; } catch {}
  if (!data) { data = (await db.metaGet('bookWordsFile'))?.data || null; from = 'файл'; }
  if (!data) return { skipped: 'словаря учебника нет на сайте и не загружено файла' };
  const sum = checksum(data);
  // версия кода синхронизации: новые поля (hskId) должны дописаться, даже если файл данных
  // уже был прочитан старой версией приложения при обновлении
  const V = 4;   // 3: отдельные записи для второго значения слова (sense); 4: перенос прогресса при смене идентификатора
  const prev = await db.metaGet('bookWords');
  if (prev?.checksum === sum && prev?.v === V) return { skipped: 'без изменений' };
  const perLesson = new Map();
  const entries = new Map(), links = [];
  for (const it of data.items) {
    const lessonId = `bc40.l${String(it.lesson).padStart(2, '0')}`;
    const n = (perLesson.get(lessonId) || 0) + 1; perLesson.set(lessonId, n);
    const e = makeEntry({ hanzi: it.hanzi, pinyin: it.pinyin, ru: it.ru, senseKey: it.sense || '', pos: it.pos || (it.proper ? 'имя' : '') }, { source: `book:${it.source}`, collectionId: TEXTBOOK_ID });
    if (it.hskId) { e.hskId = it.hskId; e.hskPack = it.hskPack; }        // то же слово в HSK: примеры, уровень
    if (!entries.has(e.id)) entries.set(e.id, e);
    links.push({
      id: makeLinkId(e.id, lessonId), entryId: e.id, lessonId, collectionId: TEXTBOOK_ID,
      order: n, page: String(it.page || ''), section: it.section, source: `book:${it.source}`,
      bookMeaning: it.bookMeaning || '', context: it.context || '', note: it.note || '', ruSource: it.ruSource || '',
      confidence: 'book', createdAt: new Date().toISOString()
    });
  }
  const keep = new Set(links.map(l => l.id));
  const stale = (await db.byIndex('links', 'byCollection', IDBKeyRange.only(TEXTBOOK_ID))).filter(l => String(l.source).startsWith('book:') && !keep.has(l.id));
  await db.putMany('entries', [...entries.values()]);
  await db.tx('links', 'readwrite', t => { const os = t.objectStore('links'); for (const l of stale) os.delete(l.id); for (const l of links) os.put(l); });
  for (const c of data.coverage || []) {
    const les = await db.get('lessons', `bc40.l${String(c.lesson).padStart(2, '0')}`);
    if (!les) continue;
    const cov = (data.coverage || []).filter(x => x.lesson === c.lesson).map(x => ({ what: x.what, complete: !!x.complete, lessonComplete: !!x.lessonComplete }));
    await db.put('lessons', { ...les, bookCoverage: cov, vocabularyStatus: cov.some(x => x.lessonComplete) ? 'confirmed' : cov.every(x => x.complete) ? 'unverified' : 'partial' });   // «весь урок сверен» — только явно
  }
  await carryOver(data.renames || {});
  await db.metaSet('bookWords', { v: V, checksum: sum, count: links.length, at: new Date().toISOString(), sources: data.sources, from });
  return { count: links.length };
}

// Идентификатор слова сменился (исправлено чтение): прогресс и заметка к слову копируются на новый
// идентификатор, если там ещё ничего нет. Старые записи не удаляются — ничего не теряется.
async function carryOver(renames) {
  const pairs = Object.entries(renames);
  if (!pairs.length) return 0;
  const progress = await db.getAll('progress'), notes = await db.getAll('notes');
  let n = 0;
  for (const [from, to] of pairs) {
    for (const p of progress.filter(r => r.entryId === from)) {
      const pk = `${p.profileId}::${to}`;
      if (!(await db.get('progress', pk))) { await db.put('progress', { ...p, pk, entryId: to, carriedFrom: from }); n++; }
    }
    for (const nt of notes.filter(r => r.targetType === 'entry' && r.targetId === from)) {
      const has = await db.byIndex('notes', 'byTarget', IDBKeyRange.only([nt.profileId, 'entry', to]));
      if (!has.length) { await db.put('notes', { ...nt, id: nt.id + '~' + to, targetId: to, carriedFrom: from }); n++; }
    }
  }
  return n;
}

export async function ensureSeeded() {
  const seeded = await db.metaGet('seededAt');
  if (!seeded) {
    await seedTextbook();
    try { await seedDemo(); } catch (e) { console.warn('демо-набор не загружен', e); }
    await db.metaSet('seededAt', new Date().toISOString());
  } else if (!(await db.get('collections', TEXTBOOK_ID)) || !(await db.metaGet('textbookSeed@2'))) {
    await seedTextbook();                       // v2: типы разделов и приложения книги
  }
  await db.metaSet('textbookSeed@2', true);
  await repairHskLinks();
  await syncTextbookWords();
}

/* ---------- чтение ---------- */
export const listLessons = async (collectionId = TEXTBOOK_ID) =>
  (await db.byIndex('lessons', 'byCollection', IDBKeyRange.only(collectionId)))
    .sort(bookOrder);

// Порядок оглавления: том, затем страница (повторения и приложения встают между уроками, как в книге)
const VOL = { shang: 0, xia: 1 };
export const bookOrder = (a, b) => (VOL[a.volume] ?? 9) - (VOL[b.volume] ?? 9) || (Number(a.page) || 0) - (Number(b.page) || 0)
  || (a.number || 0) - (b.number || 0) || String(a.id).localeCompare(String(b.id));

export const getLesson = (id) => db.get('lessons', id);
export const getEntry = (id) => db.get('entries', id);

export async function lessonLinks(lessonId) {
  return (await db.byIndex('links', 'byLesson', IDBKeyRange.only(lessonId))).sort((a, b) => (a.order || 0) - (b.order || 0));
}
export async function lessonEntries(lessonId) {
  const links = await lessonLinks(lessonId);
  const out = [];
  for (const l of links) { const e = await db.get('entries', l.entryId); if (e) out.push({ ...e, link: l }); }
  return out;
}
export async function entryLessons(entryId) {
  const links = await db.byIndex('links', 'byEntry', IDBKeyRange.only(entryId));
  const out = [];
  for (const l of links) { const les = await db.get('lessons', l.lessonId); if (les) out.push(les); }
  return out.sort((a, b) => (a.number || 0) - (b.number || 0));
}
export const lessonWordCount = (lessonId) => db.countIndex('links', 'byLesson', IDBKeyRange.only(lessonId));

/** Поиск по иероглифам, пиньиню (с тонами и без) и русскому переводу. */
export async function search(query, { limit = 60 } = {}) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  const qp = normalizePinyin(q).key;
  const all = await db.getAll('entries');
  const scored = [];
  for (const e of all) {
    let score = -1;
    if (e.hanzi === q) score = 0;
    else if (e.hanzi.includes(q)) score = 1;
    else if (qp && e.pinyinKey === qp) score = 2;
    else if (qp && e.pinyinKey.startsWith(qp)) score = 3;
    else if (e.pinyin.toLowerCase().includes(q)) score = 4;
    else if (e.ru.toLowerCase().includes(q)) score = 5;
    if (score >= 0) scored.push({ e, score });
    if (scored.length > 4000) break;
  }
  scored.sort((a, b) => a.score - b.score || a.e.hanzi.length - b.e.hanzi.length);
  return scored.slice(0, limit).map(s => s.e);
}

/* ---------- запись ---------- */
export async function addWord(row, { lessonId = null, collectionId = TEXTBOOK_ID, source = 'user' } = {}) {
  const entry = makeEntry(row, { source, collectionId });
  const prev = await db.get('entries', entry.id);
  await db.put('entries', prev ? { ...prev, ...entry, createdAt: prev.createdAt } : entry);
  if (lessonId) {
    const id = makeLinkId(entry.id, lessonId);
    if (!(await db.get('links', id))) {
      await db.put('links', { id, entryId: entry.id, lessonId, collectionId, order: await lessonWordCount(lessonId), page: row.page || '', source, createdAt: new Date().toISOString() });
    }
    await refreshLessonStatus(lessonId);
  }
  return entry;
}

export async function removeLink(linkId) {
  const link = await db.get('links', linkId);
  if (!link) return;
  await db.del('links', linkId);
  await refreshLessonStatus(link.lessonId);
}

export async function refreshLessonStatus(lessonId) {
  const lesson = await db.get('lessons', lessonId);
  if (!lesson) return;
  const links = await lessonLinks(lessonId);
  lesson.wordCount = links.length;
  lesson.toCheck = links.filter(l => l.confidence === 'check').length;
  if (lesson.toCheck > 0) lesson.vocabularyStatus = 'check';
  else if (lesson.vocabularyStatus !== 'confirmed' || links.length === 0) {
    lesson.vocabularyStatus = links.length === 0 ? 'empty' : 'partial';
  }
  await db.put('lessons', lesson);
  return lesson;
}

/** Снимает пометку «проверить» после сверки строки с книгой. */
export async function confirmLink(linkId) {
  const link = await db.get('links', linkId);
  if (!link) return null;
  link.confidence = 'confirmed';
  link.confirmedAt = new Date().toISOString();
  await db.put('links', link);
  const entry = await db.get('entries', link.entryId);
  if (entry) { entry.confidence = 'confirmed'; await db.put('entries', entry); }
  await refreshLessonStatus(link.lessonId);
  return link;
}

/** Все строки, ожидающие сверки с книгой. */
export async function pendingChecks() {
  const links = (await db.getAll('links')).filter(l => l.confidence === 'check');
  const out = [];
  for (const l of links) {
    const e = await db.get('entries', l.entryId);
    const les = await db.get('lessons', l.lessonId);
    if (e && les) out.push({ entry: e, link: l, lesson: les });
  }
  return out.sort((a, b) => (a.lesson.number || 0) - (b.lesson.number || 0) || (a.link.order || 0) - (b.link.order || 0));
}
export async function markLessonConfirmed(lessonId, sourceNote) {
  const lesson = await db.get('lessons', lessonId);
  if (!lesson) return;
  if (lesson.toCheck > 0) throw new Error(`Сначала сверьте ${lesson.toCheck} строк с пометкой «проверить»`);
  lesson.vocabularyStatus = 'confirmed';
  lesson.confirmedSource = String(sourceNote || '').slice(0, 300);
  lesson.confirmedAt = new Date().toISOString();
  await db.put('lessons', lesson);
  return lesson;
}

/** Импорт файла CSV/JSON. Возвращает отчёт, ничего не пишет при dryRun. */
export async function importWordFile(text, { lessonId = null, collectionId = TEXTBOOK_ID, sourceLabel = 'import', dryRun = false, filename = '' } = {}) {
  let rows;
  const trimmed = String(text).trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const json = JSON.parse(text);
    const list = Array.isArray(json) ? json : (json.words || json.entries || json.data || []);
    rows = list.map(adaptRecord);
  } else {
    const { header, rows: csvRows } = parseCSV(text);
    const map = mapColumns(header);
    if (!map.hanzi) throw new Error('в CSV не найдена колонка с иероглифами (hanzi / 汉字 / слово)');
    rows = csvRows.map(r => ({
      hanzi: r[map.hanzi], pinyin: map.pinyin ? r[map.pinyin] : '', ru: map.ru ? r[map.ru] : '',
      pos: map.pos ? r[map.pos] : '', sense: map.sense ? r[map.sense] : '',
      lesson: map.lesson ? r[map.lesson] : '', page: map.page ? r[map.page] : '',
      hskLevel: map.hskLevel ? r[map.hskLevel] : '',
      confidence: map.confidence ? r[map.confidence] : '',
      examples: map.example && r[map.example] ? [{ zh: r[map.example], pinyin: map.examplePinyin ? r[map.examplePinyin] : '', ru: map.exampleRu ? r[map.exampleRu] : '' }] : []
    }));
  }
  const source = `${sourceLabel}:${filename || 'файл'}`;
  const { entries, links, issues } = buildImport(rows, { collectionId, lessonId, source });
  const report = { total: rows.length, entries: entries.length, links: links.length, issues, lessons: [...new Set(links.map(l => l.lessonId))] };
  if (dryRun) return report;
  const existing = new Map((await db.getAll('entries')).map(e => [e.id, e]));
  await db.putMany('entries', entries.map(e => existing.has(e.id) ? { ...existing.get(e.id), ...e, createdAt: existing.get(e.id).createdAt } : e));
  const already = new Set((await db.getAll('links')).map(l => l.id));
  const fresh = links.filter(l => !already.has(l.id));
  report.newLinks = fresh.length;
  report.skippedLinks = links.length - fresh.length;
  if (fresh.length) await db.putMany('links', fresh);
  for (const lid of report.lessons) await refreshLessonStatus(lid);
  return report;
}

/**
 * Запись из опубликованного приложения: {k,h,p,r,l} — проверено на данных 22.09.2026.
 * Ключ k уже различает значения суффиксом: 点 и 点#2 — разные слова с одним чтением.
 * Он же переносится как legacyKey, чтобы старый прогресс нашёл своё слово.
 */
export function adaptRecord(rec) {
  if (rec && typeof rec === 'object' && 'h' in rec && 'p' in rec && 'r' in rec) {
    const k = String(rec.k ?? '');
    return {
      hanzi: rec.h, pinyin: rec.p, ru: rec.r, hskLevel: rec.l,
      legacyKey: k, senseKey: k && k !== rec.h ? k : '',
      lesson: rec.lesson ?? ''
    };
  }
  return rec;
}

/* ---------- офлайн-наборы ---------- */
export async function hskPacks() {
  let index;
  try { index = await fetchJSON(HSK_INDEX_URL); } catch { return []; }
  const assets = new Map((await db.getAll('assets')).map(a => [a.id, a]));
  return index.packs.map(p => ({ ...p, state: assets.get(p.id) || { id: p.id, status: 'absent', count: 0 } }));
}

/**
 * Скачивание набора. Прерывание не разрушает уже скачанное:
 * слова пишутся пачками и только дополняют базу, статус ставится в конце.
 */
export async function downloadPack(pack, { onProgress = () => {}, signal } = {}) {
  const started = new Date().toISOString();
  await db.put('assets', { id: pack.id, status: 'downloading', startedAt: started, count: (await db.get('assets', pack.id))?.count || 0 });
  const urls = [pack.local, pack.remote].filter(Boolean);
  let data = null, usedUrl = null, lastErr = null;
  for (const url of urls) {
    try { data = await fetchJSON(url, { signal }); usedUrl = url; break; }
    catch (e) { lastErr = e; }
  }
  if (!data) {
    await db.put('assets', { id: pack.id, status: 'failed', error: String(lastErr?.message || lastErr), startedAt: started, count: (await db.get('assets', pack.id))?.count || 0 });
    throw lastErr;
  }
  const list = (Array.isArray(data) ? data : data.words || data.entries || []).map(adaptRecord);
  const lessonId = `hsk.${pack.id}`;
  await db.put('lessons', { id: lessonId, collectionId: HSK_ID, kind: 'hsk', number: 0, titleRu: pack.title, vocabularyStatus: 'confirmed', sources: [usedUrl] });
  if (!(await db.get('collections', HSK_ID))) await db.put('collections', { id: HSK_ID, kind: 'hsk', title: 'Словарь HSK' });

  const CHUNK = 500;
  let done = 0;
  for (let i = 0; i < list.length; i += CHUNK) {
    if (signal?.aborted) { await db.put('assets', { id: pack.id, status: 'partial', count: done, url: usedUrl, startedAt: started }); throw new DOMException('Скачивание отменено', 'AbortError'); }
    const slice = list.slice(i, i + CHUNK);
    const { entries, links } = buildImport(slice, { collectionId: HSK_ID, lessonId, source: `hsk:${pack.id}` });
    const legacyById = new Map();
    for (const row of slice) {
      const e = makeEntry(row, { source: `hsk:${pack.id}`, collectionId: HSK_ID });
      if (row.legacyKey) legacyById.set(e.id, row.legacyKey);
    }
    await db.putMany('entries', entries.map(e => ({ ...e, legacyKey: legacyById.get(e.id) || '' })));
    await db.putMany('links', links);
    done += entries.length;
    onProgress({ done, total: list.length, pack: pack.id });
  }
  await db.put('assets', { id: pack.id, status: 'ready', count: done, url: usedUrl, startedAt: started, finishedAt: new Date().toISOString() });
  try { await syncExamples(pack.id); } catch (e) { console.warn('примеры не скачались', pack.id, e); }   // слова важнее примеров
  return { count: done, url: usedUrl };
}

/* ---------- примеры употребления ---------- */
// Лежат в data/examples/<уровень>.json и хранятся в IndexedDB вместе с набором — без сети
// карточки и практика работают. Обновление примеров заменяет только примеры, прогресс не трогает.
export async function examplesIndex() {
  try { return (await fetchJSON('data/examples/levels.json')).levels || []; } catch { return null; }
}
export async function syncExamples(packId, { force = false } = {}) {
  const idx = await examplesIndex();
  const info = idx?.find(l => l.level === packId);
  if (!info) return { skipped: true };
  const have = await db.metaGet('examples:' + packId, null);
  if (!force && have && have.count === info.examples && have.builtFrom === (info.stamp || info.examples)) return { skipped: true, count: have.count };
  const data = await fetchJSON(`data/examples/${packId}.json`);
  const items = (data.items || []).map(x => ({ ...x, pack: packId }));
  await db.deleteByIndex('examples', 'byPack', IDBKeyRange.only(packId));
  await db.putMany('examples', items);
  await db.metaSet('examples:' + packId, { count: items.length, builtFrom: info.stamp || info.examples, at: new Date().toISOString() });
  return { count: items.length };
}
export const examplesFor = (entryId) => db.byIndex('examples', 'byTid', IDBKeyRange.only(entryId));

export async function totals() {
  return {
    entries: await db.count('entries'),
    links: await db.count('links'),
    lessons: await db.countIndex('lessons', 'byCollection', IDBKeyRange.only(TEXTBOOK_ID))
  };
}
