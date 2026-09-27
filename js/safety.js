// Независимая резервная копия файлом и локальная защита от потерь.
//
// Файл «hanzi-hsk123/full-backup@1»: все профили (кроме тестовых), отметки, попытки, заметки, дневник, занятия,
// настройки обучения и незавершённые занятия, свои слова, по желанию — словарь учебника (файл остаётся у пользователя).
// В файле: версия формата, дата, версия приложения, количество записей и контрольная сумма.
// Ключ облака, очередь синхронизации и служебные копии в файл не входят.
//
// Восстановление: сначала проверка (формат, контрольная сумма, счётчики, вид записей) и показ содержимого;
// перед записью — копия текущих данных в базе; затем слияние без дублей: чего нет — добавляется, совпадающее
// пропускается, отличающееся НЕ заменяется (текущее остаётся, версия из файла сохраняется отдельно) —
// или весь файл восстанавливается в новые профили, ничего не трогая.
import * as db from './db.js';
import { checksum, uid } from './model.js';

export const FULL_FORMAT = 'hanzi-hsk123/full-backup@1';
const STORES = ['progress', 'attempts', 'notes', 'journal', 'sessions'];
const KEEP = { daily: 7, 'pre-restore': 10, 'pre-transfer': 10, 'pre-backup-restore': 10, 'restore-differences': 10 };
const TRASH_DAYS = 60;
const DAY = 86400000;

function stable(v) {
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).filter(k => v[k] !== undefined).sort().map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
  return JSON.stringify(v ?? null);
}
const sum = (data) => checksum(stable(data));
const strip = (r) => { const o = { ...r }; delete o.owner; return o; };
const userRow = (r) => /^(user|import)/.test(String(r?.source || ''));

/** Все учебные данные устройства (без тестовых профилей). */
export async function collect({ withBook = true } = {}) {
  const profiles = (await db.getAll('profiles')).filter(p => p.kind !== 'test').map(strip);
  const ids = new Set(profiles.map(p => p.id));
  const data = { profiles };
  for (const s of STORES) data[s] = (await db.getAll(s)).filter(r => ids.has(r.profileId));
  data.settings = (await db.getAll('meta')).filter(m => db.SYNC_META.test(m.key) && m.key !== 'bookWordsFile' && ids.has(m.key.split(':').slice(1).join(':')));
  data.entries = (await db.getAll('entries')).filter(userRow);
  data.links = (await db.getAll('links')).filter(userRow);
  if (withBook) { const b = await db.get('meta', 'bookWordsFile'); if (b?.value) data.bookWords = b.value; }
  return data;
}
const countsOf = (data) => Object.fromEntries(Object.entries(data).map(([k, v]) => [k, Array.isArray(v) ? v.length : (v ? 1 : 0)]));

/** Файл резервной копии (объект). Дата копии запоминается только когда файл реально сохранён — markSaved(). */
export async function makeFullBackup({ withBook = true, appVersion = '' } = {}) {
  const data = await collect({ withBook });
  return { format: FULL_FORMAT, app: 'hanzi-hsk123', appVersion, exportedAt: new Date().toISOString(), counts: countsOf(data), checksum: sum(data), data };
}
export const markSaved = (at = new Date().toISOString()) => db.metaSet('lastFullBackupAt', at);
export const lastSavedAt = () => db.metaGet('lastFullBackupAt', null);
/** Напоминание о копии: нужно, если есть что терять и копии нет или ей больше days дней. */
export async function reminder(days = 14) {
  const at = await lastSavedAt();
  const marks = await db.count('progress');
  if (marks < 10) return null;
  if (!at) return { never: true, days: null };
  const d = Math.floor((Date.now() - Date.parse(at)) / DAY);
  return d >= days ? { never: false, days: d } : null;
}

