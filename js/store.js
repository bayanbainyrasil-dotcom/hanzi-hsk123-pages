// Доменный слой: профили, прогресс, попытки, заметки, дневник, сессии, повторение.
import * as db from './db.js';
import { uid, checksum } from './model.js';
import { MODE_SKILL, CHOICE_MODES } from './practice.js';

export const MARKS = ['new', 'learning', 'known', 'hard'];
export const MARK_RU = { new: 'новое', learning: 'учу', known: 'знаю', hard: 'трудное' };

// Интервалы повторения в днях — как в прежней версии приложения.
const GAP = [3, 8, 20, 45, 90];
const DAY = 86400000;

let currentProfileId = null;
const listeners = new Set();
export const onChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const emit = (what) => { for (const fn of listeners) { try { fn(what); } catch (e) { console.error(e); } } };

/* ---------- профили ---------- */
export async function listProfiles() {
  const all = await db.getAll('profiles');
  return all.sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
}
export async function createProfile(name, { kind = 'normal' } = {}) {
  const p = { id: uid('pf'), name: String(name || 'Профиль').trim().slice(0, 40), kind, createdAt: new Date().toISOString() };
  await db.put('profiles', p);
  emit('profiles');
  return p;
}
export async function ensureProfile() {
  const saved = await db.metaGet('currentProfileId');
  const all = await listProfiles();
  if (saved && all.some(p => p.id === saved)) { currentProfileId = saved; return saved; }
  const first = all.find(p => p.kind !== 'test') || all[0] || await createProfile('Мой профиль');
  currentProfileId = first.id;
  await db.metaSet('currentProfileId', first.id);
  return first.id;
}
export async function setProfile(id) {
  currentProfileId = id;
  await db.metaSet('currentProfileId', id);
  emit('profile');
}
export const profileId = () => currentProfileId;

/* ---------- прогресс ---------- */
const pk = (entryId, pid = currentProfileId) => `${pid}::${entryId}`;

export async function getProgress(entryId) {
  return (await db.get('progress', pk(entryId))) || null;
}
export async function getProgressMap(entryIds) {
  const out = new Map();
  await Promise.all(entryIds.map(async id => { const p = await getProgress(id); if (p) out.set(id, p); }));
  return out;
}
function blank(entryId) {
  return {
    pk: pk(entryId), profileId: currentProfileId, entryId,
    status: 'new', step: 0, reps: 0, lapses: 0, streak: 0,
    due: Date.now(), lastAt: null, updatedAt: new Date().toISOString()
  };
}
export async function setMark(entryId, mark) {
  if (!MARKS.includes(mark)) throw new Error('неизвестная отметка: ' + mark);
  const p = (await getProgress(entryId)) || blank(entryId);
  p.status = mark;
  if (mark === 'known') { p.step = Math.max(p.step, GAP.length - 1); p.due = Date.now() + GAP[GAP.length - 1] * DAY; }
  if (mark === 'hard') { p.step = 0; p.due = Date.now(); }
  if (mark === 'new') { p.step = 0; p.due = Date.now(); }
  p.markedManually = true;
  p.markedAt = Date.now();
  p.updatedAt = new Date().toISOString();
  await db.put('progress', p);
  emit('progress');
  return p;
}

/** «К повторению»: слово попадает в очередь сейчас; «знаю» не понижается. */
export async function addToReview(entryId) {
  const p = (await getProgress(entryId)) || blank(entryId);
  if (p.status === 'new') p.status = 'learning';
  p.due = Date.now();
  p.markedAt = Date.now();
  p.updatedAt = new Date().toISOString();
  await db.put('progress', p);
  emit('progress');
  return p;
}

/**
 * Ответ пользователя: пишем попытку и двигаем очередь повторения (одна система: step/due).
 * • Самооценка («Не знаю / Почти / Знаю») во всех направлениях — полный вес, как раньше; первое «Знаю» после
 *   нуля — интервал GAP[0] (3 дня), дальше по ступеням (раньше сразу прыгало на 8 дней).
 * • Выбор из вариантов (mode quiz / quiz-au) — слабое свидетельство: ступень не растёт, «знаю» не ставится,
 *   следующая проверка — самостоятельным вспоминанием не позже чем через 3 дня; ошибка — ступень −2 (не сброс),
 *   повтор через 10 минут.
 * • Раздельный учёт навыков p.skills[навык] = {n, ok, almost, bad, last, lastRes} — новые поля; старые записи не
 *   пересчитываются. p.firstAt — первое знакомство (для лимита новых слов в день).
 */
