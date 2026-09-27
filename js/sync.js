// Облачное сохранение в ПРИВАТНЫЙ репозиторий GitHub пользователя (например, <логин>/hanzi-hsk123-data).
//
// Почему GitHub, а не Firebase: сервисы Google в материковом Китае недоступны без VPN, а сайт приложения уже на GitHub.
// Вход — ключ доступа GitHub (fine-grained token) только к одному репозиторию, право Contents: чтение и запись.
// Ключ хранится только на этом устройстве (хранилище sync), в копии, выгрузки и облако не попадает.
// Права проверяет сервер GitHub: без ключа к приватному репозиторию доступа нет (404), чужой ключ не видит его.
//
// Как устроено:
//   • всё сначала пишется на устройство; та же транзакция кладёт пометку в очередь (outbox, db.js);
//   • синхронизация: забрать изменения облака → применить к устройству (конфликты решаются без часов телефона,
//     проигравшая версия сохраняется) → отправить свои изменения одним коммитом → сервер подтверждает (ref обновлён
//     только если никто не успел раньше; иначе повтор с начала) → только после этого пометки снимаются;
//   • отсутствие записи никогда не означает удаления: удаление — только явная отметка «удалено» с прежним содержимым;
//   • история коммитов — версии: обычное удаление их не трогает, любую прежнюю версию можно открыть копией профиля.
//
// Файлы в репозитории (JSON: ключ записи → запись):
//   hanzi-sync.json                       — метка формата
//   p/<профиль>/profile.json              — профиль
//   p/<профиль>/settings.json             — настройки обучения, незавершённое занятие, черновик дневника
//   p/<профиль>/progress/<00..31>.json    — отметки слов (по хэшу слова, чтобы менять мелкие файлы)
//   p/<профиль>/notes.json                — заметки
//   p/<профиль>/attempts/<ГГГГ-ММ-ДД>.json, journal/<ГГГГ-ММ>.json, sessions/<ГГГГ-ММ>.json
//   shared/entries.json, shared/links.json — свои слова; private/book-words.json — словарь учебника (не публичный)
//   conflicts/<ГГГГ-ММ>.json              — версии, уступившие при конфликте
import * as db from './db.js';
import { checksum, uid } from './model.js';

export const SYNC_FORMAT = 'hanzi-hsk123/sync@1';
let API = 'https://api.github.com';
export const setApiBase = (url) => { API = String(url).replace(/\/$/, ''); };
// только для проверок на этом компьютере: подмена адреса API разрешена лишь на localhost
try { const o = localStorage.getItem('hanzi-sync-api'); if (o && /^(localhost|127\.0\.0\.1)$/.test(location.hostname)) setApiBase(o); } catch {}
export const DEFAULT_REPO_NAME = 'hanzi-hsk123-data';
const SHARDS = 32;
const MIN_GAP = 30000;                 // не чаще раза в 30 с без явной просьбы
const AUTO_DELAY = 12000;              // через 12 с после последней записи
const SIZE_WARN_KB = 500 * 1024, SIZE_STOP_KB = 900 * 1024;
const LOCAL_ONLY = ['owner'];
const TIMEOUT_MS = 25000;

/* ---------- мелочи ---------- */
function stable(v) {
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).filter(k => v[k] !== undefined).sort().map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
  return JSON.stringify(v ?? null);
}
const strip = (r) => { if (!r || typeof r !== 'object') return r; const o = { ...r }; for (const k of LOCAL_ONLY) delete o[k]; return o; };
export const recHash = (r) => checksum(stable(strip(r)));
const fileText = (map) => '{\n' + Object.keys(map).sort().map(k => JSON.stringify(k) + ':' + JSON.stringify(map[k])).join(',\n') + '\n}\n';
const utf8 = (s) => new TextEncoder().encode(s);
const hex = (buf) => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
export async function gitBlobSha(text) {
  const body = utf8(text), head = utf8(`blob ${body.length}\0`);
  const all = new Uint8Array(head.length + body.length); all.set(head); all.set(body, head.length);
  return hex(await crypto.subtle.digest('SHA-1', all));
}
const b64decode = (s) => { const bin = atob(String(s).replace(/\s/g, '')); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return new TextDecoder().decode(u); };
const b64encode = (s) => { const u = utf8(s); let bin = ''; for (let i = 0; i < u.length; i += 0x8000) bin += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(bin); };
const day = (ms) => new Date(Number(ms) || 0).toISOString().slice(0, 10);
const month = (ms) => new Date(Number(ms) || 0).toISOString().slice(0, 7);
const shard = (s) => String(parseInt(checksum(String(s)).slice(0, 6), 16) % SHARDS).padStart(2, '0');

