// Восстановление прежнего прогресса прямо на устройстве.
//
// Ищет всё, что осталось от прежних версий, там, где открыт сайт (Safari и значок
// на экране «Домой» на iPhone хранят данные раздельно):
//   • localStorage: hsk_profiles_v2, hsk_d_<id>, hsk_d_<id>_backup_v<n> и прочие ключи;
//   • копии localStorage, сохранённые приложением в IndexedDB при прошлых переносах;
//   • профили IndexedDB (в том числе «… (из старой версии)», куда уходил прошлый перенос).
// Ничего не удаляет и никуда не отправляет. Перед записью — полная копия внутри базы,
// сама запись — одной транзакцией. Повторный запуск не создаёт дублей и не затирает
// более новые отметки; неоднозначные случаи откладываются на выбор пользователя.
import * as db from './db.js';
import { uid, checksum, makeEntry } from './model.js';
import { hskPacks, downloadPack, fetchJSON, adaptRecord } from './catalog.js';

const LIST = 'hsk_profiles_v2';
export const OWN_LS = /^hsk/;
const DATA = /^hsk_d_(.+)$/;
const BAK = /^(hsk_d_.+?)_backup_v(\d+)$/;
const DAY = 86400000;
const GAP = [3, 8, 20, 45, 90];
export const DUMP_FORMAT = 'hanzi-hsk123/device-dump@1';
export const MIGRATED_SUFFIX = '(из старой версии)';

/** Ступень прежней версии → отметка: ≥3 «знаю», 1–2 «учу», 0 «не знаю» (трудное). */
export const statusOfB = (b) => { const n = Number(b) || 0; return n >= 3 ? 'known' : n >= 1 ? 'learning' : 'hard'; };
const clampB = (b) => Math.max(0, Math.min(4, Number(b) || 0));
const iso = () => new Date().toISOString();

export function isStandalone() {
  try { return !!(navigator.standalone || matchMedia('(display-mode: standalone)').matches); } catch { return false; }
}
export function readLocal() {
  const out = {};
  // только ключи этого приложения (hsk…): на общем адресе (*.github.io) в localStorage лежат данные других сайтов
  try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (OWN_LS.test(k)) out[k] = localStorage.getItem(k); } } catch {}
  return out;
}

/* ---------- словарь: постоянный ключ k (点, 点#2) → слово новой версии ---------- */
let dictPromise = null;
export function loadDict() {
  if (dictPromise) return dictPromise;
  dictPromise = (async () => {
    const packs = await hskPacks();
    const byKey = new Map(), byId = new Map(), failed = [];
    for (const pack of packs) {
      let rows = null;
      for (const url of [pack.local, pack.remote].filter(Boolean)) { try { rows = await fetchJSON(url); break; } catch {} }
      if (!rows) { failed.push(pack.id); continue; }
      for (const rec of rows) {
        const row = adaptRecord(rec);
        if (!row.legacyKey) continue;
        const e = makeEntry(row, { source: `hsk:${pack.id}`, collectionId: 'hsk' });
        const info = { entryId: e.id, packId: pack.id, hanzi: e.hanzi, pinyin: e.pinyin, ru: e.ru, k: String(row.legacyKey) };
        byKey.set(info.k, info); byId.set(e.id, info);
      }
    }
    let mig = null;
    try { mig = await fetchJSON('data/migration-v1-to-v2.json'); } catch { failed.push('таблица v1→v2'); }
    return { byKey, byId, mig, packs, failed };
  })();
  dictPromise.then(d => { if (d.failed.length) dictPromise = null; }, () => { dictPromise = null; });  // без сети — попробовать позже
  return dictPromise;
}