export async function recordAttempt({ entryId, lessonId = null, correct, almost = false, mode = 'drill', answer = '', ms = 0 }) {
  const now = Date.now();
  const attempt = {
    id: uid('at'), profileId: currentProfileId, entryId, lessonId,
    ts: now, mode, correct: !!correct && !almost, ...(almost ? { grade: 'almost' } : {}), answer: String(answer).slice(0, 200), ms
  };
  const p = (await getProgress(entryId)) || blank(entryId);
  if (!p.reps && !p.firstAt) p.firstAt = now;
  p.reps += 1;
  p.lastAt = now;
  const choice = CHOICE_MODES.has(mode);
  if (choice) {
    if (correct) {
      p.due = now + Math.min(GAP[p.step] ?? GAP[0], GAP[0]) * DAY;
      if (p.status === 'new') p.status = 'learning';
    } else {
      p.lapses += 1; p.streak = 0; p.step = Math.max(0, p.step - 2);
      p.due = now + 10 * 60 * 1000;
      if (!p.markedManually || p.status === 'new') p.status = p.lapses >= 3 ? 'hard' : 'learning';
    }
  } else if (almost) {
    // «Почти»: слово не провалено, но и не выучено — ступень не растёт, вернётся завтра
    p.streak = 0;
    p.step = Math.max(1, Math.min(p.step, 1));
    p.due = now + DAY;
    if (!p.markedManually || p.status === 'new') p.status = 'learning';
  } else if (correct) {
    if (p.step === 0 && !p.streak) p.due = now + GAP[0] * DAY;          // первое «знаю» после нуля — 3 дня
    else { p.step = Math.min(p.step + 1, GAP.length - 1); p.due = now + GAP[p.step] * DAY; }
    p.streak += 1;
    // «Знаю» на карточке — как в первой версии: слово сразу считается известным,
    // а в очередь повторения оно всё равно вернётся по интервалу.
    if (!p.markedManually) p.status = mode === 'recall' || mode === 'recall-ru' || mode === 'recall-au' || mode === 'cloze' || p.step >= GAP.length - 1 ? 'known' : 'learning';
  } else {
    p.streak = 0; p.lapses += 1; p.step = 0;
    p.due = now + 10 * 60 * 1000;   // ошибка — вернуть через 10 минут
    if (!p.markedManually) p.status = p.lapses >= 3 ? 'hard' : 'learning';
  }
  const sk = MODE_SKILL[mode];
  if (sk) {
    const res = almost ? 'almost' : correct ? 'ok' : 'bad';
    const cur = { n: 0, ok: 0, almost: 0, bad: 0, ...(p.skills?.[sk] || {}) };
    cur.n += 1; cur[res] += 1; cur.last = now; cur.lastRes = res;
    p.skills = { ...(p.skills || {}), [sk]: cur };
  }
  p.updatedAt = new Date().toISOString();
  // попытка, очередь повторения и занятие — одной транзакцией: либо всё, либо ничего
  if (!session) session = { id: uid('ss'), profileId: currentProfileId, lessonId, startedAt: now, endedAt: null, answered: 0, correct: 0 };
  const ses = { ...session, answered: session.answered + 1, correct: session.correct + (correct && !almost ? 1 : 0), endedAt: now };
  await db.putAll([{ store: 'attempts', value: attempt }, { store: 'progress', value: p }, { store: 'sessions', value: ses }]);
  session = ses;                                  // счётчик в памяти меняем только после подтверждения записи
  emit('progress');
  return { attempt, progress: p };
}

/** Лимит новых слов в день, по профилю. 0 (по умолчанию) — без лимита: учить можно сколько угодно. */
export const NEW_LIMITS = [0, 10, 20, 50, 100, 200];
export const newPerDay = async () => { const n = Number(await db.metaGet('newPerDay:' + currentProfileId, 0)); return n > 0 ? n : Infinity; };
export const setNewPerDay = (n) => db.metaSet('newPerDay:' + currentProfileId, Math.max(0, Math.floor(Number(n) || 0)));
/** Сколько новых слов ещё можно начать сегодня (Infinity — без лимита). */
export async function newLeftToday() { const lim = await newPerDay(); return lim === Infinity ? Infinity : Math.max(0, lim - await newStartedToday()); }
/**
 * Разовый переход к «без лимита» для всех профилей устройства (прежний лимит 5 в день блокировал новые слова).
 * Меняется только эта настройка; отметки, интервалы, заметки и статистика не трогаются.
 */