/** Проверка файла до импорта: формат, целостность, совместимость. Ничего не записывает. */
export function inspectFile(obj) {
  const problems = [];
  if (!obj || typeof obj !== 'object') return { ok: false, problems: ['файл не является резервной копией hanzi-hsk123'] };
  if (obj.format !== FULL_FORMAT) {
    const known = /^hanzi-hsk123\/(backup@2|device-dump@1)/.test(String(obj.format || ''));
    return { ok: false, problems: [known ? 'это файл другого вида (копия профиля или «все данные») — его принимает «Перенос с другого адреса»' : 'чужой формат: ' + (obj.format || 'не указан')] };
  }
  const d = obj.data;
  if (!d || typeof d !== 'object') problems.push('в файле нет данных');
  else {
    if (obj.checksum !== sum(d)) problems.push('контрольная сумма не совпала — файл повреждён или изменён');
    const real = countsOf(d);
    for (const [k, n] of Object.entries(obj.counts || {})) if ((real[k] || 0) !== n) problems.push(`число записей «${k}» не совпадает: в заголовке ${n}, в файле ${real[k] || 0}`);
    if (!Array.isArray(d.profiles)) problems.push('нет списка профилей');
    const ids = new Set((d.profiles || []).map(p => p?.id));
    const bad = (d.progress || []).filter(r => !r?.entryId || !ids.has(r.profileId)).length + STORES.slice(1).reduce((s, k) => s + (d[k] || []).filter(r => !r?.id || !ids.has(r.profileId)).length, 0);
    if (bad) problems.push(`${bad} записей без слова или профиля`);
  }
  const summary = d ? {
    exportedAt: obj.exportedAt, appVersion: obj.appVersion || '',
    profiles: (d.profiles || []).map(p => ({ id: p.id, name: p.name, marks: (d.progress || []).filter(r => r.profileId === p.id).length,
      known: (d.progress || []).filter(r => r.profileId === p.id && r.status === 'known').length,
      attempts: (d.attempts || []).filter(r => r.profileId === p.id).length, notes: (d.notes || []).filter(r => r.profileId === p.id).length })),
    counts: countsOf(d), bookWords: !!d.bookWords
  } : null;
  return { ok: !problems.length, problems, summary };
}

/** Снимок текущих данных в базе (для отката). */
export async function snapshot(kind, note = '') {
  const raw = await collect({ withBook: false });
  const b = { id: uid('bk'), kind, createdAt: new Date().toISOString(), note, counts: countsOf(raw), raw };
  await db.put('backups', b);
  await prune();
  return b;
}

/**
 * Восстановление из файла. mode 'merge' — в те же профили без замены отличающихся записей;
 * mode 'new' — каждый профиль файла становится новым профилем (ничего существующего не меняется).
 */