/* ---------- куда кладётся запись и откуда берётся ---------- */
/** Запись устройства → { path, key } в репозитории, либо null (не синхронизируется). */
export function placeOf(store, key, v) {
  switch (store) {
    case 'profiles': return v?.kind === 'test' ? null : { path: `p/${key}/profile.json`, key: 'profile', pid: key };
    case 'progress': return v?.profileId ? { path: `p/${v.profileId}/progress/${shard(v.entryId)}.json`, key: v.entryId, pid: v.profileId } : null;
    case 'attempts': return v?.profileId ? { path: `p/${v.profileId}/attempts/${day(v.ts)}.json`, key, pid: v.profileId } : null;
    case 'notes': return v?.profileId ? { path: `p/${v.profileId}/notes.json`, key, pid: v.profileId } : null;
    case 'journal': return v?.profileId ? { path: `p/${v.profileId}/journal/${month(v.ts)}.json`, key, pid: v.profileId } : null;
    case 'sessions': return v?.profileId ? { path: `p/${v.profileId}/sessions/${month(v.startedAt)}.json`, key, pid: v.profileId } : null;
    case 'entries': return { path: 'shared/entries.json', key };
    case 'links': return { path: 'shared/links.json', key };
    case 'meta': {
      if (key === 'bookWordsFile') return { path: 'private/book-words.json', key: 'file' };
      const m = String(key).match(/^(home|newPerDay|drill|journalDraft):(.+)$/);
      return m ? { path: `p/${m[2]}/settings.json`, key: m[1], pid: m[2] } : null;
    }
  }
  return null;
}
/** Запись репозитория → { store, key } на устройстве. */
export function localOf(path, key) {
  let m;
  if ((m = path.match(/^p\/([^/]+)\/profile\.json$/))) return { store: 'profiles', key: m[1], pid: m[1] };
  if ((m = path.match(/^p\/([^/]+)\/progress\/\d+\.json$/))) return { store: 'progress', key: `${m[1]}::${key}`, pid: m[1] };
  if ((m = path.match(/^p\/([^/]+)\/(attempts|journal|sessions)\/[\d-]+\.json$/))) return { store: m[2], key, pid: m[1] };
  if ((m = path.match(/^p\/([^/]+)\/notes\.json$/))) return { store: 'notes', key, pid: m[1] };
  if ((m = path.match(/^p\/([^/]+)\/settings\.json$/))) return { store: 'meta', key: `${key}:${m[1]}`, pid: m[1] };
  if (path === 'shared/entries.json') return { store: 'entries', key };
  if (path === 'shared/links.json') return { store: 'links', key };
  if (path === 'private/book-words.json') return { store: 'meta', key: 'bookWordsFile' };
  return null;
}
// в хранилище meta запись — { key, value }; в облаке — само значение
const toRemote = (store, v) => store === 'meta' ? { value: v?.value ?? null } : strip(v);
const toLocal = (store, key, r) => store === 'meta' ? { key, value: r?.value ?? null } : r;
const ORDER = (p) => /profile\.json$/.test(p) ? 0 : /settings|private|shared/.test(p) ? 1 : /progress/.test(p) ? 2 : /notes/.test(p) ? 3 : /sessions|journal/.test(p) ? 4 : 5;

/* ---------- состояние и статус ---------- */
const listeners = new Set();
export const onStatus = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
let status = { cloud: 'off', text: '', at: null, pending: 0, running: false };
const setStatus = (patch) => { status = { ...status, ...patch }; for (const fn of listeners) { try { fn(status); } catch {} } };
export const getStatus = () => status;