export async function liftDailyLimitOnce() {
  if (await db.metaGet('fix:unlimitedNew@1')) return 0;
  const rows = (await db.getAll('meta')).filter(m => /^newPerDay:/.test(m.key) && Number(m.value) !== 0);
  await db.tx('meta', 'readwrite', t => { const os = t.objectStore('meta'); for (const m of rows) os.put({ key: m.key, value: 0 }); os.put({ key: 'fix:unlimitedNew@1', value: new Date().toISOString() }); });
  return rows.length;
}
/** Сколько слов станет «пора повторить» в ближайшие ms (без тех, что уже пора). */
export async function dueWithin(entryIds, ms, now = Date.now()) {
  const pm = await profileProgress(); let n = 0;
  for (const id of entryIds) { const p = pm.get(id); if (p && p.reps && p.due > now && p.due <= now + ms) n++; }
  return n;
}
/** Сколько новых слов уже начато сегодня (по первому знакомству firstAt). */
export async function newStartedToday(now = Date.now()) {
  const d = new Date(now); d.setHours(0, 0, 0, 0);
  const rows = await db.byIndex('progress', 'byProfile', IDBKeyRange.only(currentProfileId));
  return rows.filter(r => r.firstAt && r.firstAt >= d.getTime()).length;
}

/** Весь прогресс текущего профиля одним запросом: entryId → запись. */
export async function profileProgress() {
  const rows = await db.byIndex('progress', 'byProfile', IDBKeyRange.only(currentProfileId));
  return new Map(rows.map(r => [r.entryId, r]));
}

export async function progressStats(entryIds, map = null) {
  const counts = { new: 0, learning: 0, known: 0, hard: 0, due: 0 };
  const now = Date.now();
  const pm = map || (entryIds.length > 50 ? await profileProgress() : null);
  for (const id of entryIds) {
    const p = pm ? pm.get(id) : await getProgress(id);
    if (!p) { counts.new++; continue; }
    counts[p.status] = (counts[p.status] || 0) + 1;
    // «к повторению» — ровно те слова, которые попадут в очередь (и «знаю», когда пришёл срок; новые без попыток — нет)
    if (p.due <= now && !(p.status === 'new' && !p.reps)) counts.due++;
  }
  return counts;
}

/**
 * Очередь: сначала пора повторить (трудные, потом самые давние), затем новые — не больше newLimit.
 * Новые без попыток («новое» по отметке, но не начатое) повторением не считаются.
 */
export async function buildQueue(entryIds, { limit = 20, onlyDue = false, newLimit = Infinity } = {}) {
  const now = Date.now();
  const due = [], fresh = [];
  const pm = entryIds.length > 50 ? await profileProgress() : null;
  for (const id of entryIds) {
    const p = pm ? pm.get(id) : await getProgress(id);
    if (!p || (p.status === 'new' && !p.reps)) { if (!onlyDue) fresh.push(id); continue; }
    if (p.due <= now) due.push({ id, rank: p.status === 'hard' ? 0 : 1, due: p.due });
  }
  due.sort((a, b) => a.rank - b.rank || a.due - b.due);
  const out = due.slice(0, limit).map(s => s.id);
  const room = Math.max(0, Math.min(limit - out.length, newLimit));
  return out.concat(fresh.slice(0, room));
}