/* ---------- источники ---------- */
function legacyFrom(raw) {
  const names = {};
  try {
    const list = JSON.parse(raw[LIST] || '[]');
    if (Array.isArray(list)) for (const p of list) if (p && p.id != null) names['hsk_d_' + p.id] = p;
  } catch {}
  const out = [];
  for (const [key, val] of Object.entries(raw)) {
    if (key === LIST || !DATA.test(key)) continue;
    const bm = key.match(BAK);
    const base = bm ? bm[1] : key;
    let s = null; try { s = JSON.parse(val); } catch {}
    const info = names[base] || {};
    out.push({
      key, base, isBackup: !!bm, parsed: s, parseError: s == null,
      name: info.name || base.replace(/^hsk_d_/, 'Профиль '),
      lastMs: bm ? Number(s?.last) || 0 : Number(s?.last) || Number(info.last) || 0,
      version: Number(s?.v) >= 2 ? 2 : 1, levels: Array.isArray(s?.levels) ? s.levels : null
    });
  }
  // запасная запись _backup_v1 снята в момент перехода на v2 — её дата не позже этого момента
  for (const o of out) if (o.isBackup && !o.lastMs) {
    const main = out.find(m => !m.isBackup && m.key === o.base);
    const at = Number(main?.parsed?.migratedAt) || 0;
    if (at) o.lastMs = at - 1;
  }
  return out;
}

function resolveLegacy(src, dict) {
  const prog = src.parsed && typeof src.parsed.prog === 'object' && src.parsed.prog ? src.parsed.prog : {};
  const items = [], unknown = [];
  for (const [rawKey, st] of Object.entries(prog)) {
    const k = src.version === 1 && /^\d+$/.test(rawKey) ? dict.mig?.[rawKey] : rawKey;
    const hit = k != null ? dict.byKey.get(String(k)) : null;
    if (!hit || !st || typeof st !== 'object') { unknown.push({ key: rawKey, state: st }); continue; }
    const b = clampB(st.b);
    items.push({ ...hit, b, t: Number(st.t) || 0, status: statusOfB(b) });
  }
  return { items, unknown, sig: checksum(prog) };
}

function countItems(items) {
  const c = { known: 0, learning: 0, hard: 0, total: items.length, byLevel: {} };
  for (const it of items) {
    c[it.status] = (c[it.status] || 0) + 1;
    const lv = it.packId || 'другое';
    const L = c.byLevel[lv] || (c.byLevel[lv] = { known: 0, learning: 0, hard: 0 });
    L[it.status] = (L[it.status] || 0) + 1;
  }
  return c;
}

/** Дата отметки: последний ответ, ручная отметка или дата источника. 0 — неизвестна. */
export function recDate(r) {
  if (!r) return 0;
  const d = Math.max(Number(r.lastAt) || 0, Number(r.markedAt) || 0, Number(r.sourceAt) || 0);
  if (d) return d;
  if (r.restoredFrom || r.migratedFrom) return 0;      // updatedAt у перенесённой записи — время переноса, не отметки
  return Date.parse(r.updatedAt || '') || 0;
}

/**
 * Полный поиск на этом устройстве. Ничего не пишет.
 * @param extraRaw необязательный { ключ: строка } из файла выгрузки старого адреса
 */
