// Перенос прогресса из localStorage опубликованной версии в IndexedDB.
//
// Формат прежней версии (проверен по reference/published-index.html):
//   hsk_profiles_v2        = [{ id, name, last }]
//   hsk_d_<id>             = { v, prog: { <ключ>: { b, t } }, tick, levels, last, ... }
//   hsk_d_<id>_backup_v1   = копия состояния до перехода v1→v2 (делала сама старая версия)
// В v1 ключ prog — порядковый номер строки словаря («32»), в v2 — постоянный ключ k
// («点», «点#2»). b — ступень 0…4 (0 «не знаю», 1–2 «учу», ≥3 «знаю»), t — такт.
//
// Правила: сначала резервная копия, потом перенос; localStorage не меняется никогда;
// повторный запуск не создаёт ни профилей, ни записей заново.
import * as db from './db.js';
import { uid, checksum, makeEntry } from './model.js';
import { createProfile } from './store.js';
import { hskPacks, downloadPack, fetchJSON, adaptRecord } from './catalog.js';

const LEGACY_LIST = 'hsk_profiles_v2';
const LEGACY_DATA = /^hsk_d_(.+)$/;
const LEGACY_BACKUP = /_backup_v\d+$/;
const MIG_URL = 'data/migration-v1-to-v2.json';
const DAY = 86400000;
const GAP = [3, 8, 20, 45, 90];

export const LEGACY_DUMP_FORMAT = 'hanzi-hsk123/legacy-localstorage@1';

const DEVICE_DUMP = /^hanzi-hsk123\/device-dump@/;

/** Старые ключи из «копии всех данных» (device-dump@1) → { ключ: строка } или null, если их там нет.
 *  Нужны, когда на прежнем адресе прогресс так и остался в localStorage и в базу не переносился. */
export function legacyFromDump(obj) {
  if (!DEVICE_DUMP.test(String(obj?.format || ''))) return null;
  const ls = obj.localStorage, out = {};
  if (!ls || typeof ls !== 'object') return null;
  for (const [k, v] of Object.entries(ls)) if (typeof v === 'string' && (k === LEGACY_LIST || LEGACY_DATA.test(k))) out[k] = v;
  return hasLegacy(out) ? out : null;
}

/** Какие профили базы в том же файле уже получили отметки из старых ключей (перенос на прежнем адресе):
 *  { hsk_d_<id>: profileId } — чтобы второй раз не создавать профиль и не дублировать отметки. */
export function legacyProfilesInDump(obj) {
  const map = {};
  for (const r of obj?.indexedDB?.progress || []) if (r?.migratedFrom && r.profileId && !map[r.migratedFrom]) map[r.migratedFrom] = r.profileId;
  const meta = (obj?.indexedDB?.meta || []).find(m => m?.key === 'legacyProfileMap')?.value;
  if (meta && typeof meta === 'object') for (const [k, v] of Object.entries(meta)) if (!map[k] && typeof v === 'string') map[k] = v;
  return map;
}

/** Файл выгрузки со старого сайта (export-legacy.html или «копия всех данных») → { ключ: строка }. */
export function parseLegacyDump(obj) {
  if (!obj || typeof obj !== 'object') throw new Error('файл не похож на выгрузку старой версии');
  if (DEVICE_DUMP.test(String(obj.format || ''))) {
    const src = legacyFromDump(obj);
    if (!src) throw new Error('в файле нет ключей hsk_profiles_v2 / hsk_d_*');
    return src;
  }
  if (obj.format && obj.format !== LEGACY_DUMP_FORMAT) throw new Error('чужой формат: ' + obj.format);
  const ls = obj.localStorage;
  if (!ls || typeof ls !== 'object' || !(LEGACY_LIST in ls || Object.keys(ls).some(k => LEGACY_DATA.test(k))))
    throw new Error('в файле нет ключей hsk_profiles_v2 / hsk_d_*');
  const out = {};
  for (const [k, v] of Object.entries(ls)) if (typeof v === 'string') out[k] = v;
  return out;
}