/* ---------- заметки и дневник ---------- */
export async function getNote(targetType, targetId) {
  const rows = await db.byIndex('notes', 'byTarget', IDBKeyRange.only([currentProfileId, targetType, targetId]));
  return rows[0] || null;
}
export async function saveNote(targetType, targetId, text) {
  const existing = await getNote(targetType, targetId);
  const clean = String(text ?? '');
  if (existing && !clean.trim()) {
    // стёртая заметка не пропадает: в той же транзакции кладётся в корзину («Данные» → «Корзина»), облако получает отметку «удалено»
    await db.tx(['notes', 'backups'], 'readwrite', t => {
      t.objectStore('backups').put({ id: uid('bk'), kind: 'trash', createdAt: new Date().toISOString(), what: 'notes', value: existing, note: 'заметка стёрта' });
      t.objectStore('notes').delete(existing.id);
    });
    emit('notes'); return null;
  }
  const note = existing
    ? { ...existing, text: clean, updatedAt: new Date().toISOString() }
    : { id: uid('nt'), profileId: currentProfileId, targetType, targetId, text: clean, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  if (!clean.trim() && !existing) return null;
  await db.put('notes', note);
  emit('notes');
  return note;
}
export const listNotes = () => db.byIndex('notes', 'byProfile', IDBKeyRange.only(currentProfileId));

export async function addJournal({ understood = '', notUnderstood = '', toReview = '', lessonId = null }) {
  const e = { id: uid('jr'), profileId: currentProfileId, ts: Date.now(), lessonId, understood, notUnderstood, toReview };
  await db.put('journal', e);
  emit('journal');
  return e;
}
export const listJournal = async () =>
  (await db.byIndex('journal', 'byProfileTs', IDBKeyRange.bound([currentProfileId, 0], [currentProfileId, Infinity]))).reverse();

/* ---------- сессии занятий ---------- */
let session = null;
export async function startSession(lessonId = null) {
  session = { id: uid('ss'), profileId: currentProfileId, lessonId, startedAt: Date.now(), endedAt: null, answered: 0, correct: 0 };
  await db.put('sessions', session);
  return session;
}
export async function endSession() {
  if (!session) return null;
  session.endedAt = Date.now();
  await db.put('sessions', session);
  const done = session; session = null;
  return done;
}
export const listSessions = async () =>
  (await db.byIndex('sessions', 'byProfileTs', IDBKeyRange.bound([currentProfileId, 0], [currentProfileId, Infinity]))).reverse();

export async function studyTimeMs() {
  const all = await listSessions();
  return all.reduce((s, x) => s + Math.max(0, (x.endedAt || x.startedAt) - x.startedAt), 0);
}

/* ---------- резервная копия ---------- */
export const BACKUP_FORMAT = 'hanzi-hsk123/backup@2';

export async function exportBackup() {
  const pid = currentProfileId;
  const profile = await db.get('profiles', pid);
  const pick = (rows) => rows.filter(r => r.profileId === pid);
  const payload = {
    profile: { name: profile?.name || 'Профиль', createdAt: profile?.createdAt },
    progress: pick(await db.getAll('progress')),
    attempts: pick(await db.getAll('attempts')),
    notes: pick(await db.getAll('notes')),
    journal: pick(await db.getAll('journal')),
    sessions: pick(await db.getAll('sessions')),
    // пользовательские слова и связи переносим вместе с прогрессом
    entries: (await db.getAll('entries')).filter(e => e.source?.startsWith('user') || e.source?.startsWith('import')),
    links: (await db.getAll('links')).filter(l => l.source?.startsWith('user') || l.source?.startsWith('import'))
  };
  const backup = {
    format: BACKUP_FORMAT,
    app: 'hanzi-hsk123',
    exportedAt: new Date().toISOString(),
    counts: Object.fromEntries(Object.entries(payload).map(([k, v]) => [k, Array.isArray(v) ? v.length : 1])),
    checksum: checksum(payload),
    payload
  };
  await db.metaSet('lastExportAt', backup.exportedAt);
  emit('backup');
  return backup;
}

export function verifyBackup(obj) {
  const problems = [];
  if (!obj || typeof obj !== 'object') problems.push('файл не является резервной копией');
  else {
    if (!String(obj.format || '').startsWith('hanzi-hsk123/backup@')) problems.push('чужой формат файла: ' + (obj.format || '—'));
    if (!obj.payload) problems.push('в файле нет данных');
    else if (obj.checksum && obj.checksum !== checksum(obj.payload)) problems.push('контрольная сумма не совпала — файл повреждён или изменён');
  }
  return problems;
}

/**
 * Импорт копии. По умолчанию — в НОВЫЙ профиль, текущий не трогается.
 * Повторный импорт того же файла не создаёт дублей: ключи записей естественные.
 */
export async function importBackup(obj, { into = 'new', name = null } = {}) {
  const problems = verifyBackup(obj);
  if (problems.length) throw new Error(problems.join('; '));
  const target = into === 'current'
    ? await db.get('profiles', currentProfileId)
    : await createProfile(name || `${obj.payload.profile?.name || 'Импорт'} (копия)`, { kind: into === 'test' ? 'test' : 'normal' });
  const pid = target.id;
  const p = obj.payload;
  const stats = { progress: 0, attempts: 0, notes: 0, journal: 0, sessions: 0, entries: 0, links: 0, duplicates: 0 };

  if (p.entries?.length) { await db.putMany('entries', p.entries); stats.entries = p.entries.length; }
  if (p.links?.length) { await db.putMany('links', p.links); stats.links = p.links.length; }

  for (const row of p.progress || []) {
    const rec = { ...row, profileId: pid, pk: `${pid}::${row.entryId}` };
    const prev = await db.get('progress', rec.pk);
    if (prev) { stats.duplicates++; if ((prev.updatedAt || '') >= (rec.updatedAt || '')) continue; }
    await db.put('progress', rec); stats.progress++;
  }
  for (const [store, key] of [['attempts', 'attempts'], ['notes', 'notes'], ['journal', 'journal'], ['sessions', 'sessions']]) {
    for (const row of p[key] || []) {
      // В другой профиль запись идёт под своим id с суффиксом профиля: иначе в том же
      // браузере она совпала бы с записью исходного профиля и тихо пропала бы как «дубль».
      // Повторный импорт того же файла в тот же профиль даёт тот же id — дубль распознаётся.
      const id = row.profileId === pid ? row.id : `${row.id}@${pid}`;
      const rec = { ...row, id, profileId: pid, ...(row.profileId !== pid ? { importedFrom: row.id } : {}) };
      if (await db.get(store, rec.id)) { stats.duplicates++; continue; }   // тот же id — тот же факт
      await db.put(store, rec); stats[key]++;
    }
  }
  emit('import');
  return { profile: target, stats };
}

export const lastExportAt = () => db.metaGet('lastExportAt', null);

/* ---------- перенос с другого адреса (Netlify → GitHub Pages) ---------- */
// Новый адрес не видит хранилище старого: данные переносятся файлом. Принимаются:
//   • «копия всех данных» (hanzi-hsk123/device-dump@1: «Восстановить прежний прогресс» → «Сохранить копию всех данных») — все профили;
//   • «копия профиля» (hanzi-hsk123/backup@2: «Данные» → «Скачать копию») — один профиль.
// Профили сохраняют свои id: повторный импорт того же или более нового файла сливается с тем же профилем, без дублей.
// Конфликты: отметка слова и заметка — остаётся более новая (updatedAt); попытки, дневник, занятия — по id (факт не дублируется).
// Перед записью в базе сохраняется копия текущих данных (backups, kind «pre-transfer»). Тестовые профили не переносятся.
const TRANSFER_STORES = ['profiles', 'progress', 'attempts', 'notes', 'journal', 'sessions'];

export function readTransfer(obj) {
  const fmt = String(obj?.format || '');
  const userRow = (r) => String(r?.source || '').startsWith('user') || String(r?.source || '').startsWith('import');
  if (fmt.startsWith('hanzi-hsk123/device-dump@')) {
    const idb = obj.indexedDB || {};
    const profiles = (idb.profiles || []).filter(p => p && p.id && p.kind !== 'test');
    const keep = new Set(profiles.map(p => p.id)), of = (s) => (idb[s] || []).filter(r => r && keep.has(r.profileId));
    return { kind: 'все данные', origin: obj.origin || '', exportedAt: obj.exportedAt || '', profiles,
      progress: of('progress'), attempts: of('attempts'), notes: of('notes'), journal: of('journal'), sessions: of('sessions'),
      entries: (idb.entries || []).filter(userRow), links: (idb.links || []).filter(userRow),
      backups: (idb.backups || []).filter(b => b && b.id && b.raw && b.kind !== 'pre-transfer'),
      current: (idb.meta || []).find(m => m.key === 'currentProfileId')?.value || null };
  }
  if (fmt.startsWith('hanzi-hsk123/backup@')) {
    const problems = verifyBackup(obj);
    if (problems.length) throw new Error(problems.join('; '));
    const p = obj.payload, rows = ['progress', 'attempts', 'notes', 'journal', 'sessions'].flatMap(k => p[k] || []);
    // в копии профиля нет его id — берём из записей, иначе постоянный id из имени и даты создания
    const id = rows.find(r => r.profileId)?.profileId || `pf_imp_${checksum([p.profile?.name, p.profile?.createdAt]).slice(0, 10)}`;
    const re = (arr) => (arr || []).map(r => ({ ...r, profileId: id }));
    return { kind: 'копия профиля', origin: '', exportedAt: obj.exportedAt || '',
      profiles: [{ id, name: p.profile?.name || 'Профиль', createdAt: p.profile?.createdAt || obj.exportedAt, kind: 'normal' }],
      progress: re(p.progress), attempts: re(p.attempts), notes: re(p.notes), journal: re(p.journal), sessions: re(p.sessions),
      entries: p.entries || [], links: p.links || [], backups: [], current: id };
  }
  throw new Error('это не файл hanzi-hsk123: ' + (fmt || 'формат не указан'));
}

/** Если открыт пустой профиль — открыть из перечисленных тот, где больше всего отметок. Непустой не переключается. */
export async function focusFilled(ids) {
  const cnt = (id) => db.countIndex('progress', 'byProfile', IDBKeyRange.only(id));
  if (currentProfileId && await cnt(currentProfileId)) return false;
  let best = null, max = 0;
  for (const id of new Set(ids.filter(Boolean))) { if (!(await db.get('profiles', id))) continue; const n = await cnt(id); if (n > max) { max = n; best = id; } }
  if (!best) return false;
  await setProfile(best); return true;
}

export async function importTransfer(obj) {
  const t = readTransfer(obj);
  const snapshot = {};
  for (const s of TRANSFER_STORES) snapshot[s] = await db.getAll(s);
  await db.put('backups', { id: uid('bk'), kind: 'pre-transfer', createdAt: new Date().toISOString(), raw: snapshot, note: 'данные этого адреса перед переносом' });

  const stats = { profiles: 0, merged: 0, progress: 0, attempts: 0, notes: 0, journal: 0, sessions: 0, entries: 0, links: 0, backups: 0, duplicates: 0, keptNewer: 0 };
  for (const p of t.profiles) {
    const prev = await db.get('profiles', p.id);
    if (prev) stats.merged++;
    else { await db.put('profiles', { id: p.id, name: String(p.name || 'Профиль').slice(0, 40), kind: 'normal', createdAt: p.createdAt || new Date().toISOString(), transferredAt: new Date().toISOString() }); stats.profiles++; }
  }
  for (const row of t.progress) {
    const rec = { ...row, pk: `${row.profileId}::${row.entryId}` };
    const prev = await db.get('progress', rec.pk);
    if (prev) {
      if ((prev.updatedAt || '') >= (rec.updatedAt || '')) { if (JSON.stringify(prev) === JSON.stringify(rec)) stats.duplicates++; else stats.keptNewer++; continue; }
    }
    await db.put('progress', rec); stats.progress++;
  }
  for (const row of t.notes) {
    const same = (await db.byIndex('notes', 'byTarget', IDBKeyRange.only([row.profileId, row.targetType, row.targetId])))[0] || await db.get('notes', row.id);
    if (same) {
      if ((same.updatedAt || '') >= (row.updatedAt || '')) { if (same.text === row.text) stats.duplicates++; else stats.keptNewer++; continue; }
      await db.put('notes', { ...row, id: same.id }); stats.notes++; continue;
    }
    await db.put('notes', row); stats.notes++;
  }
  for (const s of ['attempts', 'journal', 'sessions']) {
    for (const row of t[s]) {
      const prev = await db.get(s, row.id);
      if (prev && !(s === 'sessions' && !prev.endedAt && row.endedAt)) { stats.duplicates++; continue; }
      await db.put(s, row); stats[s]++;
    }
  }
  for (const [s, rows] of [['entries', t.entries], ['links', t.links], ['backups', t.backups]])
    for (const row of rows) { if (await db.get(s, row.id)) continue; await db.put(s, row); stats[s]++; }

  // если сейчас открыт пустой профиль — переключиться на тот, что был открыт на старом адресе
  const cur = currentProfileId ? (await db.byIndex('progress', 'byProfile', IDBKeyRange.only(currentProfileId), 1)).length : 1;
  const want = t.current && t.profiles.some(p => p.id === t.current) ? t.current : t.profiles[0]?.id;
  if (!cur && want) await setProfile(want);
  emit('import');
  return { kind: t.kind, from: t.origin, exportedAt: t.exportedAt, names: t.profiles.map(p => p.name), stats };
}