export async function scan({ extraRaw = null, extraLabel = 'файл' } = {}) {
  const dict = await loadDict();
  const local = readLocal();
  const sources = [], bySig = new Map();
  const add = (src) => {
    const same = bySig.get(src.sig);
    if (same) { same.alsoIn.push(src.where); return; }
    bySig.set(src.sig, src); sources.push(src);
  };
  const addLegacy = (raw, where, idp) => {
    for (const s of legacyFrom(raw)) {
      const { items, unknown, sig } = resolveLegacy(s, dict);
      if (!items.length && !unknown.length) continue;
      add({
        id: `${idp}:${s.key}`, kind: s.isBackup ? 'legacy-backup' : 'legacy', key: s.key, base: s.key.replace(BAK, '$1'),
        name: s.name, where, lastMs: s.lastMs, version: s.version, levels: s.levels,
        items, unknown, counts: countItems(items), sig: 'L' + sig, alsoIn: []
      });
    }
  };
  addLegacy(local, 'в этом браузере', 'ls');
  const copies = (await db.getAll('backups')).filter(b => b.raw && (b.kind === 'localStorage' || b.kind === 'pre-restore' || b.kind === 'legacy-file'));
  for (const bk of copies) addLegacy(bk.raw, `копия в приложении от ${new Date(bk.createdAt).toLocaleString('ru-RU')}`, `copy.${bk.id}`);
  if (extraRaw) addLegacy(extraRaw, extraLabel, 'file');

  const curId = await db.metaGet('currentProfileId');
  const legacyMap = await db.metaGet('legacyProfileMap', {});
  const migratedIds = new Set(Object.values(legacyMap));
  const profiles = [];
  for (const p of await db.getAll('profiles')) {
    const rows = (await db.byIndex('progress', 'byProfile', IDBKeyRange.only(p.id))).filter(r => r.status && r.status !== 'new');
    const items = rows.map(r => {
      const info = dict.byId.get(r.entryId) || {};
      return { entryId: r.entryId, packId: info.packId || (r.entryId.startsWith('h:') ? '' : 'учебник'), hanzi: info.hanzi || '', pinyin: info.pinyin || '', ru: info.ru || '', status: r.status, rec: r };
    });
    const attempts = await db.countIndex('attempts', 'byProfileTs', IDBKeyRange.bound([p.id, -Infinity], [p.id, Infinity]));
    const row = { id: p.id, name: p.name, kind: p.kind, current: p.id === curId, counts: countItems(items), attempts, migrated: migratedIds.has(p.id) || String(p.name).endsWith(MIGRATED_SUFFIX) };
    profiles.push(row);
    if (!row.current && items.length && p.kind !== 'test') {
      sources.push({ id: `pf:${p.id}`, kind: 'profile', profileId: p.id, name: p.name, where: 'профиль в приложении', lastMs: Math.max(0, ...rows.map(recDate)), items, unknown: [], counts: row.counts, attempts, migrated: row.migrated, alsoIn: [] });
    }
  }

  // по умолчанию отмечен один источник — самый полный профиль прежней версии (чужие профили
  // не сливаются молча); запасные записи и профили — только если основных данных нет вовсе
  const legacyMain = sources.filter(s => s.kind === 'legacy' && s.items.length).sort((a, b) => b.items.length - a.items.length)[0];
  const backupBest = sources.filter(s => s.kind === 'legacy-backup' && s.items.length).sort((a, b) => b.items.length - a.items.length)[0];
  const migBest = sources.filter(s => s.kind === 'profile' && s.migrated).sort((a, b) => b.items.length - a.items.length)[0];
  const pick = legacyMain || backupBest || migBest;
  for (const s of sources) s.defaultOn = s === pick;
  sources.sort((a, b) => (b.lastMs || 0) - (a.lastMs || 0));
  const otherKeys = Object.keys(local).filter(k => k !== LIST && !DATA.test(k)).map(k => ({ key: k, size: String(local[k] ?? '').length }));
  return {
    at: iso(), standalone: isStandalone(), dictFailed: dict.failed,
    localKeyCount: Object.keys(local).length, legacyKeys: Object.keys(local).filter(k => k === LIST || DATA.test(k)),
    copies: copies.length, sources, profiles, otherKeys
  };
}

/* ---------- копия всех данных до восстановления ---------- */
export async function deviceDump() {
  const idb = {};
  for (const s of ['profiles', 'progress', 'attempts', 'notes', 'journal', 'sessions', 'backups', 'meta']) idb[s] = await db.getAll(s);
  idb.entries = (await db.getAll('entries')).filter(e => !String(e.source || '').startsWith('hsk:'));
  idb.links = (await db.getAll('links')).filter(l => l.collectionId !== 'hsk');
  return {
    format: DUMP_FORMAT, app: 'hanzi-hsk123', origin: location.origin, standalone: isStandalone(),
    userAgent: navigator.userAgent, exportedAt: iso(), localStorage: readLocal(), indexedDB: idb
  };
}

/** Файл выгрузки: этой страницы (device-dump) или export-legacy.html → { ключ: строка } старой версии. */
export function rawFromFile(obj) {
  const ls = obj && typeof obj === 'object' ? obj.localStorage : null;
  if (!ls || typeof ls !== 'object') throw new Error('в файле нет данных localStorage');
  const out = {};
  for (const [k, v] of Object.entries(ls)) if (typeof v === 'string' && (k === LIST || DATA.test(k))) out[k] = v;
  if (!Object.keys(out).length) throw new Error('в файле нет ключей hsk_profiles_v2 / hsk_d_*');
  return out;
}

/* ---------- восстановление ---------- */
const conflictsKey = (pid) => 'recover:conflicts:' + pid;
const RESOLVED = 'recover:resolved';