const CONN = 'conn';
export const getConn = () => db.get('sync', CONN).catch(() => null);
const accountKey = (c) => `${c.login}/${c.repo}`;
const stateId = (c) => 'state:' + accountKey(c);
async function loadState(c) {
  return (await db.get('sync', stateId(c))) || { id: stateId(c), headSha: null, treeSha: null, files: {}, rec: {}, conflicts: [], lastOkAt: null };
}
const saveState = (st) => db.tx('sync', 'readwrite', t => { t.objectStore('sync').put(st); });
/** Какие пометки очереди относятся к этому облаку: профили этого аккаунта, свои слова и словарь; тестовые — никогда. */
async function relevance(c) {
  const key = c ? accountKey(c) : null;
  const prof = new Map((await db.getAll('profiles')).map(p => [p.id, p]));
  const excluded = new Set(c?.excluded || []);
  return (pid) => {
    if (!pid) return c ? 'send' : 'wait';
    const p = prof.get(pid);
    if (!p || p.kind === 'test') return 'drop';
    if (!c) return 'wait';
    if (p.owner === key) return 'send';
    if (!p.owner && !excluded.has(pid)) return 'claim';               // профиль заведён здесь после подключения — этого аккаунта
    return 'skip';                                                     // другого аккаунта или не выбран при подключении
  };
}
export async function pendingCount() {
  try {
    const c = await getConn(), rel = await relevance(c), box = await db.getAll('outbox');
    let n = 0;
    for (const o of box) {
      const cur = o.del ? o.prev : await db.get(o.store, o.key);
      const pl = cur === undefined ? null : placeOf(o.store, o.key, cur);
      if (pl && ['send', 'claim', 'wait'].includes(rel(pl.pid))) n++;
    }
    return n;
  } catch { return 0; }
}
export async function lastCloudAt() { const c = await getConn(); if (!c) return null; return (await loadState(c)).lastOkAt; }

class SyncError extends Error { constructor(code, msg, extra = {}) { super(msg); this.code = code; Object.assign(this, extra); } }
const ERR_TEXT = {
  offline: 'нет связи с GitHub — данные на устройстве, отправятся при появлении сети',
  auth: 'ключ GitHub недействителен или истёк — вставьте новый в «Данных»; данные на устройстве',
  forbidden: 'у ключа нет права записи в этот репозиторий',
  notfound: 'репозиторий не найден или ключ к нему не подходит',
  rate: 'лимит запросов GitHub исчерпан — повтор позже; данные на устройстве',
  quota: 'в облачном репозитории почти не осталось места — отправка остановлена, обучение и запись на устройство продолжаются',
  server: 'GitHub временно не отвечает — повтор позже'
};