export async function restoreFull(obj, { mode = 'merge' } = {}) {
  const chk = inspectFile(obj);
  if (!chk.ok) throw new Error(chk.problems.join('; '));
  const d = obj.data;
  const pre = await snapshot('pre-backup-restore', 'данные перед восстановлением из файла от ' + (obj.exportedAt || '?'));
  const stats = { added: 0, same: 0, kept: 0, profiles: 0, settings: 0, entries: 0 };
  const differences = [];
  const idMap = new Map();
  for (const p of d.profiles) idMap.set(p.id, mode === 'new' ? uid('pf') : p.id);
  const pk = (r, pid) => `${pid}::${r.entryId}`;
  for (const p of d.profiles) {
    const id = idMap.get(p.id), prev = await db.get('profiles', id);
    if (!prev) { await db.put('profiles', { ...p, id, kind: 'normal', ...(mode === 'new' ? { name: `${p.name} (из копии ${new Date(obj.exportedAt).toLocaleDateString('ru-RU')})`.slice(0, 60), restoredFromFile: obj.exportedAt } : {}) }); stats.profiles++; }
  }
  for (const s of STORES) {
    for (const r of d[s] || []) {
      const pid = idMap.get(r.profileId);
      const rec = s === 'progress' ? { ...r, profileId: pid, pk: pk(r, pid) } : { ...r, profileId: pid, id: mode === 'new' ? `${r.id}@${pid}` : r.id };
      const key = s === 'progress' ? rec.pk : rec.id;
      const cur = await db.get(s, key);
      if (!cur) { await db.put(s, rec); stats.added++; continue; }
      if (stable(strip(cur)) === stable(strip(rec))) { stats.same++; continue; }
      stats.kept++; differences.push({ store: s, key, fromFile: rec });       // текущая запись остаётся; версия из файла — отдельно
    }
  }
  for (const m of d.settings || []) {
    const pid = idMap.get(m.key.split(':').slice(1).join(':')); if (!pid) continue;
    const key = `${m.key.split(':')[0]}:${pid}`;
    if ((await db.get('meta', key)) === undefined) { await db.put('meta', { key, value: m.value }); stats.settings++; }
  }
  for (const s of ['entries', 'links']) for (const r of d[s] || []) if (!(await db.get(s, r.id))) { await db.put(s, r); stats.entries++; }
  if (d.bookWords && !(await db.get('meta', 'bookWordsFile'))) stats.bookWords = true;   // словарь применяет приложение (нужно пересобрать уроки)
  if (differences.length) await db.put('backups', { id: uid('bk'), kind: 'restore-differences', createdAt: new Date().toISOString(), note: 'версии из файла, которые не заменили текущие', raw: differences });
  return { stats, preId: pre.id, differences: differences.length, profiles: [...idMap.values()] };
}

/** Вернуть данные из снимка базы (откат восстановления): только то, чего сейчас нет, — ничего не удаляет. */
export async function listSnapshots() {
  return (await db.getAll('backups')).filter(b => b.kind in KEEP || b.kind === 'trash').sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(b => ({ id: b.id, kind: b.kind, createdAt: b.createdAt, note: b.note || '', counts: b.counts || null, what: b.what || null }));
}

/** Ежедневный локальный снимок (раз в сутки при открытии) — страховка на случай ошибки без облака и файла. */
export async function dailySnapshot() {
  const all = (await db.getAll('backups')).filter(b => b.kind === 'daily');
  const last = all.map(b => Date.parse(b.createdAt)).sort().pop() || 0;
  if (Date.now() - last < 20 * 3600e3) return null;
  if (!(await db.count('progress')) && !(await db.count('notes'))) return null;
  return snapshot('daily', 'ежедневный снимок на устройстве');
}

/** Хранение: последние N снимков каждого вида, корзина — TRASH_DAYS дней. Копии старой версии не удаляются никогда. */
export async function prune() {
  const all = await db.getAll('backups');
  const drop = [];
  for (const [kind, n] of Object.entries(KEEP)) drop.push(...all.filter(b => b.kind === kind).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(n));
  drop.push(...all.filter(b => b.kind === 'trash' && Date.now() - Date.parse(b.createdAt) > TRASH_DAYS * DAY));
  if (drop.length) await db.tx('backups', 'readwrite', t => { for (const b of drop) t.objectStore('backups').delete(b.id); });
  return drop.length;
}

/* ---------- корзина ---------- */
export async function listTrash() {
  return (await db.getAll('backups')).filter(b => b.kind === 'trash').sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
/** Вернуть удалённое: запись восстанавливается, если её место не занято новой. */
export async function untrash(id) {
  const b = await db.get('backups', id); if (!b || b.kind !== 'trash') return false;
  const store = b.what, v = b.value;
  const key = v?.[store === 'progress' ? 'pk' : 'id'];
  if (store === 'notes') {
    const same = (await db.byIndex('notes', 'byTarget', IDBKeyRange.only([v.profileId, v.targetType, v.targetId])))[0];
    if (same && same.text?.trim()) return 'occupied';
  } else if (await db.get(store, key)) return 'occupied';
  await db.tx([store, 'backups'], 'readwrite', t => { t.objectStore(store).put({ ...v, updatedAt: new Date().toISOString() }); t.objectStore('backups').delete(id); });
  return true;
}