function legacyRecord(pid, it, src, now) {
  const due = it.status === 'known' ? now + GAP[it.b] * DAY : now;
  return {
    pk: `${pid}::${it.entryId}`, profileId: pid, entryId: it.entryId,
    status: it.status, step: it.b, reps: 0, lapses: it.status === 'hard' ? 1 : 0, streak: 0,
    due, lastAt: null, sourceAt: src.lastMs || null,
    legacy: { b: it.b, t: it.t, key: it.k }, legacyKey: it.k,
    restoredFrom: src.id, restoredAt: iso(), updatedAt: iso()
  };
}

/**
 * @param scanRes результат scan()
 * @param {{sourceIds:string[], targetId:string}} opts targetId — профиль, куда вернуть отметки
 */
export async function restore(scanRes, { sourceIds, targetId }) {
  const target = await db.get('profiles', targetId);
  if (!target) throw new Error('профиль не найден');
  if (scanRes.dictFailed?.length) throw new Error('словарь загружен не полностью — подключитесь к сети и повторите поиск');
  const chosen = scanRes.sources.filter(s => sourceIds.includes(s.id) && s.profileId !== targetId);
  if (!chosen.length) throw new Error('не выбрано ни одного источника');

  // 1. копия внутри базы: всё старое хранилище и прогресс профиля-получателя до изменений
  const before = await db.byIndex('progress', 'byProfile', IDBKeyRange.only(targetId));
  const pre = { id: uid('bk'), kind: 'pre-restore', createdAt: iso(), targetProfileId: targetId, raw: readLocal(), progress: before };
  await db.put('backups', pre);

  // 2. расчёт: сначала читаем, записываем потом одной транзакцией
  const now = Date.now();
  const resolved = await db.metaGet(RESOLVED, {});
  const conflicts = { ...(await db.metaGet(conflictsKey(targetId), {})) };
  const pending = new Map(before.map(r => [r.pk, r]));      // текущее состояние с учётом уже решённого в этом проходе
  const writes = new Map();
  const extra = [];
  const rep = { added: 0, same: 0, keptNewer: 0, replacedOlder: 0, conflicts: 0, alreadyDecided: 0, attempts: 0, unknown: [], perSource: [], packs: new Set(), restored: [], kept: [] };

  const decide = (src, it, incoming, incomingDate) => {
    const key = incoming.pk;
    const cur = pending.get(key);
    const cid = `${key}|${src.id}|${incoming.status}|${incoming.legacy?.t ?? incomingDate}`;
    if (!cur || (cur.status === 'new' && !cur.reps && !cur.markedManually)) {
      pending.set(key, incoming); writes.set(key, incoming); rep.added++; rep.restored.push(key); rep.packs.add(it.packId); return 'added';
    }
    if (cur.status === incoming.status) { rep.same++; rep.packs.add(it.packId); return 'same'; }
    if (resolved[cid]) { rep.alreadyDecided++; return 'decided'; }
    const cd = recDate(cur);
    if (cd && incomingDate && cd > incomingDate) {
      rep.keptNewer++; rep.kept.push({ pk: key, hanzi: it.hanzi, current: cur.status, older: incoming.status, source: src.name });
      return 'kept';
    }
    if (cd && incomingDate && incomingDate > cd && src.kind === 'profile') {
      const rec = { ...incoming, previous: { status: cur.status, updatedAt: cur.updatedAt } };
      pending.set(key, rec); writes.set(key, rec); rep.replacedOlder++; rep.restored.push(key); rep.packs.add(it.packId); return 'replaced';
    }
    conflicts[cid] = {
      id: cid, pk: key, entryId: it.entryId, hanzi: it.hanzi, pinyin: it.pinyin, ru: it.ru, packId: it.packId,
      source: src.name, sourceWhere: src.where, current: { status: cur.status, date: cd || null }, incoming, incomingDate: incomingDate || null
    };
    rep.conflicts++; rep.packs.add(it.packId); return 'conflict';
  };

  for (const src of chosen) {                                 // от новых источников к старым
    const row = { id: src.id, name: src.name, where: src.where, total: src.items.length, unknown: src.unknown.length };
    for (const it of src.items) {
      if (src.kind === 'profile') {
        const incoming = { ...it.rec, pk: `${targetId}::${it.entryId}`, profileId: targetId, restoredFrom: src.id, restoredAt: iso(), sourceAt: recDate(it.rec) || null };
        decide(src, it, incoming, recDate(it.rec));
      } else {
        decide(src, it, legacyRecord(targetId, it, src, now), src.lastMs);
      }
    }
    for (const u of src.unknown) rep.unknown.push({ source: src.name, where: src.where, key: u.key, state: u.state });
    if (src.kind === 'profile') {                              // история ответов переносится вместе с профилем, без дублей
      for (const a of await db.byIndex('attempts', 'byProfileTs', IDBKeyRange.bound([src.profileId, -Infinity], [src.profileId, Infinity]))) {
        const id = `${a.id}@${targetId}`;
        if (await db.get('attempts', id)) continue;
        extra.push({ store: 'attempts', value: { ...a, id, profileId: targetId, importedFrom: a.id } }); rep.attempts++;
      }
    }
    rep.perSource.push(row);
  }

  const report = {
    id: uid('bk'), kind: 'recover-report', createdAt: iso(), targetProfileId: targetId, targetName: target.name, preRestoreId: pre.id,
    sources: rep.perSource, added: rep.added, same: rep.same, keptNewer: rep.keptNewer, replacedOlder: rep.replacedOlder,
    conflicts: Object.keys(conflicts).length, attempts: rep.attempts,
    kept: rep.kept, unknown: rep.unknown, otherLocalKeys: scanRes.otherKeys, restored: rep.restored
  };
  await db.putAll([
    ...[...writes.values()].map(value => ({ store: 'progress', value })),
    ...extra,
    { store: 'meta', value: { key: conflictsKey(targetId), value: conflicts } },
    { store: 'meta', value: { key: 'recover:lastReport:' + targetId, value: report.id } },
    { store: 'backups', value: report }
  ]);

  // 3. слова восстановленных отметок должны быть в базе, иначе на главной их не видно
  const packErrors = [];
  const packs = await hskPacks();
  for (const pack of packs) {
    if (rep.packs.has(pack.id) && pack.state?.status !== 'ready') {
      try { await downloadPack(pack); } catch (e) { packErrors.push(`${pack.id}: ${e.message || e}`); }
    }
  }
  return { ...report, conflictsNew: rep.conflicts, packs: [...rep.packs].filter(Boolean).sort(), packErrors };
}

