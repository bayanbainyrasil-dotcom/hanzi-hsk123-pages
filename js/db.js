// IndexedDB: единственное надёжное хранилище учебного опыта.
// Всё пишется сразу и локально, работает без сети.
export const DB_NAME = 'hanzi_hsk123';
export const DB_VERSION = 2;          // 2: примеры употребления (examples)

const STORES = {
  meta:        { keyPath: 'key' },
  profiles:    { keyPath: 'id' },
  collections: { keyPath: 'id' },
  lessons:     { keyPath: 'id', indexes: { byCollection: 'collectionId' } },
  entries:     { keyPath: 'id', indexes: { byHanzi: 'hanzi', bySource: 'source' } },
  links:       { keyPath: 'id', indexes: { byLesson: 'lessonId', byEntry: 'entryId', byCollection: 'collectionId' } },
  progress:    { keyPath: 'pk', indexes: { byProfile: 'profileId', byDue: ['profileId', 'due'], byStatus: ['profileId', 'status'], byEntry: 'entryId' } },
  attempts:    { keyPath: 'id', indexes: { byProfileTs: ['profileId', 'ts'], byEntry: ['profileId', 'entryId'] } },
  notes:       { keyPath: 'id', indexes: { byTarget: ['profileId', 'targetType', 'targetId'], byProfile: 'profileId' } },
  journal:     { keyPath: 'id', indexes: { byProfileTs: ['profileId', 'ts'] } },
  sessions:    { keyPath: 'id', indexes: { byProfileTs: ['profileId', 'startedAt'] } },
  backups:     { keyPath: 'id' },
  assets:      { keyPath: 'id' },     // скачанные наборы для офлайна (учёт, не сами файлы)
  examples:    { keyPath: 'id', indexes: { byTid: 'tid', byPack: 'pack' } }   // примеры употребления: скачиваются с набором
};

let dbPromise = null;

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (ev) => {
      const db = req.result;
      for (const [name, def] of Object.entries(STORES)) {
        const store = db.objectStoreNames.contains(name)
          ? req.transaction.objectStore(name)
          : db.createObjectStore(name, { keyPath: def.keyPath });
        for (const [idx, path] of Object.entries(def.indexes || {})) {
          if (!store.indexNames.contains(idx)) store.createIndex(idx, path);
        }
      }
      if (ev.oldVersion === 0) {
        req.transaction.objectStore('meta').put({ key: 'createdAt', value: new Date().toISOString() });
      }
      req.transaction.objectStore('meta').put({ key: 'schemaVersion', value: DB_VERSION });
    };
    req.onsuccess = () => {
      req.result.onversionchange = () => req.result.close();
      resolve(req.result);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('База занята другой вкладкой приложения'));
  });
  return dbPromise;
}

/* ---------- состояние записи ----------
   Каждая пишущая транзакция сообщает: «saving» при старте и «saved» только после
   события complete — то есть когда IndexedDB подтвердила запись на устройстве.
   Ошибка (включая нехватку места) приходит как «error» с понятным текстом. */
const saveListeners = new Set();
let pendingWrites = 0;
export const onSave = (fn) => { saveListeners.add(fn); return () => saveListeners.delete(fn); };
const emitSave = (state, info = {}) => { for (const fn of saveListeners) { try { fn({ state, pending: pendingWrites, ...info }); } catch {} } };

/** Понятное сообщение об ошибке хранилища. */
export function storageErrorText(err) {
  const name = err?.name || '';
  const msg = String(err?.message || err || '');
  if (name === 'QuotaExceededError' || /quota|space|storage.*full/i.test(msg))
    return 'на устройстве закончилось место для данных приложения — запись не сохранена';
  if (name === 'InvalidStateError' || name === 'UnknownError' || /closed|backing store|internal error/i.test(msg))
    return 'хранилище браузера недоступно (приватный режим или сбой) — запись не сохранена';
  if (/blocked|занята/i.test(msg))
    return 'база занята другой вкладкой приложения — закройте её и повторите';
  return 'запись не сохранена: ' + (msg || name || 'неизвестная ошибка');
}