function entriesOf(source) {
  if (source) return Object.entries(source);
  if (typeof localStorage === 'undefined') return [];
  const rows = [];
  for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); rows.push([k, localStorage.getItem(k)]); }
  return rows;
}

/** @param source необязательный объект { ключ: строка } из файла выгрузки; иначе — localStorage этого сайта */
export function readLegacy(source = null) {
  const out = { profiles: null, data: {}, oldBackups: {}, raw: {} };
  for (const [key, value] of entriesOf(source)) {
    if (key === LEGACY_LIST) {
      out.raw[key] = value;
      try { out.profiles = JSON.parse(value); } catch { out.profiles = null; }
    } else if (LEGACY_DATA.test(key)) {
      out.raw[key] = value;
      let parsed = null; try { parsed = JSON.parse(value); } catch {}
      if (LEGACY_BACKUP.test(key)) out.oldBackups[key] = parsed;
      else out.data[key] = parsed;
    }
  }
  return out;
}

export const hasLegacy = (source = null) => {
  const l = readLegacy(source);
  return (Array.isArray(l.profiles) && l.profiles.length > 0) || Object.keys(l.data).length > 0;
};

/**
 * Полная копия старых ключей в IndexedDB — до любого переноса.
 * Если такая же копия (та же контрольная сумма) уже есть, новая не создаётся.
 */
export async function backupLegacy(legacy = readLegacy()) {
  const sum = checksum(legacy.raw);
  const existing = (await db.getAll('backups')).find(b => b.kind === 'localStorage' && b.checksum === sum);
  if (existing) return { backup: existing, reused: true };
  const backup = { id: uid('bk'), createdAt: new Date().toISOString(), kind: 'localStorage', from: legacy.from || 'localStorage', checksum: sum, keys: Object.keys(legacy.raw), raw: legacy.raw };
  await db.put('backups', backup);
  await db.metaSet('legacyBackupId', backup.id);
  return { backup, reused: false };
}

/** Словарь из файлов приложения: ключ k → { entryId, packId }. Скачивать наборы заранее не нужно. */
async function loadKeyIndex() {
  const packs = await hskPacks();
  const byKey = new Map();
  for (const pack of packs) {
    let rows = null;
    for (const url of [pack.local, pack.remote].filter(Boolean)) {
      try { rows = await fetchJSON(url); break; } catch {}
    }
    if (!rows) continue;
    for (const rec of rows) {
      const row = adaptRecord(rec);
      if (!row.legacyKey) continue;
      const e = makeEntry(row, { source: `hsk:${pack.id}`, collectionId: 'hsk' });
      byKey.set(String(row.legacyKey), { entryId: e.id, packId: pack.id, hanzi: e.hanzi });
    }
  }
  return { byKey, packs };
}

/** Состояние старой версии → запись прогресса новой. */
export function convertState(st, { lastMs = 0, now = Date.now() } = {}) {
  const b = Math.max(0, Math.min(4, Number(st?.b ?? st?.step ?? 0) || 0));
  const status = b >= 3 ? 'known' : b >= 1 ? 'learning' : 'hard';
  return {
    status, step: b, reps: 0, lapses: status === 'hard' ? 1 : 0, streak: 0,
    due: status === 'known' ? now + GAP[b] * DAY : now,
    lastAt: lastMs || null,
    legacy: { b: st?.b ?? null, t: st?.t ?? null }
  };
}

/**
 * @param {{dryRun?:boolean}} opts
 * @returns отчёт по профилям: найдено, перенесено, уже было, не опознано
 */