export const listConflicts = async (pid) => Object.values(await db.metaGet(conflictsKey(pid), {}));

/** Выбор по спорным словам: 'incoming' — взять прежнюю отметку, 'current' — оставить нынешнюю. Обе версии остаются в отчёте. */
export async function resolveConflicts(pid, ids, choice) {
  const conflicts = { ...(await db.metaGet(conflictsKey(pid), {})) };
  const resolved = { ...(await db.metaGet(RESOLVED, {})) };
  const puts = [];
  const log = [];
  for (const id of ids) {
    const c = conflicts[id]; if (!c) continue;
    if (choice === 'incoming') {
      const cur = await db.get('progress', c.pk);
      puts.push({ store: 'progress', value: { ...c.incoming, previous: cur ? { status: cur.status, updatedAt: cur.updatedAt } : null, updatedAt: iso() } });
    }
    resolved[id] = choice; log.push({ ...c, choice, at: iso() });
    delete conflicts[id];
  }
  await db.putAll([
    ...puts,
    { store: 'meta', value: { key: conflictsKey(pid), value: conflicts } },
    { store: 'meta', value: { key: RESOLVED, value: resolved } },
    { store: 'backups', value: { id: uid('bk'), kind: 'recover-choices', createdAt: iso(), profileId: pid, choices: log } }
  ]);
  return log.length;
}

export async function lastReport(pid) {
  const id = await db.metaGet('recover:lastReport:' + pid);
  return id ? db.get('backups', id) : null;
}

/** Есть ли что предложить: старые ключи или отметки в другом профиле, когда в текущем пусто. */
export async function somethingToRecover(pid) {
  let legacy = false;
  try { for (let i = 0; i < localStorage.length; i++) if (DATA.test(localStorage.key(i))) { legacy = true; break; } } catch {}
  const mine = await db.countIndex('progress', 'byProfile', IDBKeyRange.only(pid));
  if (legacy) return { legacy, mine, other: 0 };
  let other = 0;
  for (const p of await db.getAll('profiles')) if (p.id !== pid && p.kind !== 'test') other += await db.countIndex('progress', 'byProfile', IDBKeyRange.only(p.id));
  return { legacy, mine, other };
}