/* ---------- запросы к GitHub ---------- */
let rate = { remaining: null, resetAt: 0 }, manual = false;
async function gh(c, method, path, body) {
  // автоматические попытки ждут сброса лимита, названного сервером; явное нажатие пробует сразу
  if (!manual && !c.checked && rate.remaining !== null && rate.remaining < 5 && Date.now() < rate.resetAt) throw new SyncError('rate', ERR_TEXT.rate, { retryAt: rate.resetAt });
  let res;
  try {
    res = await fetch(API + path, {
      method, cache: 'no-store',
      headers: { Authorization: 'Bearer ' + c.token, Accept: 'application/vnd.github+json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      // зависшее соединение (частая картина в плохой сети) не держит синхронизацию: через 25 с — сбой связи, данные ждут в очереди
      signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(TIMEOUT_MS) : undefined
    });
  } catch (e) { throw new SyncError('offline', e?.name === 'TimeoutError' ? 'GitHub не ответил за 25 с — данные на устройстве, повтор позже' : ERR_TEXT.offline); }
  const rem = res.headers.get('x-ratelimit-remaining'), reset = res.headers.get('x-ratelimit-reset');
  if (rem !== null) rate = { remaining: Number(rem), resetAt: Number(reset) * 1000 || Date.now() + 3600e3 };
  if (res.ok) return res.status === 204 ? null : res.json();
  let j = {}; try { j = await res.json(); } catch {}
  const msg = String(j.message || '');
  if (res.status === 401) throw new SyncError('auth', ERR_TEXT.auth);
  if (res.status === 403 || res.status === 429) {
    if (rem === '0' || /rate limit/i.test(msg)) throw new SyncError('rate', ERR_TEXT.rate, { retryAt: rate.resetAt });
    throw new SyncError('forbidden', ERR_TEXT.forbidden);
  }
  if (res.status === 404) throw new SyncError('notfound', ERR_TEXT.notfound);
  if (res.status === 409 && /empty/i.test(msg)) throw new SyncError('empty', 'репозиторий пуст');
  if (res.status === 409 || res.status === 422) throw new SyncError('race', 'облако изменилось во время отправки', { detail: msg });
  throw new SyncError('server', ERR_TEXT.server + ` (${res.status})`);
}
const repoPath = (c) => `/repos/${c.repo}`;

async function readBlob(c, sha, cache) {
  if (cache?.has(sha)) return cache.get(sha);
  const b = await gh(c, 'GET', `${repoPath(c)}/git/blobs/${sha}`);
  let obj = {}; try { obj = JSON.parse(b.encoding === 'base64' ? b64decode(b.content) : b.content); } catch { obj = {}; }
  cache?.set(sha, obj);
  return obj;
}
async function head(c) {
  try { const r = await gh(c, 'GET', `${repoPath(c)}/git/ref/heads/${c.branch || 'main'}`); return r.object.sha; }
  catch (e) { if (e.code === 'empty' || e.code === 'notfound' && c.checked) return null; throw e; }
}
async function tree(c, commitSha) {
  const cm = await gh(c, 'GET', `${repoPath(c)}/git/commits/${commitSha}`);
  const t = await gh(c, 'GET', `${repoPath(c)}/git/trees/${cm.tree.sha}?recursive=1`);
  const files = {};
  for (const e of t.tree || []) if (e.type === 'blob') files[e.path] = e.sha;
  return { treeSha: cm.tree.sha, files, truncated: !!t.truncated, date: cm.committer?.date || cm.author?.date };
}
async function initRepo(c) {
  const manifest = JSON.stringify({ format: SYNC_FORMAT, app: 'hanzi-hsk123', createdAt: new Date().toISOString() }, null, 1) + '\n';
  await gh(c, 'PUT', `${repoPath(c)}/contents/hanzi-sync.json`, { message: 'hanzi-hsk123: начало облачного хранилища', content: b64encode(manifest), branch: c.branch || 'main' });
}

/* ---------- подключение ---------- */
/** Проверка ключа и репозитория до подключения. Ничего не записывает. */
export async function inspect(token, repo) {
  const c = { token: String(token || '').trim(), repo: String(repo || '').trim(), checked: true };
  if (!c.token) throw new SyncError('auth', 'вставьте ключ доступа GitHub');
  const user = await gh(c, 'GET', '/user');
  if (!c.repo.includes('/')) c.repo = `${user.login}/${c.repo || DEFAULT_REPO_NAME}`;
  const r = await gh(c, 'GET', repoPath(c));
  if (!r.private) throw new SyncError('public', `репозиторий ${c.repo} публичный — учебные данные в него не отправляются. Сделайте его приватным`);
  if (r.permissions && !r.permissions.push) throw new SyncError('forbidden', ERR_TEXT.forbidden);
  c.branch = r.default_branch || 'main'; c.login = user.login;
  const out = { login: user.login, repo: r.full_name, branch: c.branch, sizeKB: r.size || 0, empty: false, foreign: false, profiles: [] };
  const h = await head(c);
  if (!h) { out.empty = true; return out; }
  const t = await tree(c, h);
  if (!t.files['hanzi-sync.json']) { out.foreign = Object.keys(t.files).length > 0; }
  for (const [p, sha] of Object.entries(t.files)) {
    const m = p.match(/^p\/([^/]+)\/profile\.json$/); if (!m) continue;
    const prof = (await readBlob(c, sha))?.profile || {};
    const count = (re) => Object.keys(t.files).filter(x => x.startsWith(`p/${m[1]}/`) && re.test(x)).length;
    out.profiles.push({ id: m[1], name: prof.name || 'Профиль', progressFiles: count(/\/progress\//), attemptDays: count(/\/attempts\//) });
  }
  return out;
}

/** Что будет отправлено при подключении: профили устройства с объёмом данных. */
export async function localSummary() {
  const [profiles, progress, attempts, notes, journal, sessions] = await Promise.all(['profiles', 'progress', 'attempts', 'notes', 'journal', 'sessions'].map(s => db.getAll(s)));
  const by = (rows, id) => rows.filter(r => r.profileId === id).length;
  return profiles.filter(p => p.kind !== 'test').map(p => ({ id: p.id, name: p.name, owner: p.owner || null,
    progress: by(progress, p.id), attempts: by(attempts, p.id), notes: by(notes, p.id), journal: by(journal, p.id), sessions: by(sessions, p.id) }));
}

/**
 * Подключить устройство к облаку. uploadIds — какие профили устройства отправить в этот аккаунт
 * (профили, уже привязанные к другому аккаунту, не отправляются никогда).
 */
export async function connect(token, repo, { uploadIds = [] } = {}) {
  const info = await inspect(token, repo);
  if (info.foreign) throw new SyncError('foreign', `в ${info.repo} уже есть посторонние файлы — укажите пустой приватный репозиторий`);
  const c = { id: CONN, token: String(token).trim(), repo: info.repo, login: info.login, branch: info.branch, connectedAt: new Date().toISOString() };
  const key = accountKey(c);
  const profiles = await db.getAll('profiles');
  c.excluded = profiles.filter(p => !uploadIds.includes(p.id)).map(p => p.id);    // не выбранные сейчас — не отправляются и позже
  const chosen = profiles.filter(p => uploadIds.includes(p.id) && p.kind !== 'test' && (!p.owner || p.owner === key));
  // выбранные профили помечаются владельцем и все их записи ставятся в очередь (первая отправка)
  await db.tx(['profiles', 'progress', 'attempts', 'notes', 'journal', 'sessions', 'meta', 'entries', 'links', 'sync'], 'readwrite', async (t) => {
    t.objectStore('sync').put(c);
    const ids = new Set(chosen.map(p => p.id));
    for (const p of chosen) t.objectStore('profiles').put({ ...p, owner: key });
    const all = (s) => new Promise(r => { const q = t.objectStore(s).getAll(); q.onsuccess = () => r(q.result); });
    for (const s of ['progress', 'attempts', 'notes', 'journal', 'sessions']) for (const row of await all(s)) if (ids.has(row.profileId)) t.objectStore(s).put(row);
    for (const m of await all('meta')) { const pl = placeOf('meta', m.key, m); if (pl && (!pl.pid || ids.has(pl.pid))) t.objectStore('meta').put(m); }
    for (const s of ['entries', 'links']) for (const row of await all(s)) if (/^(user|import)/.test(String(row.source || ''))) t.objectStore(s).put(row);
  });
  const st = await loadState(c); st.sizeKB = info.sizeKB; st.sizeCheckedAt = Date.now(); await saveState(st);
  setStatus({ cloud: 'idle', text: 'подключено: ' + c.repo });
  return syncNow('connect');
}

/** Отключить устройство: ключ удаляется только отсюда, данные на устройстве и в облаке остаются. */
export async function disconnect() {
  const c = await getConn(); if (!c) return;
  await db.tx('sync', 'readwrite', t => { t.objectStore('sync').delete(CONN); });
  setStatus({ cloud: 'off', text: 'облако не подключено', at: null });
}

/* ---------- синхронизация ---------- */
let running = null, lastRun = 0, timer = null, hooks = {};
export function syncNow(reason = 'manual') {
  if (running) return running.then(() => syncNow(reason));
  running = (async () => {
    let r;
    manual = reason !== 'auto';
    try { return (r = await doSync(reason)); }
    // пауза между запусками считается только от успешных: после сбоя (нет сети) повтор идёт сразу при появлении сети
    finally { running = null; if (r?.ok) lastRun = Date.now(); setStatus({ running: false, pending: await pendingCount() }); }
  })();
  return running;
}

async function doSync(reason) {
  const c = await getConn();
  const pending = await pendingCount();
  if (!c) { setStatus({ cloud: 'off', text: 'облако не подключено', pending }); return { ok: false, code: 'off' }; }
  if (typeof navigator !== 'undefined' && navigator.onLine === false) { setStatus({ cloud: 'error', code: 'offline', text: ERR_TEXT.offline, pending }); return { ok: false, code: 'offline' }; }
  setStatus({ running: true, cloud: 'syncing', text: 'синхронизация…', pending });
  const st = await loadState(c);
  try {
    if (st.sizeKB > SIZE_STOP_KB) throw new SyncError('quota', ERR_TEXT.quota);
    let report = null;
    for (let round = 0; round < 4; round++) {
      let h = await head(c);
      if (!h) { await initRepo(c); continue; }
      const cache = new Map();
      if (h !== st.headSha) {
        const t = await tree(c, h);
        if (!t.files['hanzi-sync.json']) throw new SyncError('foreign', 'в репозитории нет метки hanzi-hsk123 — отправка остановлена');
        await pull(c, st, t.files, cache);
        st.headSha = h; st.treeSha = t.treeSha; st.files = t.files;
        await saveState(st);
      }
      report = await push(c, st, cache);
      if (report === 'race') continue;
      break;
    }
    if (report === 'race') throw new SyncError('server', 'облако меняется другим устройством — повтор позже');
    if (Date.now() - (st.sizeCheckedAt || 0) > 86400000) {       // объём репозитория — раз в сутки
      try { const r = await gh(c, 'GET', repoPath(c)); st.sizeKB = r.size || 0; st.sizeCheckedAt = Date.now(); await saveState(st); } catch {}
    }
    st.lastError = null; st.lastOkAt = new Date().toISOString(); await saveState(st);
    const warn = st.sizeKB > SIZE_WARN_KB ? ` · облако занято на ${Math.round(st.sizeKB / 1024)} МБ` : '';
    setStatus({ cloud: 'ok', code: null, text: 'сохранено в облаке' + warn, at: st.lastOkAt, pending: await pendingCount() });
    return { ok: true, ...report };
  } catch (e) {
    const code = e.code || 'server';
    st.lastError = { code, text: e.message, at: new Date().toISOString() }; await saveState(st).catch(() => {});
    setStatus({ cloud: 'error', code, text: e.message || ERR_TEXT.server, pending: await pendingCount() });
    return { ok: false, code, text: e.message };
  }
}

/** Изменения облака → устройство. Незатронутые облаком записи не трогаются; пропавшие из облака — не удаляются. */
async function pull(c, st, files, cache) {
  const key = accountKey(c);
  const changed = Object.keys(files).filter(p => files[p] !== st.files[p] && localOf(p, 'x')).sort((a, b) => ORDER(a) - ORDER(b));
  for (const path of changed) {
    const remote = await readBlob(c, files[path], cache);
    const base = st.rec[path] || {};
    const apply = [], conflicts = [];
    const box = new Map((await db.getAll('outbox')).map(o => [o.k, o]));
    for (const [rk, rv] of Object.entries(remote)) {
      const h = recHash(rv);
      if (base[rk] === h) continue;                                   // облако эту запись не меняло
      const loc = localOf(path, rk); if (!loc) continue;
      const dirty = box.get(`${loc.store}|${loc.key}`);
      const cur = await db.get(loc.store, loc.key);
      const curRemote = cur === undefined ? undefined : toRemote(loc.store, cur);
      if (curRemote !== undefined && recHash(curRemote) === h) { apply.push({ loc, rk, h, same: true, dirty }); continue; }
      if (dirty && cur !== undefined) {                               // изменено и там, и здесь
        const win = resolve(loc.store, curRemote, rv);
        conflicts.push({ id: uid('cf'), at: new Date().toISOString(), store: loc.store, key: loc.key, path, rk, kept: win === rv ? 'облако' : 'устройство', local: curRemote, remote: rv });
        if (win === rv) apply.push({ loc, rk, h, rv, dirty }); else apply.push({ loc, rk, h, keepLocal: true });
        continue;
      }
      // удалено здесь, а в облаке запись правили: правка сильнее удаления — запись возвращается (удалённое лежит в корзине)
      if (dirty && dirty.del) { apply.push({ loc, rk, h, rv, dirty }); continue; }
      apply.push({ loc, rk, h, rv });
    }
    // одна транзакция на файл, без пометок в очередь (это не новые изменения устройства)
    await db.tx(['profiles', 'progress', 'attempts', 'notes', 'journal', 'sessions', 'meta', 'entries', 'links', 'backups', 'outbox'], 'readwrite', (t) => {
      for (const a of apply) {
        const { store, key: lk } = a.loc;
        if (a.same) { if (a.dirty) t.objectStore('outbox').delete(a.dirty.k); continue; }
        if (a.keepLocal) continue;
        if (a.rv && a.rv._deleted) {                                  // удаление с другого устройства: в корзину, не бесследно
          const g = t.objectStore(store).get(lk);
          g.onsuccess = () => { if (g.result !== undefined) { t.objectStore('backups').put({ id: uid('bk'), kind: 'trash', createdAt: new Date().toISOString(), what: store, value: g.result, note: 'удалено на другом устройстве' }); t.objectStore(store).delete(lk); } };
        } else {
          let rec = toLocal(store, lk, a.rv);
          if (store === 'profiles') rec = { ...rec, id: lk, owner: key };
          if (store === 'progress') rec = { ...rec, pk: lk };
          t.objectStore(store).put(rec);
        }
        if (a.dirty) t.objectStore('outbox').delete(a.dirty.k);
      }
    }, { noOutbox: true });
    if (conflicts.length) st.conflicts = [...conflicts, ...(st.conflicts || [])].slice(0, 300);
    st.rec[path] = { ...base };
    for (const [rk, rv] of Object.entries(remote)) st.rec[path][rk] = recHash(rv);
    if (path === 'private/book-words.json' && remote.file?.value && hooks.onBookWords) { try { await hooks.onBookWords(remote.file.value); } catch {} }
  }
  if (changed.length) hooks.onPulled?.(changed);
}

/** Конфликт: обе стороны изменили запись. Решение не по часам телефона; уступившая версия сохраняется. */
export function resolve(store, local, remote) {
  if (remote?._deleted && !local?._deleted) return local;             // правка сильнее удаления
  if (local?._deleted && !remote?._deleted) return remote;
  if (store === 'progress') {
    const score = (p) => [Number(p?.reps) || 0, Number(p?.lapses) || 0, Number(p?.step) || 0];
    const a = score(local), b = score(remote);
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i] ? local : remote;
    return remote;                                                    // равны — уже подтверждённая сервером
  }
  if (store === 'sessions') {
    if (!!local?.endedAt !== !!remote?.endedAt) return local?.endedAt ? local : remote;
    return (Number(local?.answered) || 0) >= (Number(remote?.answered) || 0) ? local : remote;
  }
  return local;                                                       // заметка, настройки, профиль: правка на этом устройстве
}

/** Изменения устройства → один коммит. Пометки снимаются только после подтверждения сервером. */
async function push(c, st, cache) {
  const key = accountKey(c);
  const box = await db.getAll('outbox');
  if (!box.length) return { pushed: 0 };
  const rel = await relevance(c);
  const groups = new Map(), done = [], claim = new Set();
  for (const o of box) {
    const cur = o.del ? o.prev : await db.get(o.store, o.key);
    if (cur === undefined) { done.push(o); continue; }                // запись исчезла без удаления — нечего слать
    const pl = placeOf(o.store, o.key, cur);
    if (!pl) { done.push(o); continue; }
    const r = rel(pl.pid);
    if (r === 'drop') { done.push(o); continue; }                      // тестовый профиль в облако не идёт
    if (r === 'skip' || r === 'wait') continue;                        // другой аккаунт / не выбран: остаётся в очереди, сюда не отправляется
    if (r === 'claim') claim.add(pl.pid);
    if (!groups.has(pl.path)) groups.set(pl.path, []);
    groups.get(pl.path).push({ o, pl, cur });
  }
  const entries = [], written = {};
  for (const [path, items] of groups) {
    const content = st.files[path] ? { ...(await readBlob(c, st.files[path], cache)) } : {};
    written[path] = {};
    for (const { o, pl, cur } of items) {
      if (o.del) {
        if (content[pl.key]?._deleted) continue;
        content[pl.key] = { _deleted: true, _at: new Date(o.at).toISOString(), _prev: content[pl.key] ?? toRemote(o.store, cur) };
      } else content[pl.key] = toRemote(o.store, cur);
      written[path][pl.key] = recHash(content[pl.key]);
    }
    const text = fileText(content);
    const sha = await gitBlobSha(text);
    if (sha !== st.files[path]) entries.push({ path, text, sha });
  }
  const sent = [...groups.values()].flat().map(x => x.o).concat(done);
  if (!entries.length) { await clearOutbox(sent); return { pushed: 0 }; }
  const t = await gh(c, 'POST', `${repoPath(c)}/git/trees`, { base_tree: st.treeSha, tree: entries.map(e => ({ path: e.path, mode: '100644', type: 'blob', content: e.text })) });
  const n = [...groups.values()].reduce((s, x) => s + x.length, 0);
  const cm = await gh(c, 'POST', `${repoPath(c)}/git/commits`, { message: `hanzi-hsk123: ${n} изм. (${entries.length} файл.)`, tree: t.sha, parents: [st.headSha] });
  try { await gh(c, 'PATCH', `${repoPath(c)}/git/refs/heads/${c.branch || 'main'}`, { sha: cm.sha, force: false }); }
  catch (e) { if (e.code === 'race') return 'race'; throw e; }
  // сервер подтвердил: запоминаем новое состояние облака и снимаем пометки
  if (claim.size) await db.tx('profiles', 'readwrite', (tt) => { const os = tt.objectStore('profiles'); for (const id of claim) { const g = os.get(id); g.onsuccess = () => { if (g.result && !g.result.owner) os.put({ ...g.result, owner: key }); }; } }, { noOutbox: true });
  st.headSha = cm.sha; st.treeSha = t.sha;
  for (const e of entries) st.files[e.path] = e.sha;
  for (const [path, recs] of Object.entries(written)) st.rec[path] = { ...(st.rec[path] || {}), ...recs };
  await saveState(st);
  await clearOutbox(sent);
  return { pushed: n, files: entries.length, commit: cm.sha };
}
async function clearOutbox(items) {
  // пометку снимаем, только если после чтения запись не менялась снова (иначе новая пометка останется)
  await db.tx('outbox', 'readwrite', (t) => {
    const os = t.objectStore('outbox');
    for (const o of items) { const g = os.get(o.k); g.onsuccess = () => { if (g.result && g.result.v === o.v) os.delete(o.k); }; }
  });
}

/* ---------- конфликты ---------- */
export async function listConflicts() { const c = await getConn(); if (!c) return []; return (await loadState(c)).conflicts || []; }
/** Взять уступившую версию: записывается на устройство как обычная правка и уйдёт в облако. */
export async function takeOther(id) {
  const c = await getConn(); const st = await loadState(c);
  const cf = (st.conflicts || []).find(x => x.id === id); if (!cf) return false;
  const v = cf.kept === 'облако' ? cf.local : cf.remote;
  if (v?._deleted) return false;
  let rec = toLocal(cf.store, cf.key, v);
  if (cf.store === 'progress') rec = { ...rec, pk: cf.key };
  if (cf.store === 'profiles') rec = { ...rec, id: cf.key, owner: accountKey(c) };
  await db.put(cf.store, rec);
  st.conflicts = st.conflicts.filter(x => x.id !== id); await saveState(st);
  schedule(1000);
  return true;
}

/* ---------- версии в облаке ---------- */
/** Прежние версии профиля (коммиты), новые сверху. */
export async function versions(pid, n = 30) {
  const c = await getConn(); if (!c) return [];
  const list = await gh(c, 'GET', `${repoPath(c)}/commits?path=${encodeURIComponent('p/' + pid)}&per_page=${n}&sha=${c.branch || 'main'}`);
  return list.map(x => ({ sha: x.sha, date: x.commit?.committer?.date || x.commit?.author?.date, message: x.commit?.message || '' }));
}
/** Содержимое профиля в указанной версии облака (только чтение). */
export async function snapshotAt(sha, pid) {
  const c = await getConn(); const t = await tree(c, sha);
  const out = { profile: null, progress: [], attempts: [], notes: [], journal: [], sessions: [], settings: {}, date: t.date, sha };
  for (const [path, bsha] of Object.entries(t.files)) {
    if (!path.startsWith(`p/${pid}/`)) continue;
    const obj = await readBlob(c, bsha);
    for (const [rk, rv] of Object.entries(obj)) {
      if (rv?._deleted) continue;
      const loc = localOf(path, rk); if (!loc) continue;
      if (loc.store === 'profiles') out.profile = rv;
      else if (loc.store === 'meta') out.settings[rk] = rv.value;
      else out[loc.store].push(rv);
    }
  }
  return out;
}
/** Восстановить версию как НОВЫЙ профиль: ничего существующего не заменяется. */
export async function restoreAsNewProfile(snap) {
  const c = await getConn();
  const pid = uid('pf');
  const name = `${snap.profile?.name || 'Профиль'} (облако, ${new Date(snap.date || Date.now()).toLocaleDateString('ru-RU')})`.slice(0, 60);
  const re = (r) => ({ ...r, profileId: pid });
  await db.tx(['profiles', 'progress', 'attempts', 'notes', 'journal', 'sessions', 'meta'], 'readwrite', (t) => {
    t.objectStore('profiles').put({ id: pid, name, kind: 'normal', createdAt: new Date().toISOString(), restoredFrom: snap.sha, ...(c ? { owner: accountKey(c) } : {}) });
    for (const p of snap.progress) t.objectStore('progress').put({ ...re(p), pk: `${pid}::${p.entryId}` });
    for (const s of ['attempts', 'notes', 'journal', 'sessions']) for (const r of snap[s]) t.objectStore(s).put({ ...re(r), id: `${r.id}@${pid}` });
    for (const [k, v] of Object.entries(snap.settings)) if (k !== 'drill') t.objectStore('meta').put({ key: `${k}:${pid}`, value: v });
  });
  schedule(1000);
  return { id: pid, name, counts: { progress: snap.progress.length, attempts: snap.attempts.length, notes: snap.notes.length, journal: snap.journal.length, sessions: snap.sessions.length } };
}

/* ---------- автоматический запуск ---------- */
export function schedule(ms = AUTO_DELAY) {
  clearTimeout(timer);
  const wait = Math.max(ms, MIN_GAP - (Date.now() - lastRun));
  timer = setTimeout(() => { syncNow('auto'); }, wait);
}
/** Подключить к приложению: после записей, при открытии, возвращении из фона и появлении сети. Фоновой отправки при закрытом приложении нет. */
export async function start(h = {}) {
  hooks = h;
  db.onSave(({ state }) => { if (state === 'saved' && !status.running) pendingCount().then(n => { setStatus({ pending: n }); if (n && status.cloud !== 'off') schedule(AUTO_DELAY); }); });
  if (typeof addEventListener === 'function') addEventListener('online', () => schedule(500));
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') schedule(1000); });
  const c = await getConn();
  if (c) { const st = await loadState(c); setStatus({ cloud: st.lastError ? 'error' : 'idle', code: st.lastError?.code, text: st.lastError?.text || '', at: st.lastOkAt, pending: await pendingCount() }); schedule(1500); }
  else setStatus({ cloud: 'off', text: 'облако не подключено', pending: await pendingCount() });
}