export async function migrate({ dryRun = false, source = null, profileMap = null } = {}) {
  const legacy = readLegacy(source);
  if (source) legacy.from = 'file';
  const report = { profiles: [], matched: 0, written: 0, already: 0, unmatched: 0, unmatchedSamples: [], backupId: null, backupReused: false, dryRun };
  if (!hasLegacy(source)) { report.note = 'старых данных не найдено'; return report; }

  if (!dryRun) {
    const { backup, reused } = await backupLegacy(legacy);
    report.backupId = backup.id; report.backupReused = reused;
  }

  const { byKey, packs } = await loadKeyIndex();
  let mig = null;
  try { mig = await fetchJSON(MIG_URL); } catch {}

  const listed = Array.isArray(legacy.profiles) ? legacy.profiles : [];
  const sources = listed.length
    ? listed.map(p => ({ name: p.name || 'Профиль', key: `hsk_d_${p.id}` }))
    : Object.keys(legacy.data).map(k => ({ name: k.replace(/^hsk_d_/, 'Профиль '), key: k }));

  // какой новый профиль соответствует какому старому — чтобы повторный запуск не плодил профили
  // profileMap — соответствие из файла переноса (профиль уже перенесён вместе с базой); здешнее соответствие важнее
  const map = { ...(profileMap || {}), ...(await db.metaGet('legacyProfileMap', {})) };
  const needPacks = new Set();
  const now = Date.now();

  for (const src of sources) {
    const s = legacy.data[src.key];
    const prog = s && typeof s === 'object' && s.prog && typeof s.prog === 'object' ? s.prog : {};
    const isV1 = !(Number(s?.v) >= 2);
    const row = { name: src.name, key: src.key, version: isV1 ? 1 : 2, found: Object.keys(prog).length, moved: 0, already: 0, skipped: 0, profileId: map[src.key] || null };
    const resolved = [];
    for (const [rawKey, st] of Object.entries(prog)) {
      const k = isV1 && /^\d+$/.test(rawKey) ? (mig ? mig[rawKey] : undefined) : rawKey;
      const hit = k != null ? byKey.get(String(k)) : null;
      if (!hit) {
        row.skipped++; report.unmatched++;
        if (report.unmatchedSamples.length < 10) report.unmatchedSamples.push(rawKey);
        continue;
      }
      resolved.push({ hit, st, k });
    }
    report.matched += resolved.length;

    if (dryRun || !resolved.length) { row.moved = dryRun ? resolved.length : 0; report.profiles.push(row); continue; }

    let pid = map[src.key];
    if (!pid || !(await db.get('profiles', pid))) {
      pid = (await createProfile(`${src.name} (из старой версии)`)).id;
      map[src.key] = pid;
      await db.metaSet('legacyProfileMap', map);
    }
    row.profileId = pid;

    for (const { hit, st, k } of resolved) {
      const pk = `${pid}::${hit.entryId}`;
      if (await db.get('progress', pk)) { row.already++; report.already++; continue; }   // не затираем то, что уже есть
      await db.put('progress', {
        pk, profileId: pid, entryId: hit.entryId,
        ...convertState(st, { lastMs: Number(s.last) || 0, now }),
        legacyKey: k, migratedFrom: src.key, updatedAt: new Date().toISOString()
      });
      needPacks.add(hit.packId);
      row.moved++; report.written++;
    }
    report.profiles.push(row);
  }

  // слова, к которым привязан прогресс, должны быть в базе — докачиваем их наборы из локальных файлов
  if (!dryRun) {
    for (const pack of packs) {
      if (needPacks.has(pack.id) && pack.state?.status !== 'ready') {
        try { await downloadPack(pack); } catch (e) { report.packErrors = (report.packErrors || []).concat(`${pack.id}: ${e.message || e}`); }
      }
    }
    await db.metaSet('legacyMigratedAt', new Date().toISOString());
  }
  return report;
}

export const migratedAt = () => db.metaGet('legacyMigratedAt', null);
export const legacyBackup = async () => { const id = await db.metaGet('legacyBackupId'); return id ? db.get('backups', id) : null; };