function run(store, mode, fn) {
  const writing = mode === 'readwrite';
  if (writing) { pendingWrites++; emitSave('saving'); }
  let settled = false;
  const done = (ok, err) => {
    if (!writing || settled) return;
    settled = true;
    pendingWrites = Math.max(0, pendingWrites - 1);
    if (ok) { if (!pendingWrites) emitSave('saved', { at: Date.now() }); }
    else emitSave('error', { error: err, text: storageErrorText(err) });
  };
  return openDB().then(db => new Promise((resolve, reject) => {
    let tx;
    try { tx = db.transaction(Array.isArray(store) ? store : [store], mode, writing ? { durability: 'strict' } : undefined); }
    catch (e) { done(false, e); reject(e); return; }
    let out, fnErr = null;
    tx.oncomplete = () => { done(true); resolve(out); };
    tx.onabort = () => { const e = fnErr || tx.error || new Error('Транзакция прервана'); done(false, e); reject(e); };
    const fail = (e) => { fnErr = e; try { tx.abort(); } catch { done(false, e); reject(e); } };
    let r;
    try { r = fn(tx); } catch (e) { fail(e); return; }            // синхронная ошибка тоже отменяет транзакцию
    Promise.resolve(r).then(v => { out = v; }, fail);
  }), (e) => { done(false, e); throw e; });
}

const asPromise = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });

export const get = (store, key) => run(store, 'readonly', tx => asPromise(tx.objectStore(store).get(key)));
export const getAll = (store) => run(store, 'readonly', tx => asPromise(tx.objectStore(store).getAll()));
export const put = (store, value) => run(store, 'readwrite', tx => asPromise(tx.objectStore(store).put(value)));
export const del = (store, key) => run(store, 'readwrite', tx => asPromise(tx.objectStore(store).delete(key)));
export const count = (store) => run(store, 'readonly', tx => asPromise(tx.objectStore(store).count()));

export const putMany = (store, values) => run(store, 'readwrite', tx => {
  const os = tx.objectStore(store);
  for (const v of values) os.put(v);
  return values.length;
});

export const byIndex = (store, index, query, limit = Infinity) =>
  run(store, 'readonly', tx => new Promise((res, rej) => {
    const out = [];
    const req = tx.objectStore(store).index(index).openCursor(query ?? null);
    req.onsuccess = () => {
      const c = req.result;
      if (!c || out.length >= limit) return res(out);
      out.push(c.value); c.continue();
    };
    req.onerror = () => rej(req.error);
  }));

export const countIndex = (store, index, query) =>
  run(store, 'readonly', tx => asPromise(tx.objectStore(store).index(index).count(query ?? null)));

export const clearStores = (names) => run(names, 'readwrite', tx => { for (const n of names) tx.objectStore(n).clear(); return true; });

export const deleteByIndex = (store, index, query) =>
  run(store, 'readwrite', tx => new Promise((res, rej) => {
    let n = 0;
    const req = tx.objectStore(store).index(index).openCursor(query ?? null);
    req.onsuccess = () => { const c = req.result; if (!c) return res(n); c.delete(); n++; c.continue(); };
    req.onerror = () => rej(req.error);
  }));

export const metaGet = async (key, fallback = null) => (await get('meta', key))?.value ?? fallback;
export const metaSet = (key, value) => put('meta', { key, value });

export const tx = run;

/** Несколько записей в разные хранилища одной транзакцией: либо все, либо ни одной. */
export const putAll = (items) => run([...new Set(items.map(i => i.store))], 'readwrite', t => {
  for (const { store, value } of items) t.objectStore(store).put(value);
  return items.length;
});

/** Просит браузер не удалять данные при нехватке места: true / false / null (не поддерживается). */
export async function requestPersistence() {
  try {
    if (!navigator.storage?.persist) return null;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch { return null; }
}
export async function isPersisted() {
  try { return navigator.storage?.persisted ? await navigator.storage.persisted() : null; } catch { return null; }
}
export const _asPromise = asPromise;
