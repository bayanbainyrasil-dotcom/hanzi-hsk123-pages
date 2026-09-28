import * as db from './db.js';
import * as cat from './catalog.js';
import * as store from './store.js';
import * as migrate from './migrate.js';
import * as recover from './recover.js';
import * as speech from './speech.js';
import * as P from './practice.js';
import * as sync from './sync.js';
import * as backup from './safety.js';
import { uid } from './model.js';

/* ---------- мелкие помощники ---------- */
const $ = (sel, root = document) => root.querySelector(sel);
const view = $('#view');
let swError = null;
// номер запущенной версии: при публикации сборка подставляет сюда коммит (tools/build-site.mjs)
const BUILD = 'e22b573';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const html = (strings, ...vals) => strings.reduce((a, s, i) => a + s + (i < vals.length ? (Array.isArray(vals[i]) ? vals[i].join('') : vals[i] ?? '') : ''), '');

let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}
function modal(inner) {
  const d = $('#modal');
  $('#modal-body').innerHTML = inner;
  if (!d.open) d.showModal();
  return d;
}
const closeModal = () => { const d = $('#modal'); if (d.open) d.close(); };

const SPEAKER = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M3 9v6h4l5 4V5L7 9H3zm13.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z"/></svg>';
let autoSpeakOn = true;                     // копия настройки в памяти: озвучка при раскрытии идёт прямо из нажатия
const STATUS_RU = { empty: 'не заполнен', partial: 'частично', confirmed: 'подтверждён', check: 'на проверке', 'n/a': 'повторение' };

/* ---------- состояние ---------- */
const state = { view: 'home', volume: 'shang', lessonId: null, drill: null };

/* ---------- запуск ---------- */
async function boot() {
  await store.ensureProfile();
  await store.liftDailyLimitOnce().catch(() => {});        // прежний лимит «5 новых в день» снят: по умолчанию без лимита
  try { await cat.ensureSeeded(); }
  catch (e) { view.innerHTML = html`<div class="card"><h2>Не удалось загрузить данные приложения</h2><p class="err">${esc(e.message)}</p><p class="muted small">Откройте приложение через сервер (https:// или localhost), а не двойным щелчком по файлу.</p></div>`; return; }
  wireChrome();
  wireSaving();
  registerSW();
  updateNetbar();
  // заметки и дневник сохраняются по мере ввода — перерисовка на них стёрла бы поле под курсором
  store.onChange((what) => { if (what === 'notes' || what === 'journal' || what === 'progress') return; });
  speech.onMessage((t) => toast(t, 6000));
  autoSpeakOn = await db.metaGet('autoSpeak', true);
  speech.setPreferred(await db.metaGet('voicePref', null));
  await render();
  db.requestPersistence().then(v => { persisted = v; });
  wireCloud();
  backup.dailySnapshot().catch(() => {});
  await maybeOfferMigration();
  syncAllExamples();
}

/* ---------- облако: статус на главной и в «Данных» ---------- */
let cloudState = sync.getStatus();
const shortTime = (iso) => new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
function cloudLineText(s = cloudState) {
  if (s.cloud === 'off') return 'Сохранено на устройстве';
  if (s.cloud === 'syncing') return 'Сохранено на устройстве · отправка в облако…';
  if (s.cloud === 'error') return `Сохранено на устройстве · ожидает отправки: ${s.pending} · ${s.code === 'offline' ? 'нет сети' : 'облако: ошибка'}`;
  if (s.pending) return `Ожидает отправки: ${s.pending}` + (s.at ? ` · в облаке: ${shortTime(s.at)}` : '');
  return s.at ? `Сохранено в облаке: ${shortTime(s.at)}` : 'Сохранено на устройстве';
}
async function paintCloudLine() {
  const el = document.getElementById('cloudline'); if (!el) return;
  const r = await backup.reminder().catch(() => null);
  el.textContent = cloudLineText() + (r ? (r.never ? ' · резервной копии файлом нет' : ` · копия файлом: ${r.days} дн. назад`) : '');
  el.dataset.state = cloudState.cloud;
}
function cloudStatusHTML(s = cloudState) {
  return html`<table class="kv"><tbody>
    <tr><td>На устройстве</td><td>${lastSaveError ? html`<span class="err">не сохранено: ${esc(lastSaveError)}</span>` : 'сохранено'}</td></tr>
    <tr><td>Ожидает отправки</td><td>${s.cloud === 'off' ? '—' : s.pending}</td></tr>
    <tr><td>Облако</td><td>${s.cloud === 'off' ? 'не подключено' : s.cloud === 'error' ? html`<span class="err">${esc(s.text)}</span>` : s.cloud === 'syncing' ? 'синхронизация…' : esc(s.text || 'подключено')}</td></tr>
    <tr><td>Сохранено в облаке</td><td>${s.at ? new Date(s.at).toLocaleString('ru-RU') : '—'}</td></tr>
  </tbody></table>`;
}
function wireCloud() {
  sync.onStatus((s) => {
    cloudState = s; paintCloudLine();
    const box = document.getElementById('cloud-status'); if (box) box.innerHTML = cloudStatusHTML();
  });
  sync.start({
    onBookWords: async (data) => { try { await cat.importBookWords(data, { name: 'облако' }); } catch {} },
    onPulled: async () => {
      const mine = (await store.listProfiles()).filter(p => p.owner).map(p => p.id);
      if (await store.focusFilled(mine)) toast('Открыт профиль из облака', 3000);
      if (!state.drill && state.view !== 'data') render();
    }
  });
}
async function syncAllExamples() {
  if (!navigator.onLine) return;
  for (const a of await db.getAll('assets')) if (a.status === 'ready') { try { await cat.syncExamples(a.id); } catch {} }
}

/* ---------- сохранение: статусы и автосохранение ---------- */
let persisted = null;
let lastSaveError = null;
function wireSaving() {
  const bar = $('#savebar'), errBox = $('#saveerr');
  let hideT;
  db.onSave(({ state: st, at, text }) => {
    if (st === 'saving') { bar.dataset.state = 'saving'; bar.textContent = 'сохраняется…'; return; }
    if (st === 'saved') {
      lastSaveError = null; errBox.hidden = true;
      bar.dataset.state = 'saved';
      bar.textContent = '✓ сохранено на устройстве';
      bar.title = 'Записано ' + new Date(at).toLocaleTimeString('ru-RU');
      bar.classList.add('show'); clearTimeout(hideT);
      hideT = setTimeout(() => bar.classList.remove('show'), 1800);  // успех — ненавязчиво
      return;
    }
    lastSaveError = text;
    bar.dataset.state = 'error'; bar.textContent = ''; bar.classList.remove('show');
    errBox.hidden = false;                                           // ошибка — заметно и до следующей успешной записи
    errBox.textContent = 'Не сохранено: ' + text;
  });
  // необработанная ошибка записи не должна пропасть молча
  addEventListener('unhandledrejection', (e) => {
    const n = e.reason?.name || '';
    if (/Quota|InvalidState|Unknown|Abort|Transaction/.test(n) || /IndexedDB|transaction|Транзакция/i.test(String(e.reason?.message))) {
      toast('Не сохранено: ' + db.storageErrorText(e.reason), 7000);
    }
  });
  // заметки: сохранение по мере ввода, с короткой задержкой; уход со страницы — лишь дополнительная страховка
  document.addEventListener('input', (e) => {
    const ta = e.target.closest('form[data-form="lesson-note"] textarea, form[data-form="entry-note"] textarea');
    if (ta) return scheduleNoteSave(ta.form);
    const jf = e.target.closest('form[data-form="journal"]');
    if (jf) scheduleJournalDraft(jf);
  });
  const flushAll = () => { for (const f of noteTimers.keys()) flushNote(f); for (const f of draftTimers.keys()) flushJournalDraft(f); };
  addEventListener('pagehide', flushAll);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushAll(); });
}

const noteTimers = new Map();
const noteChains = new Map();                     // запись по одной заметке строго по очереди
const NOTE_DELAY = 500;
function setNoteStatus(form, st, text) {
  const el = form.querySelector('.note-status'); if (!el) return;
  el.dataset.state = st; el.textContent = text;
}
function scheduleNoteSave(form) {
  setNoteStatus(form, 'saving', 'Сохраняется…');
  clearTimeout(noteTimers.get(form));
  noteTimers.set(form, setTimeout(() => flushNote(form), NOTE_DELAY));
}
function flushNote(form) {
  if (!noteTimers.has(form)) return;
  clearTimeout(noteTimers.get(form)); noteTimers.delete(form);
  const type = form.dataset.form === 'lesson-note' ? 'lesson' : 'entry';
  const id = form.dataset.id, text = form.querySelector('textarea').value;
  const key = type + ':' + id;
  const chain = (noteChains.get(key) || Promise.resolve()).then(async () => {
    try {
      await store.saveNote(type, id, text);        // промис завершается только после complete транзакции
      setNoteStatus(form, 'saved', 'Сохранено на устройстве · ' + new Date().toLocaleTimeString('ru-RU'));
    } catch (e) {
      setNoteStatus(form, 'error', 'Не сохранено: ' + db.storageErrorText(e));
    }
  });
  noteChains.set(key, chain);
  return chain;
}

const draftTimers = new Map();
const draftKey = () => 'journalDraft:' + store.profileId();
function scheduleJournalDraft(form) {
  clearTimeout(draftTimers.get(form));
  setNoteStatus(form, 'saving', 'Черновик сохраняется…');
  draftTimers.set(form, setTimeout(() => flushJournalDraft(form), NOTE_DELAY));
}
async function flushJournalDraft(form) {
  if (!draftTimers.has(form)) return;
  clearTimeout(draftTimers.get(form)); draftTimers.delete(form);
  const fd = Object.fromEntries(new FormData(form).entries());
  try { await db.metaSet(draftKey(), fd); setNoteStatus(form, 'saved', 'Черновик сохранён на устройстве · ' + new Date().toLocaleTimeString('ru-RU')); }
  catch (e) { setNoteStatus(form, 'error', 'Черновик не сохранён: ' + db.storageErrorText(e)); }
}

function wireChrome() {
  const menu = $('#menu');
  $('#btn-menu').addEventListener('click', () => menu.showModal());
  menu.addEventListener('click', (e) => {
    if (e.target === menu || e.target.closest('[data-menu-close]')) return menu.close();
    const b = e.target.closest('button[data-view]'); if (!b) return;
    menu.close(); go(b.dataset.view);
  });
  $('#profile-chip').addEventListener('click', () => { menu.close(); openProfiles(); });
  $('#btn-home').addEventListener('click', () => go('home'));
  $('#btn-search').addEventListener('click', () => { $('#search-results').hidden = false; $('#search').focus(); });
  $('#search-close').addEventListener('click', () => { $('#search-results').hidden = true; $('#search').value = ''; $('#search-list').innerHTML = ''; });
  let st;
  $('#search').addEventListener('input', (e) => { clearTimeout(st); st = setTimeout(() => doSearch(e.target.value), 180); });
  addEventListener('online', updateNetbar); addEventListener('offline', updateNetbar);
  // закрыли карточку слова — обновить отметки на экране под ней
  $('#modal').addEventListener('close', () => {
    for (const f of noteTimers.keys()) if ($('#modal').contains(f)) flushNote(f);      // введённая заметка не теряется
    if (state.dirty) { state.dirty = false; if (!state.drill) render(); }
  });
  closeOnBackdrop($('#modal'), closeModal);
  closeOnBackdrop($('#pop'), closePop);
  // слушаем на документе: диалог <dialog> и панель поиска лежат вне #view
  document.addEventListener('click', onViewClick);
  document.addEventListener('change', onViewChange);
  document.addEventListener('submit', onViewSubmit);
}
function go(v) {
  if (state.drill) store.endSession();
  if (state.pendingReload) return state.pendingReload();
  if (v === 'restore') state.rc = null;                        // каждый вход — свежий поиск
  state.view = v; state.lessonId = null; state.drill = null;
  $('#search-results').hidden = true;
  render(); scrollTo(0, 0); view.focus({ preventScroll: true });
}
const syncTabs = () => {};

function updateNetbar() {
  const bar = $('#netbar');
  if (navigator.onLine) { bar.hidden = true; return; }
  bar.hidden = false; bar.className = 'netbar';
  bar.textContent = 'Нет сети — скачанные слова и занятия работают, записи сохраняются на устройстве.';
}

function registerSW() {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  navigator.serviceWorker.register('sw.js').catch(e => { swError = String(e?.message || e); console.warn('service worker не зарегистрирован', e); });
  // приложение с экрана «Домой» часто не перезапускается, а возвращается из фона — проверить обновление и тогда
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') navigator.serviceWorker.getRegistration().then(r => r?.update()).catch(() => {});
  });
  // новая версия приложения установилась: перезагрузить сразу, если человек не посреди занятия,
  // иначе — при следующем возврате на главную. Данные в IndexedDB при этом не трогаются.
  const had = !!navigator.serviceWorker.controller;
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!had || reloaded) return;
    const apply = () => { if (reloaded) return; reloaded = true; location.reload(); };
    if (!state.drill && !$('#modal').open) return apply();
    state.pendingReload = apply;
  });
}

/* ---------- маршрутизация вида ---------- */
// Медленная отрисовка (например, оглавление учебника) может закончиться позже новой, начатой после перехода
// на другой экран, и перезаписать его. Тогда экран отрисовывается заново по текущему состоянию.
let renderSeq = 0, renderDone = 0;
async function render() {
  const my = ++renderSeq;
  try { return await renderNow(); }
  finally {
    if (renderDone > my) queueMicrotask(render);            // более новая отрисовка уже была — эта её перезаписала
    else renderDone = my;
  }
}
async function renderNow() {
  if (state.pendingReload && !state.drill && !$('#modal').open) return state.pendingReload();   // отложенное обновление версии
  const p = await db.get('profiles', store.profileId());
  $('#profile-chip').textContent = 'Профиль: ' + (p?.name || '—');
  view.classList.toggle('wide', ['textbook', 'data'].includes(state.view) && !state.lessonId);
  if (state.drill) return renderDrill();
  if (state.lessonId) return renderLesson(state.lessonId);
  if (state.view === 'textbook') return renderTextbook();
  if (state.view === 'hsk') return renderHSK();
  if (state.view === 'review') return renderReview();
  if (state.view === 'journal') return renderJournal();
  if (state.view === 'data') return renderData();
  if (state.view === 'restore') return renderRestore();
  return renderHome();
}

/* ---------- главная: выбрать материал и начать ---------- */
const homeKey = () => 'home:' + store.profileId();
const LEVEL_LABEL = (id) => id.replace('hsk', '').replace('-', '–');

async function getMaterial() {
  const m = await db.metaGet(homeKey(), null);
  return m && m.kind ? m : { kind: 'hsk', levels: ['hsk1', 'hsk2'], lessonId: null };
}
const setMaterial = (m) => db.metaSet(homeKey(), m);

/** Идентификаторы слов выбранного материала (только уже скачанные наборы). */
async function materialIds(m) {
  if (m.kind === 'textbook') return m.lessonId ? (await cat.lessonEntries(m.lessonId)).map(e => e.id) : [];
  const ids = [];
  for (const lv of m.levels || []) ids.push(...(await db.byIndex('entries', 'bySource', IDBKeyRange.only('hsk:' + lv))).map(e => e.id));
  return ids;
}

async function renderHome() {
  const m = await getMaterial();
  const prof = await db.get('profiles', store.profileId());
  const packs = await cat.hskPacks();
  const lessons = (await cat.listLessons(cat.TEXTBOOK_ID)).filter(l => l.kind === 'lesson');
  const withWords = [];
  for (const l of lessons) { const n = await cat.lessonWordCount(l.id); if (n) withWords.push({ ...l, n }); }
  if (m.kind === 'textbook' && !withWords.some(l => l.id === m.lessonId)) m.lessonId = withWords[0]?.id || null;

  const ids = await materialIds(m);
  const missing = m.kind === 'hsk' ? (m.levels || []).filter(lv => packs.find(p => p.id === lv)?.state.status !== 'ready') : [];
  const pm = await store.profileProgress();
  const st = await store.progressStats(ids, pm);
  const due = st.due;
  const total = ids.length || 1;
  const w = (n) => (n / total * 100).toFixed(2) + '%';
  const canStart = m.kind === 'hsk' ? (m.levels || []).length > 0 : !!m.lessonId;
  const limit = await store.newPerDay();
  const startedToday = await store.newStartedToday();
  const newLeft = limit === Infinity ? Infinity : Math.max(0, limit - startedToday);
  const saved = await loadDrill();
  const rec = await recover.somethingToRecover(store.profileId());
  const offerRecover = (rec.legacy && !(await recover.lastReport(store.profileId()))) || (!rec.mine && rec.other > 0);

  view.innerHTML = html`
    <div class="who"><span class="name">${esc(prof?.name || 'Профиль')}</span><button class="linkbtn" data-act="profiles">сменить</button></div>

    <div class="seg" role="group" aria-label="Материал">
      <button data-act="mat-kind" data-id="hsk" aria-pressed="${m.kind === 'hsk'}">HSK</button>
      <button data-act="mat-kind" data-id="textbook" aria-pressed="${m.kind === 'textbook'}">Учебник</button>
    </div>

    ${m.kind === 'hsk' ? html`
      <div class="label">Уровни</div>
      <div class="chips">${packs.map(p => html`<button data-act="mat-level" data-id="${p.id}" aria-pressed="${(m.levels || []).includes(p.id)}">${LEVEL_LABEL(p.id)}</button>`)}</div>`
    : withWords.length ? html`
      <div class="label">Урок</div>
      <select class="pick" id="mat-lesson" aria-label="Урок учебника">${withWords.map(l => html`<option value="${l.id}" ${l.id === m.lessonId ? 'selected' : ''}>第${l.number}课 ${esc(l.titleZh)} · ${l.n} сл.</option>`)}</select>`
    : html`<p class="lede">В уроках учебника пока нет слов. Их можно добавить в разделе <a href="#" data-act="goto" data-id="textbook">Учебник: уроки</a>.</p>`}

    ${ids.length ? html`
      <div class="pbar" aria-hidden="true"><i class="c-known" style="width:${w(st.known)}"></i><i class="c-learning" style="width:${w(st.learning)}"></i><i class="c-hard" style="width:${w(st.hard)}"></i></div>
      <div class="legend">
        <span><i class="dot c-known"></i>знаю <b>${st.known}</b></span>
        <span><i class="dot c-learning"></i>учу <b>${st.learning}</b></span>
        <span><i class="dot c-hard"></i>трудно <b>${st.hard}</b></span>
        <span><i class="dot c-new"></i>новые <b>${st.new}</b></span>
      </div>` : html`<div style="height:22px"></div>`}

    ${saved ? html`<button class="btn primary block" data-act="resume">Продолжить занятие · ${saved.i + 1} из ${saved.ids.length}</button>
      <button class="linkbtn center" data-act="start" ${canStart ? '' : 'disabled'}>Начать новое занятие</button>`
    : html`<button class="btn primary block" data-act="start" ${canStart ? '' : 'disabled'}>Начать</button>`}
    ${ids.length ? html`<p class="today muted small center">Повторить: <b>${due}</b> · новых в материале: <b>${st.new}</b>${startedToday ? html` · начато сегодня: <b>${startedToday}</b>` : ''}
      <label>· новых в день <select data-mode="new-limit" aria-label="Новых слов в день">${store.NEW_LIMITS.map(n => html`<option value="${n}" ${(n || Infinity) === limit ? 'selected' : ''}>${n ? n : 'без лимита'}</option>`)}</select></label>
      ${newLeft === 0 && st.new ? html`<br><span class="warn">Выбранный лимит на сегодня достигнут — «Начать» даст повторение; лимит можно снять.</span>` : ''}</p>` : ''}
    ${missing.length ? html`<p class="hint">${missing.map(LEVEL_LABEL).join(', ')} скачается при старте — один раз, дальше без сети.</p>` : ''}
    <button class="linkbtn center" data-act="start-quiz" ${canStart && ids.length >= 4 ? '' : 'disabled'}>Самопроверка: выбрать перевод</button>
    <button class="linkbtn center" data-act="mat-words" ${ids.length ? '' : 'disabled'}>Все слова материала</button>
    ${offerRecover ? html`<button class="linkbtn center" data-act="goto" data-id="restore">Найден прежний прогресс — восстановить</button>` : ''}
    <button class="linkbtn center small muted" id="cloudline" data-act="goto-safety"></button>`;
  paintCloudLine();
  const sel = $('#mat-lesson');
  if (sel) sel.addEventListener('change', async () => { m.lessonId = sel.value; await setMaterial(m); render(); });
}

/** Старт занятия с главной: недостающие наборы HSK сначала скачиваются (из файлов приложения). */
async function startFromHome(mode) {
  const m = await getMaterial();
  if (m.kind === 'hsk') {
    const packs = await cat.hskPacks();
    for (const lv of m.levels || []) {
      const p = packs.find(x => x.id === lv);
      if (p && p.state.status !== 'ready') {
        view.querySelector('[data-act="start"]')?.replaceChildren(document.createTextNode(`Скачиваю ${p.title}…`));
        try { await cat.downloadPack(p); }
        catch (e) { toast(`${p.title} не скачался: ${navigator.onLine ? e.message : 'нет сети'}`, 5000); return render(); }
      }
    }
  }
  const ids = await materialIds(m);
  const scope = m.kind === 'textbook' ? m.lessonId : '__mat__';
  // занятие: сначала повторения, затем новые; по умолчанию без дневного лимита, порция — до 20 карточек
  return startDrill(scope, mode, { ids, from: 'home', newLimit: await store.newLeftToday() });
}

/* ---------- учебник ---------- */
async function renderTextbook() {
  const col = await db.get('collections', cat.TEXTBOOK_ID);
  const lessons = await cat.listLessons(cat.TEXTBOOK_ID);          // уже в порядке оглавления: том → страница
  const vol = state.volume;
  const items = lessons.filter(l => l.volume === vol);
  const counts = {};
  for (const l of lessons) if (l.kind === 'lesson') counts[l.id] = await cat.lessonWordCount(l.id);
  const withBook = lessons.filter(l => l.kind === 'lesson' && counts[l.id] > 0);
  const toCheck = lessons.reduce((s, l) => s + (l.toCheck || 0), 0);
  const volName = (v) => col.volumes.find(x => x.id === v)?.titleZh || v;

  const row = async (l) => {
    if (l.kind === 'review') {
      const to = l.afterLesson, from = to - 4;
      return html`<li class="toc-row quiet"><span class="grow"><span class="zh">${esc(l.titleZh)}</span><span class="sub">повторение уроков ${from}–${to}</span></span><span class="pg">${l.page}</span></li>`;
    }
    if (l.kind === 'appendix') return html`<li class="toc-row quiet"><span class="grow"><span class="zh">${esc(l.titleZh)}</span><span class="sub">приложение книги</span></span><span class="pg">${l.page}</span></li>`;
    const n = counts[l.id] || 0;
    const phon = l.part === 'phonetics';
    const status = n ? `${n} ${plural(n, 'слово', 'слова', 'слов')} из книги${l.vocabularyStatus === 'confirmed' ? '' : l.vocabularyStatus === 'unverified' ? ' · не сверено' : ' · неполно'}`
      : phon ? 'фонетика: звуки и тоны' : 'список слов пока не найден';
    return html`<li><button class="toc-row" data-act="lesson" data-id="${l.id}">
      <span class="no">${l.number}</span>
      <span class="grow"><span class="zh">${esc(l.titleZh)}</span><span class="sub ${n ? 'has' : ''}">${esc(status)}</span>${n ? await miniBar(l.id) : ''}</span>
      <span class="pg">${l.page}</span></button></li>`;
  };

  view.innerHTML = html`
    <h1 class="zh">${esc(col.titleZh)}</h1>
    <p class="lede">${withBook.length
      ? `Слова из книги: ${withBook.length} ${plural(withBook.length, 'урок', 'урока', 'уроков')} из 40 (${withBook.map(l => l.number).join(', ')}).`
      : 'Пока только оглавление: списков слов из книги нет.'}${toCheck ? html` · <a href="#" data-act="goto-checks">на проверке: ${toCheck}</a>` : ''}</p>
    ${!(await cat.bookWordsStatus()).loaded ? html`<div class="card tight" id="book-words-hint"><p class="small">Словарь уроков на этом адресе не публикуется (составлен по книге). Загрузите свой файл словаря — уроки, поиск и примеры заработают на этом устройстве, в том числе без сети.</p>
      <label class="btn sm primary">Загрузить словарь учебника<input type="file" accept=".json,application/json" data-mode="book-words" hidden></label></div>` : ''}
    <div class="seg" role="group" aria-label="Том">
      ${col.volumes.map(v => html`<button data-act="volume" data-id="${v.id}" aria-pressed="${v.id === vol}">${esc(v.titleZh)}</button>`)}
    </div>
    <p class="label" style="margin-top:14px">${esc(volName(vol))} · урок · страница</p>
    <ol class="toc">${(await Promise.all(items.map(row))).join('')}</ol>
    <details class="more"><summary>Об издании и источниках</summary>
      <p class="muted small">${esc(col.title)} · ${esc(col.edition)} · ${esc(col.editors.join(', '))} · ${esc(col.publisher)}</p>
      <p class="muted small">${esc(col.disclaimer)}</p>
      <p class="muted small">Оглавление: ${col.sources.map(s => html`<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a>`).join(' · ')}</p>
      ${(await db.metaGet('bookWords'))?.sources?.length ? html`<p class="muted small">Слова: ${(await db.metaGet('bookWords')).sources.map(s => html`<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a>`).join(' · ')}</p>` : ''}
    </details>`;
}

async function miniBar(lessonId) {
  const entries = await cat.lessonEntries(lessonId);
  if (!entries.length) return '';
  const c = await store.progressStats(entries.map(e => e.id));
  const w = (n) => (n / entries.length * 100).toFixed(1) + '%';
  return html`<span class="bar"><i class="known" style="width:${w(c.known)}"></i><i class="learning" style="width:${w(c.learning)}"></i><i class="hard" style="width:${w(c.hard)}"></i></span>`;
}

/* ---------- урок (или набор HSK, или «все слова материала») ---------- */
async function renderLesson(lessonId) {
  const lesson = lessonId === '__mat__' ? { id: '__mat__', kind: 'mat', titleRu: 'Слова материала' } : await cat.getLesson(lessonId);
  if (!lesson) { state.lessonId = null; return render(); }
  const entries = lessonId === '__mat__'
    ? (await Promise.all((await materialIds(await getMaterial())).map(id => cat.getEntry(id)))).filter(Boolean)
    : await cat.lessonEntries(lessonId);
  const isBook = lesson.collectionId === cat.TEXTBOOK_ID;
  const note = isBook ? await store.getNote('lesson', lessonId) : null;
  const pm = await store.profileProgress();
  const stats = entries.length ? await store.progressStats(entries.map(e => e.id), pm) : null;
  const title = isBook ? html`<span class="zh">第${lesson.number}课 ${esc(lesson.titleZh)}</span>` : esc(lesson.titleRu);
  const sections = isBook ? [...new Set(entries.map(e => e.link?.section).filter(Boolean))] : [];
  const LIMIT = 300;

  view.innerHTML = html`
    <button class="linkbtn" data-act="back">← назад</button>
    <h1>${title}</h1>
    <p class="lede">${isBook ? `${lesson.volume === 'shang' ? '上册' : '下册'} · стр. ${lesson.page} · ` : ''}слов: ${entries.length}${stats ? ` · знаю ${stats.known} · учу ${stats.learning} · к повторению ${stats.due}` : ''}</p>
    ${lesson.toCheck ? html`<p class="small"><span class="badge check">на проверке: ${lesson.toCheck}</span> строки помечены неуверенными — сверьте их с книгой.</p>` : ''}
    ${lesson.vocabularyStatus === 'confirmed' && isBook ? html`<p class="small muted">Словарь сверён с книгой${lesson.confirmedSource ? ': ' + esc(lesson.confirmedSource) : ''}.</p>` : ''}

    ${entries.length ? html`<button class="btn primary block" data-act="drill" data-id="${lessonId}">Учить</button>`
      : isBook ? html`<p class="muted">${lesson.part === 'phonetics' ? 'Фонетический урок: звуки, слоги и тоны. Слова со страниц этого урока пока не найдены.' : 'Список слов этого урока пока не найден. Случайные слова вместо него не подставляются.'}</p>
        <div class="row"><button class="btn" data-act="import-lesson" data-id="${lessonId}">Импортировать CSV/JSON</button><button class="btn" data-act="add-word" data-id="${lessonId}">Ввести вручную</button></div>`
      : html`<p class="muted">Слов нет.</p>`}

    ${isBook && lesson.bookCoverage?.length ? html`<p class="muted small">${lesson.bookCoverage.map(c => esc(c.what)).join('; ')}. Русские значения — перевод приложения.</p>` : ''}
    ${sections.length ? (await Promise.all(sections.map(async sec => html`<p class="label" style="margin-top:18px">${esc(sec)}</p>
      <div class="list">${(await Promise.all(entries.filter(e => e.link?.section === sec).map(e => wordRow(e, pm)))).join('')}</div>`))).join('')
    : entries.length ? html`<div class="list" style="margin-top:18px">${(await Promise.all(entries.slice(0, LIMIT).map(e => wordRow(e, pm)))).join('')}</div>
      ${entries.length > LIMIT ? html`<p class="meta center">Показаны первые ${LIMIT} из ${entries.length}. Остальные — через поиск ⌕.</p>` : ''}` : ''}

    ${isBook ? html`<details class="more" ${note?.text ? 'open' : ''}><summary>Заметка к уроку</summary>
      <form data-form="lesson-note" data-id="${lessonId}">
        <textarea name="text" placeholder="Сохраняется по мере ввода">${esc(note?.text || '')}</textarea>
        <div class="row" style="margin-top:8px"><span class="note-status grow" data-state="${note ? 'saved' : 'idle'}">${note ? 'На устройстве с ' + new Date(note.updatedAt).toLocaleString('ru-RU') : ''}</span>
        <button class="btn sm" type="submit">Сохранить сейчас</button></div>
      </form></details>` : ''}

    ${lessonId !== '__mat__' && entries.length ? html`<details class="more"><summary>Ещё</summary><div class="row">
      <button class="btn sm" data-act="quiz" data-id="${lessonId}" ${entries.length >= 4 ? '' : 'disabled'}>Самопроверка</button>
      <button class="btn sm" data-act="add-word" data-id="${lessonId}">Добавить слово</button>
      ${isBook ? html`<button class="btn sm" data-act="import-lesson" data-id="${lessonId}">Импорт списка</button>` : ''}
      ${isBook && entries.length && !lesson.toCheck && lesson.vocabularyStatus !== 'confirmed' ? html`<button class="btn sm" data-act="confirm-lesson" data-id="${lessonId}">Отметить «сверено с книгой»</button>` : ''}
    </div></details>` : ''}`;
}

const STATUS_COLOR = { known: 'c-known', learning: 'c-learning', hard: 'c-hard', new: 'c-new' };
/** Строка слова: коротко и крупно; отметки, озвучка и заметка — в карточке по нажатию. */
async function wordRow(e, pm = null) {
  const p = pm ? pm.get(e.id) : await store.getProgress(e.id);
  const mark = p?.status || 'new';
  const check = e.link?.confidence === 'check';
  return html`<button class="word" data-act="word" data-id="${e.id}" data-link="${e.link?.id || ''}" data-mark="${mark}">
    <span class="hz">${esc(e.hanzi)}</span>
    <span class="grow"><span class="py">${esc(e.pinyin)}</span>${check ? html` <span class="badge check">не сверено</span>` : ''}<br><span class="ru">${esc(e.ru)}</span></span>
    <i class="st ${STATUS_COLOR[mark] || 'c-new'}" title="${store.MARK_RU[mark]}"></i>
  </button>`;
}

async function openWord(entryId, linkId = '') {
  const e = await cat.getEntry(entryId); if (!e) return;
  const p = await store.getProgress(entryId);
  const mark = p?.status || 'new';
  const note = await store.getNote('entry', entryId);
  const lessons = await cat.entryLessons(entryId);
  const link = linkId ? await db.get('links', linkId) : null;
  const mm = P.splitMeaning(e.ru);
  // разбор по знакам — только справка: у знака своё значение, оно не равно смыслу слова
  const chars = [];
  if ([...e.hanzi].length > 1) for (const c of new Set([...e.hanzi])) {
    const x = (await db.byIndex('entries', 'byHanzi', IDBKeyRange.only(c))).find(y => String(y.source).startsWith('hsk:') && !y.senseKey);
    chars.push(x ? { h: c, p: x.pinyin, r: P.splitMeaning(x.ru).main } : { h: c, p: '', r: 'отдельно в словаре HSK нет' });
  }
  const pairs = await partnersOf(e);
  modal(html`<div class="wcard">
    <div class="hz">${esc(e.hanzi)}</div>
    <div class="py say-row"><span>${esc(e.pinyin)}</span>
      <button class="spk" data-act="say" data-text="${esc(e.hanzi)}" aria-label="Произнести">${SPEAKER}</button>
      <button class="spk slow" data-act="say" data-slow="1" data-text="${esc(e.hanzi)}" aria-label="Медленно">0,6×</button></div>
    <div class="ru">${esc(mm.main)}${e.sense ? html` <span class="meta">(${esc(e.sense)})</span>` : ''}</div>
    ${mm.rest.length ? html`<details class="more"><summary>Ещё значения</summary><p class="small">${esc(mm.rest.join('; '))}</p></details>` : ''}
    ${chars.length ? html`<details class="more"><summary>По знакам — это не перевод слова</summary><ul class="small">${chars.map(c => html`<li><b>${esc(c.h)}</b> ${esc(c.p)} — ${esc(c.r)}</li>`)}</ul></details>` : ''}
    <div class="meta">${[e.hskLevel ? 'HSK ' + esc(e.hskLevel) : '', ...lessons.filter(l => l.kind !== 'hsk').map(l => '第' + l.number + '课')].filter(Boolean).join(' · ')}</div>
    ${link && String(link.source).startsWith('book:') ? html`<p class="muted small" style="margin-top:8px">Книга: стр. ${esc(link.page)} · ${esc(link.section || '')}${link.bookMeaning ? ` · в книге: «${esc(link.bookMeaning)}»` : ''}${link.context ? ` · ${esc(link.context)}` : ''}${link.note ? ` · ${esc(link.note)}` : ''}</p>` : ''}
    ${pairNote(pairs)}
    ${skillsLine(p)}
    ${await examplesBlock(e)}
    <div class="marks" style="margin:16px 0 8px">
      ${store.MARKS.map(m => html`<button class="mark" data-act="mark" data-id="${e.id}" data-mark="${m}" aria-pressed="${mark === m}">${store.MARK_RU[m]}</button>`)}
    </div>
    ${link?.confidence === 'check' ? html`<button class="btn sm" data-act="confirm-link" data-id="${link.id}">Сверено с книгой</button>` : ''}
  </div>
  <form data-form="entry-note" data-id="${entryId}" style="margin-top:14px">
    <textarea name="text" placeholder="Своя заметка к слову — сохраняется по мере ввода">${esc(note?.text || '')}</textarea>
    <div class="row" style="margin-top:8px"><span class="note-status grow" data-state="${note ? 'saved' : 'idle'}">${note ? 'На устройстве' : ''}</span>
    <button class="btn sm" type="submit">Сохранить</button><button class="btn sm" type="button" data-close>Закрыть</button></div>
  </form>`);
}

const VOICE_TESTS = [
  ['不对', 'bú duì', '不 перед 4-м тоном'], ['不好', 'bù hǎo', '不 без изменения'], ['一个人', 'yí gè rén', '一 перед 4-м тоном'],
  ['一天', 'yì tiān', '一 перед 1-м тоном'], ['第一', 'dì yī', 'порядковое 一 не меняется'], ['你好', 'ní hǎo (nǐ hǎo)', 'два 3-х тона'],
  ['妈妈', 'māma', 'нейтральный тон'], ['银行', 'yínháng', '行 = háng'], ['不行', 'bù xíng', '行 = xíng'],
  ['长大', 'zhǎngdà', '长 = zhǎng'], ['很长', 'hěn cháng', '长 = cháng'], ['睡觉', 'shuìjiào', '觉 = jiào']
];

/* ---------- примеры употребления ---------- */
const exCache = new Map();
const LV_NUM = { hsk1: 1, hsk2: 2, hsk3: 3, hsk4: 4, hsk5: 5, hsk6: 6, 'hsk7-9': 7 };
const LV_NAME = (n) => n === 7 ? 'HSK 7–9' : 'HSK ' + n;

/** Верхний допустимый уровень лексики примеров: выбранные на главной уровни HSK, но не ниже уровня самого слова. */
async function allowedLevel(entry) {
  const m = await getMaterial();
  const own = LV_NUM[entry?.hskPack || String(entry?.source || '').replace('hsk:', '')] || 1;
  const sel = m.kind === 'hsk' ? Math.max(0, ...(m.levels || []).map(l => LV_NUM[l] || 0)) : 0;
  return Math.max(sel || own, own);
}
/**
 * Примеры слова. Слово учебника берёт примеры своего слова HSK (то же написание и чтение,
 * значение сверено при сборке данных). Если примеры набора ещё не скачаны — докачиваем.
 */
async function examplesForEntry(e) {
  let tid = e.hskId || e.id;
  if (!e.hskId && !String(e.source || '').startsWith('hsk:')) {           // запасной путь: то же написание и чтение
    const same = (await db.byIndex('entries', 'byHanzi', IDBKeyRange.only(e.hanzi))).filter(x => String(x.source).startsWith('hsk:') && x.pinyinKey === e.pinyinKey);
    if (same.length === 1) { tid = same[0].id; e = { ...e, hskPack: same[0].source.slice(4) }; }
  }
  const pack = e.hskPack || (String(e.source || '').startsWith('hsk:') ? e.source.slice(4) : null);
  let all = await cat.examplesFor(tid), error = null;
  if (!all.length && pack && !(await db.metaGet('examples:' + pack))) {
    try { await cat.syncExamples(pack); all = await cat.examplesFor(tid); }
    catch (err) { error = navigator.onLine ? `примеры не загрузились (${err?.message || err})` : 'примеры ещё не скачаны — нужна сеть один раз'; }
  }
  const allowed = await allowedLevel(e);
  const ok = all.filter(x => x.level <= allowed);
  const pm = await store.profileProgress();
  const unknown = (x) => x.toks.filter(t => t.id && !t.t && pm.get(t.id)?.status !== 'known').length;
  const main = ok.filter(x => !x.extra).sort((a, b) => unknown(a) - unknown(b));    // знакомые слова — вперёд
  const extra = ok.filter(x => x.extra);
  ok.forEach(x => exCache.set(x.id, x));
  return { main, extra, pm, allowed, hidden: all.length - ok.length, error, pack };
}
function exampleHTML(x, pm, { practice = true } = {}) {
  const toks = x.toks.map((t, i) => t.k
    ? html`<button class="tok${t.t ? ' tgt' : ''}${!t.t && pm && pm.get(t.id)?.status !== 'known' ? ' unk' : ''}" data-act="tok" data-ex="${esc(x.id)}" data-i="${i}">${esc(t.h)}</button>`
    : esc(t.h)).join('');
  return html`<div class="ex">
    <p class="exzh" lang="zh-CN">${toks}</p>
    <p class="expy">${esc(x.py)}</p>
    <p class="exru">${esc(x.ru)}</p>
    <div class="exbar"><button class="linkbtn" data-act="ex-say" data-ex="${esc(x.id)}">♪ фраза</button><button class="linkbtn" data-act="ex-say" data-slow="1" data-ex="${esc(x.id)}">♪ медленно</button>${practice ? html`<button class="linkbtn" data-act="ex-practice" data-id="${esc(x.tid)}">Практика</button>` : ''}</div>
  </div>`;
}
async function examplesBlock(e, { limit = 2, extra = true, hint = true } = {}) {
  const ex = await examplesForEntry(e);
  if (!ex.main.length && !ex.extra.length) {
    const why = ex.error ? ex.error
      : ex.hidden ? `примеры есть на уровне выше ${LV_NAME(ex.allowed)} — выберите больший уровень на главной`
      : 'примеров для этого слова пока нет';
    return hint ? html`<p class="muted small exs-none" data-state="${ex.error ? 'error' : 'none'}">Употребление: ${esc(why)}.</p>` : '';
  }
  // пример — сразу три строки: предложение, пиньинь, перевод (без кнопок раскрытия)
  return html`<div class="exs">
    <div class="exhead"><span class="label">Примеры · ${LV_NAME(ex.allowed)}</span></div>
    ${ex.main.slice(0, limit).map(x => exampleHTML(x, ex.pm))}
    ${extra && ex.extra.length ? html`<details class="more"><summary>Другое значение</summary>${ex.extra.map(x => exampleHTML(x, ex.pm))}</details>` : ''}
    ${hint ? html`<p class="muted small">Нажмите на слово, чтобы открыть его. Пунктир — слово ещё не отмечено как известное.</p>` : ''}
  </div>`;
}

/** Карточка слова из предложения: значение в этом предложении — первым. */
function openTok(exId, i) {
  const x = exCache.get(exId); const t = x?.toks[i]; if (!t) return;
  const why = t.why?.length ? html`<div class="muted small">${esc(t.why.join('; '))}</div>` : '';
  $('#pop-body').innerHTML = html`
    <div class="say-line"><span class="hz" lang="zh-CN">${esc(t.h)}</span>
      <span class="py">${esc(t.s || t.p)}</span>${t.s ? html`<span class="muted small">в словаре: ${esc(t.p)}</span>` : ''}</div>
    ${why}
    <p class="ctx">В этом предложении: <b>${esc(t.g || t.r || '—')}</b></p>
    ${t.r && t.r !== t.g ? html`<p class="muted small">Словарь${t.lv ? ' · ' + LV_NAME(t.lv) : ''}: ${esc(t.r)}${t.pAlt ? ' · чтения: ' + esc(t.pAlt) : ''}</p>` : ''}
    ${t.alt?.length ? html`<details class="more"><summary>Другие значения и чтения ${esc(t.h)}</summary><ul class="small">${t.alt.map(a => html`<li><b>${esc(a.p)}</b> — ${esc(a.r)} <span class="muted">(${LV_NAME(a.lv)})</span></li>`)}</ul></details>` : ''}
    ${t.chars?.length ? html`<details class="more"><summary>По знакам — это не смысл слова</summary><ul class="small">${t.chars.map(c => html`<li><b>${esc(c.h)}</b> ${esc(c.p || '')} — ${esc(c.r || 'отдельно в словаре HSK нет')}</li>`)}</ul></details>` : ''}
    <div class="row">
      <button class="btn sm" data-act="say" data-text="${esc(t.h)}">♪</button>
      <button class="btn sm" data-act="say" data-slow="1" data-text="${esc(t.h)}">♪ медленно</button>
      <button class="btn sm" data-act="tok-practice" data-id="${esc(t.id)}" data-pack="${esc(t.pack || '')}">Практиковать</button>
      <button class="btn sm" data-act="tok-review" data-id="${esc(t.id)}">К повторению</button>
      <button class="btn sm" data-act="pop-close">Закрыть</button>
    </div>`;
  const d = $('#pop'); if (!d.open) d.showModal();
}
const closePop = () => { const d = $('#pop'); if (d.open) d.close(); };
// Нажатие на затемнённый фон вне карточки закрывает её (только верхнюю: поверх открытой карточки фон принадлежит ей).
// iOS Safari не считает фон <dialog> «нажимаемым» и может не прислать click — поэтому закрываем по отпусканию
// пальца (pointerup), а следующий за ним click глушим, чтобы он не нажал то, что окажется под пальцем.
// Считается лишь короткое нажатие, начатое и законченное вне карточки: прокрутка и свайп карточку не закрывают.
let swallowClickUntil = 0;
document.addEventListener('click', (e) => { if (Date.now() < swallowClickUntil) { swallowClickUntil = 0; e.preventDefault(); e.stopPropagation(); } }, true);   // только один click — тот, что от этого же касания
document.addEventListener('pointerdown', () => { swallowClickUntil = 0; }, true);             // новое касание — гасить больше нечего
function closeOnBackdrop(dlg, close) {
  const outside = (e) => { const r = dlg.getBoundingClientRect(); return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom; };
  let start = null;
  const tap = (e) => { const s = start; start = null; return !!s && dlg.open && e.target === dlg && outside(e) && Math.hypot(e.clientX - s.x, e.clientY - s.y) <= 10; };
  dlg.addEventListener('pointerdown', (e) => { start = e.isPrimary && e.target === dlg && outside(e) ? { x: e.clientX, y: e.clientY } : null; });
  dlg.addEventListener('pointercancel', () => { start = null; });
  dlg.addEventListener('pointerup', (e) => {
    if (!tap(e)) return;
    swallowClickUntil = Date.now() + 450;
    e.preventDefault(); close();
  });
  // запасной путь (клавиатура, старые браузеры без pointer-событий)
  dlg.addEventListener('click', (e) => { if (e.target === dlg && outside(e) && e.detail > 0 && !start && Date.now() >= swallowClickUntil && !('PointerEvent' in window)) close(); });
}

/** Короткая практика в предложениях: предложение → раскрыть пиньинь и перевод → оценить себя. */
async function startSentenceDrill(entryId) {
  const e = await cat.getEntry(entryId);
  if (!e) return toast('Слово ещё не скачано');
  const ex = await examplesForEntry(e);
  const items = [...ex.main, ...ex.extra];
  if (!items.length) return toast('Для этого слова пока нет примеров');
  closePop(); closeModal(); $('#search-results').hidden = true;
  await store.startSession(null);
  state.drill = { mode: 'sentence', items, ids: items.map(x => x.tid), pool: [entryId], i: 0, scope: '__sent__', lessonId: null, right: 0, almost: 0, wrong: 0, revealed: false, t0: Date.now(), from: state.lessonId ? 'lesson' : state.view, sentenceOf: entryId };
  renderDrill(); scrollTo(0, 0);
}

async function ensureEntry(entryId, packId) {
  if (await cat.getEntry(entryId)) return true;
  const pack = (await cat.hskPacks()).find(p => p.id === packId);
  if (!pack) return false;
  toast(`Скачиваю ${pack.title}…`);
  try { await cat.downloadPack(pack); } catch { return false; }
  return !!(await cat.getEntry(entryId));
}

/* ---------- HSK: наборы ---------- */
async function renderHSK() {
  const packs = await cat.hskPacks();
  view.innerHTML = html`
    <h1>Наборы HSK</h1>
    <p class="lede">Скачиваются один раз и работают без сети. Прогресс привязан к слову и при обновлении не обнуляется.</p>
    <div class="list">
      ${packs.map(p => html`<div class="card tight spread">
        <div class="grow"><b>${esc(p.title)}</b>
          <div class="meta">${p.state.status === 'ready' ? `скачано, ${p.state.count} слов` : p.state.status === 'partial' ? `скачано частично: ${p.state.count} слов — можно докачать` : p.state.status === 'failed' ? `<span class="err">не скачалось: ${esc(p.state.error || '')}</span>` : 'не скачано'}</div>
          <div class="progress-slot" data-pack="${p.id}"></div>
        </div>
        ${p.state.status === 'ready' ? html`<button class="btn sm" data-act="open-hsk" data-id="hsk.${p.id}">Слова</button>` : ''}
        <button class="btn sm" data-act="download" data-id="${p.id}">${p.state.status === 'ready' ? 'Обновить' : 'Скачать'}</button>
      </div>`)}
    </div>
    <button class="btn block" data-act="download-all" style="margin-top:12px">Скачать все наборы</button>
    <div class="progress-slot" data-pack="__all__"></div>
    <details class="more"><summary>Импорт словаря файлом</summary>
      <p class="muted small">Файлы <code>data/hsk/hsk1.json … hsk7-9.json</code> идут вместе с приложением. Свой файл словаря можно загрузить вручную.</p>
      <button class="btn sm" data-act="import-hsk">Импортировать файл словаря</button>
    </details>`;
}

/* ---------- повторение ---------- */
async function renderReview() {
  const all = await db.getAll('entries');
  const pm = await store.profileProgress();
  const ids = all.map(e => e.id);
  const queue = await store.buildQueue(ids, { limit: 200, onlyDue: true });
  const st = await store.progressStats(ids, pm);
  view.innerHTML = html`
    <h1>Повторение</h1>
    <p class="lede">Все слова, которые пора повторить, из любых уроков и уровней.</p>
    <button class="btn primary block" data-act="drill" data-id="__due__" ${queue.length ? '' : 'disabled'}>${queue.length ? `Повторить · ${Math.min(queue.length, 20)} из ${queue.length}` : 'На сегодня всё повторено'}</button>
    <div class="legend" style="margin-top:18px">
      <span><i class="dot c-known"></i>знаю <b>${st.known}</b></span>
      <span><i class="dot c-learning"></i>учу <b>${st.learning}</b></span>
      <span><i class="dot c-hard"></i>трудно <b>${st.hard}</b></span>
    </div>`;
}

/* ---------- занятие ---------- */
// Голос путунхуа есть на устройстве — можно давать задания на слух. Иначе — текстовые, аудио не засчитывается.
const DAY_MS = 86400000;
const audioOK = () => typeof speechSynthesis !== 'undefined' && speech.zhVoices().length > 0;

/* пары «не путать»: data/confusables.json (проверены тестом) */
let pairIdxP = null;
const pairIdx = () => (pairIdxP ||= cat.fetchJSON('data/confusables.json').then(P.pairIndex).catch(() => new Map()));
/** Слова, с которыми это слово легко спутать, с проверенным пояснением. Только основное значение слова HSK. */
async function partnersOf(e) {
  if (!e) return [];
  let base = e;
  if (!String(e.source || '').startsWith('hsk:')) { base = e.hskId ? await cat.getEntry(e.hskId) : null; if (!base) return []; }
  if (base.senseKey) return [];
  const list = (await pairIdx()).get(base.hanzi) || [];
  const out = [];
  for (const { other, note } of list) {
    const o = (await db.byIndex('entries', 'byHanzi', IDBKeyRange.only(other))).find(x => String(x.source).startsWith('hsk:') && !x.senseKey);
    if (o) out.push({ entry: o, note });
  }
  return out;
}

async function poolFor(scope) {
  if (scope === '__due__' || scope === '__all__') return (await db.getAll('entries')).map(e => e.id);
  if (scope === '__mat__') return materialIds(await getMaterial());
  return (await cat.lessonEntries(scope)).map(e => e.id);
}
/** Пример для задания с пропуском: пример именно этого слова (по id), меньше всего незнакомых слов. */
async function clozeFor(e, pm) {
  const ex = await examplesForEntry(e).catch(() => null);
  if (!ex) return null;
  return P.bestCloze(ex.main, e.hskId || e.id, (id) => (pm || ex.pm).get(id)?.status === 'known');
}

async function startDrill(scope, mode = 'recall', { ids = null, from = null, newLimit = Infinity } = {}) {
  const pool = ids || await poolFor(scope);
  const queue = await store.buildQueue(pool, { limit: 20, onlyDue: scope === '__due__', newLimit });
  if (!queue.length) return nothingToStudy(pool, { newLimit, from, scope, mode });
  const lessonId = scope.startsWith('__') ? null : scope;
  const audio = audioOK();
  const pm = await store.profileProgress();
  // направление для каждого слова: самопроверка — по навыку, который проверялся реже; выбор — перевод или на слух
  const dirs = [];
  for (const [i, id] of queue.entries()) {
    if (mode === 'quiz') { dirs.push(audio && i % 2 ? 'au' : 'hz'); continue; }
    const p = pm.get(id);
    const cloze = p?.reps ? !!(await clozeFor(await cat.getEntry(id), pm)) : false;
    dirs.push(P.chooseDirection(p, { audio, cloze }));
  }
  await store.startSession(lessonId);
  state.drill = { ids: queue, dirs, pool, i: 0, mode, scope, lessonId, right: 0, almost: 0, wrong: 0, revealed: false, t0: Date.now(),
    from: from || (state.lessonId ? 'lesson' : state.view), again: [], log: [] };
  saveDrill();
  renderDrill(); scrollTo(0, 0);
}
/* незавершённое занятие хранится на устройстве: закрыли приложение — на главной «Продолжить занятие» */
const drillKey = () => 'drill:' + store.profileId();
async function saveDrill(ahead = 0) {
  const d = state.drill;
  if (d?.mode === 'sentence') return;                       // короткая практика предложений не трогает сохранённое занятие
  try {
    if (!d || d.finished || d.i + ahead >= d.ids.length) return await db.metaSet(drillKey(), null);
    const { ids, dirs, mode, scope, lessonId, right, almost, wrong, again, log, from } = d;
    await db.metaSet(drillKey(), { v: 1, ids, dirs, i: d.i + ahead, mode, scope, lessonId, right, almost, wrong, again, log, from, savedAt: Date.now() });
  } catch {}
}
async function loadDrill() {
  const s = await db.metaGet(drillKey(), null).catch(() => null);
  return s && s.v === 1 && Array.isArray(s.ids) && s.i < s.ids.length ? s : null;
}
async function resumeDrill() {
  const s = await loadDrill(); if (!s) return render();
  await store.startSession(s.lessonId);
  const known = ['__due__', '__all__', '__mat__'].includes(s.scope) || !String(s.scope).startsWith('__');
  state.drill = { ...s, pool: known ? await poolFor(s.scope) : s.ids, revealed: false, t0: Date.now() };
  renderDrill(); scrollTo(0, 0);
}

/** Начать нечего: честно сказать почему и предложить повторение или другой материал. */
async function nothingToStudy(pool, { newLimit, from, scope, mode }) {
  const pm = await store.profileProgress();
  const newIn = pool.filter(id => { const p = pm.get(id); return !p || (p.status === 'new' && !p.reps); }).length;
  const next = pool.map(id => pm.get(id)).filter(p => p?.reps && p.due > Date.now()).map(p => p.due).sort((a, b) => a - b)[0];
  const allDue = (await store.buildQueue((await db.getAll('entries')).map(e => e.id), { limit: 1, onlyDue: true })).length;
  state.retry = { scope, mode, ids: pool, from };
  modal(html`<h3>${newIn && newLimit === 0 ? 'Лимит новых слов на сегодня достигнут' : 'Новые слова закончились'}</h3>
    <p class="small">${newIn && newLimit === 0 ? `В материале ещё ${newIn} новых слов, но достигнут выбранный вами дневной лимит.`
      : `В выбранном ${scope && !String(scope).startsWith('__') ? 'уроке' : 'материале'} новых слов больше нет, и повторять сейчас нечего.`}
    ${next ? ` Ближайшее повторение здесь — ${new Date(next).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}.` : ''}</p>
    <div class="list">
      ${newIn && newLimit === 0 ? html`<button class="btn primary" data-act="retry-nolimit">Учить дальше без лимита</button>` : ''}
      ${allDue ? html`<button class="btn" data-act="goto-review">Повторение: слова из других уроков и уровней</button>` : ''}
      <button class="btn" data-act="pick-material">Другой урок или уровень</button>
      <button class="btn" data-close>Закрыть</button>
    </div>`);
}

/** Итог: что повторено, что было трудно, что дальше. Без наград и рейтингов. */
async function renderSummary(d) {
  const s = await store.endSession();
  d.finished = true; saveDrill();
  if (d.mode === 'sentence') {
    view.innerHTML = html`<div class="center"><h1>Предложения</h1>
      <p class="lede">понял ${d.right} · почти ${d.almost} · не понял ${d.wrong}</p>
      <button class="btn primary block" data-act="again">Ещё заход</button>
      <button class="linkbtn center" data-act="stop-drill">${d.from === 'lesson' ? 'К уроку' : 'На главную'}</button></div>`;
    return;
  }
  const secs = Math.round(((s?.endedAt || Date.now()) - (s?.startedAt || Date.now())) / 1000);
  const log = d.log || [];
  const words = [...new Set(log.map(x => x.id))];
  const hardIds = words.filter(id => log.some(x => x.id === id && x.res !== 'ok'));
  const hard = (await Promise.all(hardIds.map(id => cat.getEntry(id)))).filter(Boolean);
  const pool = d.pool || [];
  const pm = await store.profileProgress();
  const dueNow = pool.filter(id => { const p = pm.get(id); return p && p.reps && p.due <= Date.now(); }).length;
  const soon = await store.dueWithin(pool, DAY_MS);
  const newLeftInPool = pool.filter(id => { const p = pm.get(id); return !p || (p.status === 'new' && !p.reps); }).length;
  const allowed = d.from === 'home' ? await store.newLeftToday() : Infinity;
  const canMore = dueNow > 0 || (newLeftInPool > 0 && allowed > 0);
  const where = d.lessonId ? 'в этом уроке' : 'в выбранном материале';
  const self = log.filter(x => x.chosen === undefined), choice = log.filter(x => x.chosen !== undefined);
  const byDir = (dir) => self.filter(x => x.dir === dir).length;
  view.innerHTML = html`<div class="summary">
    <h1>Итог занятия</h1>
    <p class="lede">${words.length} ${plural(words.length, 'слово', 'слова', 'слов')} · ${secs < 60 ? secs + ' с' : Math.round(secs / 60) + ' мин'}</p>
    ${self.length ? html`<p class="small">По вашей оценке: знаю ${self.filter(x => x.res === 'ok').length} · почти ${self.filter(x => x.res === 'almost').length} · не знаю ${self.filter(x => x.res === 'bad').length}
      <span class="muted">(иероглифы ${byDir('hz')} · по смыслу ${byDir('ru')} · на слух ${byDir('au')} · в предложении ${byDir('use')})</span></p>` : ''}
    ${choice.length ? html`<p class="small">Выбор из вариантов: верно ${choice.filter(x => x.res === 'ok').length} · неверно ${choice.filter(x => x.res !== 'ok').length} <span class="muted">— это узнавание, не уверенное знание</span></p>` : ''}
    ${hard.length ? html`<div class="label" style="margin-top:14px">Было трудно</div>
      <div class="list">${hard.map(e => html`<button class="word card tight" data-act="word" data-id="${e.id}"><span class="hz">${esc(e.hanzi)}</span><span class="grow"><span class="py">${esc(e.pinyin)}</span> <span class="small">${esc(P.splitMeaning(e.ru).main)}</span></span></button>`)}</div>
      <p class="muted small">Эти слова вернутся раньше: через 10 минут («не знаю») или завтра («почти»).</p>` : html`<p class="small ok">Трудных слов в этом занятии не было.</p>`}
    <div class="label" style="margin-top:14px">Дальше</div>
    <p class="small">Новых слов ${where}: <b>${newLeftInPool}</b> · пора повторить: <b>${dueNow}</b>${soon ? ` · в ближайшие сутки подойдёт ещё ${soon}` : ''}.</p>
    ${canMore ? html`<button class="btn primary block" data-act="again">Учить дальше</button>`
      : newLeftInPool > 0 ? html`<p class="small warn">Выбранный вами лимит новых слов на сегодня достигнут.</p>
        <button class="btn primary block" data-act="again" data-nolimit="1">Учить дальше без лимита</button>`
      : html`<p class="small">Новые слова ${where} закончились, и повторять сейчас нечего.</p>
        <div class="row"><button class="btn" data-act="goto-review">Повторение</button><button class="btn" data-act="pick-material">Другой урок или уровень</button></div>`}
    <button class="linkbtn center" data-act="stop-drill">${d.from === 'lesson' ? 'К уроку' : 'На главную'}</button>
  </div>`;
}

const DIR_PROMPT = {
  hz: 'Вспомните чтение и значение', ru: 'Вспомните слово по-китайски: иероглифы и чтение',
  au: 'Послушайте и вспомните слово: значение и как пишется'
};
/** Ответ после «Показать» / выбора: слово целиком, пиньинь, основное значение первым, звук. */
function answerBlock(e, { big = false } = {}) {
  const m = P.splitMeaning(e.ru);
  return html`<div class="ans">
    ${big ? html`<div class="hzans" lang="zh-CN">${esc(e.hanzi)}</div>` : ''}
    <div class="py say-row"><span>${esc(e.pinyin)}</span>
      <button class="spk" data-act="say" data-text="${esc(e.hanzi)}" aria-label="Произнести">${SPEAKER}</button>
      <button class="spk slow" data-act="say" data-slow="1" data-text="${esc(e.hanzi)}" aria-label="Медленно">0,6×</button></div>
    <div class="ru">${esc(m.main)}</div>${m.rest.length ? html`<div class="ru-rest muted small">${esc(m.rest.join('; '))}</div>` : ''}
  </div>`;
}
/** Строка навыков: что и сколько раз проверялось (самооценка и выбор — отдельно). Старые записи — без разделения. */
function skillsLine(p) {
  if (!p?.reps) return '';
  const k = p.skills || {};
  const one = (s, label) => { const x = k[s]; return x?.n ? `${label} ${x.ok}/${x.n}` : `${label} —`; };
  const parts = [one('rec', 'иероглифы'), one('prod', 'по смыслу'), one('listen', 'на слух'), one('use', 'в предложении')];
  const legacy = !p.skills ? ` · раньше: ${p.reps} ${plural(p.reps, 'ответ', 'ответа', 'ответов')} без разделения по навыкам` : '';
  const choice = k.choice?.n ? ` · выбор перевода ${k.choice.ok}/${k.choice.n}` : '';
  return html`<p class="skills muted small">Знаю / проверено: ${esc(parts.join(' · '))}${esc(choice)}${esc(legacy)}</p>`;
}
const pairNote = (ps) => ps.length ? html`<div class="pairs small">${ps.map(p => html`<p><b>Не путать:</b> ${esc(p.note)}</p>`)}</div>` : '';

async function renderDrill() {
  const d = state.drill;
  if (!d) return render();
  if (d.i >= d.ids.length) return renderSummary(d);
  if (d.mode === 'sentence') return renderSentence(d);
  const e = await cat.getEntry(d.ids[d.i]);
  if (!e) { d.i++; return renderDrill(); }
  const tag = e.hskLevel ? 'HSK ' + e.hskLevel : (d.lessonId ? 'урок' : '');
  const top = html`<div class="drill-top"><button class="linkbtn" data-act="stop-drill">← закончить</button><span>${d.i + 1} / ${d.ids.length}</span></div>`;
  let dir = d.dirs?.[d.i] || 'hz';
  let note = '';
  if (dir === 'au' && !audioOK()) { dir = d.dirs[d.i] = 'hz'; note = 'Голоса путунхуа на устройстве нет — задание на слух заменено текстовым.'; }
  let cz = null;
  if (dir === 'use') { cz = await clozeFor(e); if (!cz) dir = d.dirs[d.i] = 'hz'; }
  d.dir = dir; d.say = cz ? cz.ex.zh : e.hanzi;
  if (cz) return renderCloze(d, e, cz, top);
  // лицевая сторона: только то, что не раскрывает ответ (звук — лишь в задании на слух)
  const face = dir === 'ru'
    ? html`<span class="ru-q">${esc(e.ru)}</span>${e.pos ? html`<span class="muted small">${esc(e.pos)}</span>` : ''}`
    : dir === 'au'
      ? html`<div class="listen"><button class="btn primary" data-act="say" data-text="${esc(e.hanzi)}">${SPEAKER} Прослушать</button><button class="btn" data-act="say" data-slow="1" data-text="${esc(e.hanzi)}">медленно</button></div>`
      : html`<span class="char ${[...e.hanzi].length > 2 ? 'long' : ''}">${esc(e.hanzi)}</span>`;
  const sheet = html`<div class="sheet" data-dir="${dir}" ${dir === 'au' ? '' : 'role="button" tabindex="0" data-act="reveal" aria-label="Показать ответ"'}><i class="gv"></i><i class="gh"></i>
    ${tag ? html`<span class="tag">${esc(tag)}</span>` : ''}${face}</div>`;

  if (d.mode === 'quiz') return renderQuiz(d, e, top, dir, note);

  view.innerHTML = html`${top}
    ${sheet}
    ${note ? html`<p class="muted small center">${esc(note)}</p>` : ''}
    ${d.revealed ? html`${dir === 'hz' ? answerBlock(e) : answerBlock(e, { big: true })}
      ${pairNote(await partnersOf(e))}
      <p class="muted small center" style="margin:10px 0 4px">Оцените себя — это самооценка, не проверка</p>
      <div class="grades">
        <button class="g0" data-act="grade" data-ok="0">Не знаю</button>
        <button class="g1" data-act="grade" data-ok="half">Почти</button>
        <button class="g2" data-act="grade" data-ok="1">Знаю</button>
      </div>
      ${await examplesBlock(e, { limit: 1, extra: false, hint: false })}`
    : html`<p class="muted small center">${esc(DIR_PROMPT[dir])}</p><button class="btn primary block" data-act="reveal" style="margin-top:12px">Показать</button>`}`;
}

/**
 * Пропуск в предложении: проверенный пример этого слова, перевод — подсказка к смыслу; пиньинь и слово — после ответа.
 * Незнакомые слова подчёркнуты. После ответа — полное предложение, пиньинь, перевод, обычная и медленная озвучка.
 */
async function renderCloze(d, e, cz, top) {
  const pm = await store.profileProgress();
  const known = (id) => pm.get(id)?.status === 'known';
  exCache.set(cz.ex.id, cz.ex);
  const face = cz.ex.toks.map((t, i) => i === cz.ti ? html`<span class="blank" aria-label="пропуск">${'　'.repeat([...t.h].length)}</span>`
    : t.k ? html`<span class="${t.id && !known(t.id) ? 'unk' : ''}">${esc(t.h)}</span>` : esc(t.h)).join('');
  view.innerHTML = html`${top}
    <div class="sheet" data-dir="use"><span class="tag">${esc(LV_NAME(cz.ex.level))}</span><p class="exzh cloze" lang="zh-CN">${face}</p></div>
    ${d.revealed ? html`<div class="exs fixed">${exampleHTML(cz.ex, pm, { practice: false })}</div>
      ${answerBlock(e, { big: true })}
      <p class="muted small center" style="margin:10px 0 4px">Оцените себя — это самооценка, не проверка</p>
      <div class="grades">
        <button class="g0" data-act="grade" data-ok="0">Не знаю</button>
        <button class="g1" data-act="grade" data-ok="half">Почти</button>
        <button class="g2" data-act="grade" data-ok="1">Знаю</button>
      </div>`
    : html`<p class="exru center">${esc(cz.ex.ru)}</p>
      <p class="muted small center">Вспомните пропущенное слово${cz.unknown.length ? ` · пунктиром — незнакомые слова (${cz.unknown.length})` : ''}</p>
      <button class="btn primary block" data-act="reveal" style="margin-top:12px">Показать</button>`}`;
}

/** Выбор из вариантов: перевод к иероглифам или слово на слух. После ответа — разбор, без автоперехода. */
async function renderQuiz(d, e, top, dir, note) {
  if (!d.opts) d.opts = {};
  if (!d.opts[d.i]) {
    const ps = await partnersOf(e);
    const poolIds = [...new Set(d.pool)];
    const poolEntries = (await Promise.all(poolIds.slice(0, 3000).map(id => cat.getEntry(id)))).filter(Boolean);
    const extra = ps.map(p => p.entry).filter(x => !poolEntries.some(y => y.id === x.id));
    const dis = P.pickDistractors(e, [...extra, ...poolEntries], { kind: dir === 'au' ? 'sound' : 'meaning', partners: ps.map(p => p.entry.id) });
    d.opts[d.i] = { ids: shuffle([e.id, ...dis.map(x => x.id)]), partners: ps };
  }
  const o = d.opts[d.i];
  const opts = (await Promise.all(o.ids.map(id => cat.getEntry(id)))).filter(Boolean);
  const fb = d.fb && d.fb.i === d.i ? d.fb : null;
  const face = dir === 'au'
    ? html`<div class="listen"><button class="btn primary" data-act="say" data-text="${esc(e.hanzi)}">${SPEAKER} Прослушать</button><button class="btn" data-act="say" data-slow="1" data-text="${esc(e.hanzi)}">медленно</button></div>`
    : html`<span class="char ${[...e.hanzi].length > 2 ? 'long' : ''}">${esc(e.hanzi)}</span>`;
  const optLabel = (x) => dir === 'au' ? html`<span lang="zh-CN" class="opt-hz">${esc(x.hanzi)}</span>` : esc(P.splitMeaning(x.ru).main);
  view.innerHTML = html`${top}
    <div class="sheet" data-dir="${dir}"><i class="gv"></i><i class="gh"></i>${face}</div>
    ${note ? html`<p class="muted small center">${esc(note)}</p>` : ''}
    <p class="muted small center">${dir === 'au' ? 'Какое слово прозвучало?' : 'Выберите перевод'}</p>
    <div class="choices">${opts.map(x => html`<button data-act="answer" data-id="${x.id}" ${fb ? 'disabled' : ''} class="${fb ? (x.id === e.id ? 'right' : x.id === fb.chosen ? 'wrong' : '') : ''}">${optLabel(x)}</button>`)}</div>
    ${fb ? html`<div class="feedback">
        <p class="small ${fb.correct ? 'ok' : 'err'}">${fb.correct ? 'Верно — выбор засчитан как узнавание, не как уверенное знание.' : 'Неверно.'}</p>
        ${answerBlock(e, { big: true })}
        ${!fb.correct && fb.chosenEntry ? html`<div class="ans alt"><div class="muted small">Вы выбрали:</div><div class="hzans small-hz" lang="zh-CN">${esc(fb.chosenEntry.hanzi)}</div><div class="py">${esc(fb.chosenEntry.pinyin)}</div><div class="ru">${esc(P.splitMeaning(fb.chosenEntry.ru).main)}</div></div>` : ''}
        ${!fb.correct && fb.pair ? html`<div class="pairs small"><p><b>Отличие:</b> ${esc(fb.pair)}</p></div>` : ''}
        <button class="btn primary block" data-act="next">Дальше</button>
      </div>` : ''}`;
}
async function renderSentence(d) {
  const x = d.items[d.i];
  exCache.set(x.id, x); d.say = x.zh;
  const pm = await store.profileProgress();
  const tgt = x.toks.find(t => t.t);
  const top = html`<div class="drill-top"><button class="linkbtn" data-act="stop-drill">← закончить</button><span>предложение ${d.i + 1} / ${d.items.length}</span></div>`;
  view.innerHTML = html`${top}
    <div class="sheet" role="button" tabindex="0" data-act="reveal" aria-label="Показать ответ"><i class="gv"></i><i class="gh"></i>
      <span class="tag">${esc(LV_NAME(x.level))}</span>
      <p class="exzh" lang="zh-CN">${x.toks.map(t => t.t ? html`<b style="color:var(--cinnabar)">${esc(t.h)}</b>` : esc(t.h)).join('')}</p>
      <button class="sound" data-act="say" data-text="${esc(x.zh)}" aria-label="Произнести предложение">${SPEAKER}</button>
    </div>
    ${d.revealed ? html`<div class="exs fixed">${exampleHTML(x, pm, { practice: false })}
        <p class="small">${esc(tgt?.h || '')} ${esc(tgt?.s || tgt?.p || '')} — <b>${esc(tgt?.g || '')}</b></p></div>
      <div class="grades">
        <button class="g0" data-act="grade" data-ok="0">Не понял</button>
        <button class="g1" data-act="grade" data-ok="half">Почти</button>
        <button class="g2" data-act="grade" data-ok="1">Понял</button>
      </div>`
    : html`<p class="muted small center">Прочитайте и поймите предложение, потом откройте ответ.</p><button class="btn primary block" data-act="reveal" style="margin-top:12px">Показать</button>`}`;
}
const shuffle = (a) => a.map(v => [Math.random(), v]).sort((x, y) => x[0] - y[0]).map(v => v[1]);
const plural = (n, one, few, many) => { const m10 = n % 10, m100 = n % 100; return m10 === 1 && m100 !== 11 ? one : (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20) ? few : many); };

/* ---------- дневник ---------- */
async function renderJournal() {
  const entries = await store.listJournal();
  const sessions = await store.listSessions();
  const ms = await store.studyTimeMs();
  const notes = await store.listNotes();
  const draft = await db.metaGet(draftKey(), null) || {};
  view.innerHTML = html`
    <div class="card">
      <h1>Дневник</h1>
      <p class="muted small">Занятий: ${sessions.length} · общее время: ${Math.round(ms / 60000)} мин · заметок: ${notes.length}</p>
      <form data-form="journal">
        <label class="field"><span>Что понял</span><textarea name="understood">${esc(draft.understood || '')}</textarea></label>
        <label class="field"><span>Что не понял</span><textarea name="notUnderstood">${esc(draft.notUnderstood || '')}</textarea></label>
        <label class="field"><span>Что хочу повторить</span><textarea name="toReview">${esc(draft.toReview || '')}</textarea></label>
        <div class="row"><button class="btn primary" type="submit">Записать</button>
        <span class="note-status" data-state="${draft.understood || draft.notUnderstood || draft.toReview ? 'saved' : 'idle'}">${draft.understood || draft.notUnderstood || draft.toReview ? 'Черновик восстановлен с устройства' : 'Черновик сохраняется по мере ввода'}</span></div>
      </form>
    </div>
    ${entries.length ? html`<div class="list">${entries.slice(0, 40).map(j => html`<div class="card tight">
      <div class="muted small">${new Date(j.ts).toLocaleString('ru-RU')}</div>
      ${j.understood ? html`<div><b>Понял:</b> ${esc(j.understood)}</div>` : ''}
      ${j.notUnderstood ? html`<div><b>Не понял:</b> ${esc(j.notUnderstood)}</div>` : ''}
      ${j.toReview ? html`<div><b>Повторить:</b> ${esc(j.toReview)}</div>` : ''}
    </div>`)}</div>` : html`<p class="muted">Записей пока нет.</p>`}
    ${notes.length ? html`<div class="card"><h3>Заметки к словам и урокам</h3><div class="list">${notes.slice(0, 50).map(n => html`<div class="card tight"><div class="muted small">${n.targetType === 'lesson' ? 'урок' : 'слово'} · ${new Date(n.updatedAt).toLocaleDateString('ru-RU')}</div>${esc(n.text)}</div>`)}</div></div>` : ''}`;
}

/* ---------- данные / офлайн ---------- */
const SHELL_RE = /^(?:hanzi-hsk123-)?shell-(v\d+)$/;     // кэш оболочки (с префиксом с v23)
// Голоса путунхуа этого устройства: прослушать и выбрать. «женский» — только для известных по имени голосов (браузер пол не сообщает).
function voicePicker() {
  const list = speech.zhVoices(), p = speech.preferred(), st = speech.status();
  if (!list.length) return html`<p class="muted small">${esc(st.text)}</p>`;
  return html`<p class="muted small">${esc(st.text)}</p>
    <div class="list">${list.map(v => html`<div class="spread small"><span><b>${esc(v.name)}</b> <span class="muted">${esc(v.lang)}${v.female ? ' · женский' : ''}${v.local ? ' · на устройстве' : ''}</span>${v.chosen ? ' <span class="badge confirmed">используется</span>' : ''}</span>
      <span class="row"><button class="btn sm" data-act="voice-try" data-uri="${esc(v.uri)}" aria-label="Прослушать">♪</button><button class="btn sm" data-act="voice-pick" data-uri="${esc(v.uri)}" data-name="${esc(v.name)}" data-lang="${esc(v.lang)}" ${p && v.chosen ? 'disabled' : ''}>Выбрать</button></span></div>`)}</div>
    ${p ? html`<button class="linkbtn" data-act="voice-auto">Выбирать автоматически</button>` : ''}`;
}

async function renderData() {
  const t = await cat.totals();
  const assets = await db.getAll('assets');
  const lastExport = await store.lastExportAt();
  const migratedAt = await migrate.migratedAt();
  const hasLegacy = migrate.hasLegacy();
  const sp = speech.status();
  const est = navigator.storage?.estimate ? await navigator.storage.estimate() : null;
  const sw = await offlineStatus();
  const profiles = await store.listProfiles();
  const bw = await cat.bookWordsStatus();
  const shell = ((await caches.keys().catch(() => [])).find(k => SHELL_RE.test(k)) || 'без кэша').replace(SHELL_RE, 'оболочка $1');
  const site = navigator.onLine ? await fetch('version.json', { cache: 'no-store' }).then(r => r.ok ? r.json() : null).then(v => v?.commit?.slice(0, 7) || null).catch(() => null) : null;

  const ready = sw.ok && assets.some(a => a.status === 'ready');
  const autoSpeak = await db.metaGet('autoSpeak', true);
  const pers = await db.isPersisted();
  view.innerHTML = html`
    <h1>Данные и офлайн</h1>
    <p class="lede ${ready ? 'ok' : ''}">${ready ? 'Готово для офлайн: интерфейс и скачанные слова открываются без сети.' : sw.ok ? 'Интерфейс готов для офлайн, но наборы слов ещё не скачаны.' : 'Не готово для офлайн: ' + esc(sw.text)}</p>
    <div class="card">
      <table><tbody>
        <tr><td>Версия приложения</td><td>${esc(BUILD)} · ${esc(shell)}${site && site !== BUILD ? html` · на сайте ${esc(site)} <button class="btn sm" data-act="update-app">Обновить</button>` : site ? ' · последняя' : ''}</td></tr>
        <tr><td>Слов в базе</td><td>${t.entries}</td></tr>
        <tr><td>Связей слово↔урок</td><td>${t.links}</td></tr>
        <tr><td>Уроков учебника</td><td>${t.lessons}</td></tr>
        <tr><td>Скачанные наборы</td><td>${assets.filter(a => a.status === 'ready').map(a => a.id).join(', ') || '—'}</td></tr>
        <tr><td>Работа без сети</td><td>${sw.ok ? '<span class="ok">да, открывается без сети</span>' : esc(sw.text)}</td></tr>
        <tr><td>Занято в браузере</td><td>${est ? (est.usage / 1048576).toFixed(1) + ' МБ' : 'неизвестно'}</td></tr>
        <tr><td>Озвучивание</td><td>${esc(sp.text)}</td></tr>
        <tr><td>Примеры</td><td>${(await Promise.all(assets.filter(a => a.status === 'ready').map(async a => { const m = await db.metaGet('examples:' + a.id); return m ? `${a.id}: ${m.count}` : null; }))).filter(Boolean).join(', ') || 'не скачаны'}</td></tr>
        <tr><td>Защита от очистки</td><td>${pers === true ? 'включена (браузер не удалит данные сам)' : pers === false ? 'браузер не дал — делайте копии' : 'не поддерживается'}</td></tr>
      </tbody></table>
      <details class="more" id="voice-box"><summary>Голос</summary>${voicePicker()}</details>
      <details class="more"><summary>Отчёт об озвучке</summary>
        <p class="muted small">Сведения об устройстве и последних попытках озвучки, без прогресса и заметок. Нажмите динамик у слова, вернитесь сюда и скопируйте.</p>
        <textarea id="speech-report" readonly rows="10" style="font-size:.78rem">${esc(speech.report({ version: BUILD + ' · ' + shell }))}</textarea>
        <div class="row"><button class="btn sm" data-act="speech-report-copy">Скопировать</button><button class="btn sm" data-act="speech-report-refresh">Обновить</button></div>
      </details>
      <details class="more"><summary>Проверить голос на трудных случаях</summary>
        <p class="muted small">Приложение не может само услышать, правильно ли читает синтезатор. Нажмите и сравните с пиньинем: если голос читает иначе, это ошибка синтезатора, верьте пиньиню.</p>
        <p class="muted small">Голоса путунхуа на устройстве: ${esc(speech.zhVoices().map(v => `${v.name} (${v.lang}${v.local ? ', без сети' : ', сетевой'})${v.chosen ? ' — выбран' : ''}`).join('; ') || 'нет')}</p>
        <div class="list">${VOICE_TESTS.map(([zh, py, why]) => html`<div class="spread small"><span><b lang="zh-CN">${esc(zh)}</b> ${esc(py)} <span class="muted">— ${esc(why)}</span></span><button class="btn sm" data-act="say" data-text="${esc(zh)}">♪</button></div>`)}</div>
      </details>
      <label class="spread" style="margin-top:10px"><span>Произносить слово при показе ответа</span><input type="checkbox" data-mode="autospeak" ${autoSpeak ? 'checked' : ''} style="width:24px;height:24px"></label>
      <div class="row" style="margin-top:10px">
        <button class="btn" data-act="precache">Подготовить офлайн-режим</button>
        <button class="btn" data-act="goto-hsk">Скачать наборы HSK</button>
      </div>
    </div>

    ${await safetyCard()}

    <div class="card" id="book-box">
      <h3>Словарь учебника</h3>
      <p class="muted small">${bw.loaded ? `Загружено слов уроков: <b>${bw.count}</b>${bw.from === 'файл' ? ` — из файла${bw.fileName ? ' «' + esc(bw.fileName) + '»' : ''}${bw.fileAt ? ', ' + new Date(bw.fileAt).toLocaleString('ru-RU') : ''}` : ' — с сайта'}. Хранится на этом устройстве, работает без сети.`
        : 'Не загружен. На публичном адресе словарь уроков не публикуется: загрузите свой файл (hanzi-hsk123 · словарь учебника, .json).'}
      Идентификаторы слов те же, что прежде: перенесённые отметки и заметки к словам учебника сохраняются.</p>
      <label class="btn sm">${bw.loaded ? 'Загрузить новее' : 'Загрузить словарь учебника'}<input type="file" accept=".json,application/json" data-mode="book-words" hidden></label>
    </div>

    <div class="card" id="transfer-box">
      <h3>Перенос с другого адреса</h3>
      <p class="muted small">Новый адрес не видит данные старого. Откройте приложение на старом адресе <b>тем же способом</b>, каким занимались
      (значок на экране «Домой» или Safari), сохраните файл «все данные», затем загрузите его здесь. Переносятся все профили, отметки, попытки,
      заметки, дневник и занятия. Повторная загрузка дублей не создаёт; при расхождении остаётся более новая запись; перед записью
      сохраняется копия того, что уже есть здесь.</p>
      <div class="row">
        <label class="btn sm primary">Загрузить файл переноса<input type="file" accept=".json,application/json" data-mode="transfer" hidden></label>
        <button class="btn sm" data-act="export-all">Сохранить все данные</button>
      </div>
    </div>

    <div class="card">
      <h3>Профили</h3>
      <div class="list">${profiles.map(p => html`<div class="spread card tight"><span>${esc(p.name)} ${p.kind === 'test' ? '<span class="badge">тестовый</span>' : ''} ${p.id === store.profileId() ? '<span class="badge confirmed">текущий</span>' : ''}</span>
        <button class="btn sm" data-act="use-profile" data-id="${p.id}">Выбрать</button></div>`)}</div>
      <div class="row" style="margin-top:8px"><button class="btn sm" data-act="new-profile">Новый профиль</button></div>
    </div>

    <div class="card">
      <h3>Прежняя версия приложения</h3>
      <p class="muted small">${hasLegacy ? 'В этом браузере есть данные прежней версии.' : 'В localStorage этого браузера данных прежней версии нет.'}${migratedAt ? ` Прошлый перенос: ${new Date(migratedAt).toLocaleString('ru-RU')}.` : ''} Поиск, копия и возврат отметок — в отдельном пункте.</p>
      <div class="row"><button class="btn" data-act="goto" data-id="restore">Восстановить прежний прогресс</button></div>
      <p class="muted small" style="margin-top:10px">Если занимались на другом адресе: откройте там <code>export-legacy.html</code>, сохраните файл и загрузите его сюда. Повторная загрузка того же файла дублей не создаёт.</p>
      <label class="btn sm">Импорт файла старой версии<input type="file" accept=".json,application/json" data-mode="legacy" hidden></label>
    </div>

    <div class="card">
      <h3>Демонстрационный набор</h3>
      <p class="muted small">20 слов, помеченных как демо. Это не учебник и не HSK.</p>
      <button class="btn sm" data-act="remove-demo">Удалить демо-набор</button>
    </div>`;
}

/* ---------- «Данные» → сохранность: облако, резервная копия файлом, версии, конфликты, корзина ---------- */
const TOKEN_URL = (owner) => `https://github.com/settings/personal-access-tokens/new?name=hanzi-hsk123-data&description=${encodeURIComponent('hanzi-hsk123 progress sync (one private repo)')}${owner ? '&target_name=' + encodeURIComponent(owner) : ''}&expires_in=366&contents=write`;
function attemptHTML(a) {
  if (!a) return '';
  const bad = a.steps?.some(x => !x.ok);
  return html`<details class="more" id="cloud-attempt" ${bad ? 'open' : ''}><summary>Последняя попытка подключения: ${new Date(a.at).toLocaleString('ru-RU')}${bad ? ' — остановилась' : ''}</summary>
    <ul class="small steps">${(a.steps || []).map(x => html`<li class="${x.ok ? 'ok' : 'err'}">${x.ok ? '✓' : '✗'} ${esc(x.name)}${x.detail ? html` — <span class="muted">${esc(x.detail)}</span>` : ''}</li>`)}</ul>
    <p class="small"><b>${esc(a.final || '')}</b></p>
    <div class="row"><button class="btn sm" data-act="copy-attempt">Скопировать отчёт (без ключа)</button><button class="btn sm" data-act="cloud-probe">Проверить связь с GitHub</button></div>
  </details>`;
}
function attemptText(a) {
  return [`hanzi-hsk123 ${BUILD} · попытка подключения ${a.at}`, ...(a.steps || []).map(x => `${x.ok ? 'OK ' : 'ОШИБКА '}${x.name}${x.detail ? ' — ' + x.detail : ''}`), `итог: ${a.final}`, `в сети: ${a.online}`, `браузер: ${a.ua}`].join('\n');
}
async function safetyCard() {
  const conn = await sync.getConn();
  const lastFile = await backup.lastSavedAt();
  const rem = await backup.reminder();
  const conflicts = conn ? await sync.listConflicts() : [];
  const trash = await backup.listTrash();
  const snaps = (await backup.listSnapshots()).filter(x => x.kind !== 'trash');
  const attempt = await sync.lastAttempt();
  return html`<div class="card" id="safety-box">
    <h3>Сохранность</h3>
    <div id="cloud-status">${cloudStatusHTML()}</div>
    ${attemptHTML(attempt)}
    ${conn ? html`
      <p class="muted small">Облако: приватный репозиторий <b>${esc(conn.repo)}</b> (аккаунт GitHub ${esc(conn.login)}). Отправка идёт, пока приложение открыто:
      после ответов, при открытии и при появлении сети. Когда iPhone закрыл приложение, отправки нет — она продолжится при следующем открытии.</p>
      <div class="row"><button class="btn sm primary" data-act="cloud-sync">Синхронизировать сейчас</button>
        <button class="btn sm" data-act="cloud-versions">Версии в облаке</button>
        <button class="btn sm" data-act="cloud-disconnect">Отключить на этом устройстве</button></div>`
    : html`
      <details class="more" id="cloud-connect"><summary>Подключить облако (приватный GitHub)</summary>
        <p class="muted small">Данные уходят только в <b>ваш приватный</b> репозиторий GitHub. Вход — ключ доступа только к этому репозиторию.
        Ключ хранится лишь на этом устройстве, в резервные копии и облако не попадает. Не присылайте ключ никому.</p>
        <ol class="small">
          <li>Приватный репозиторий: <code>hanzi-hsk123-data</code> (пустой).</li>
          <li><a href="${TOKEN_URL('')}" target="_blank" rel="noopener">Создать ключ на GitHub</a> — название, срок (366 дней) и право «Contents: Read and write» уже заполнены.
            В «Repository access» выберите «Only select repositories» → <code>hanzi-hsk123-data</code>. Нажмите «Generate token» и скопируйте ключ.</li>
          <li>Вставьте ключ сюда и нажмите «Проверить» — сначала будет показано, что и куда отправится.</li>
        </ol>
        <label class="field"><span>Репозиторий</span><input id="cloud-repo" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="логин/hanzi-hsk123-data" value="hanzi-hsk123-data"></label>
        <label class="field"><span>Ключ доступа GitHub</span><input id="cloud-token" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="github_pat_…"></label>
        <button class="btn sm primary" data-act="cloud-inspect">Проверить</button>
      </details>`}
    ${conflicts.length ? html`<details class="more"><summary>Конфликты синхронизации: ${conflicts.length}</summary>
      <p class="muted small">Запись изменили на двух устройствах. Оставлена одна версия, вторая сохранена — её можно взять.</p>
      <div class="list">${conflicts.slice(0, 60).map(c => html`<div class="card tight spread small"><span>${esc(conflictLabel(c))} · оставлена: ${esc(c.kept)}</span>
        <button class="btn sm" data-act="conflict-take" data-id="${esc(c.id)}">Взять другую</button></div>`)}</div></details>` : ''}

    <h4 style="margin-top:14px">Резервная копия файлом</h4>
    <p class="muted small">Независимо от облака: все профили, отметки, попытки, заметки, дневник, занятия, настройки и словарь учебника в одном файле.
    На iPhone — «Сохранить в Файлы» (можно в iCloud Drive). Сайт не пишет в iCloud сам.
    Последняя копия: <b>${lastFile ? new Date(lastFile).toLocaleString('ru-RU') : 'не сохранялась'}</b>${rem ? html` <span class="warn">— ${rem.never ? 'стоит сохранить' : `прошло ${rem.days} дн.`}</span>` : ''}.</p>
    <div class="row">
      <button class="btn sm primary" data-act="full-backup">Сохранить резервную копию</button>
      <label class="btn sm">Восстановить из копии<input type="file" accept=".json,application/json" data-mode="full-backup" hidden></label>
    </div>
    <details class="more"><summary>Корзина: ${trash.length}</summary>
      ${trash.length ? html`<div class="list">${trash.slice(0, 50).map(b => html`<div class="card tight spread small"><span>${esc(b.what === 'notes' ? 'Заметка: ' + String(b.value?.text || '').slice(0, 50) : b.what)} · ${new Date(b.createdAt).toLocaleString('ru-RU')}</span>
        <button class="btn sm" data-act="untrash" data-id="${esc(b.id)}">Вернуть</button></div>`)}</div>` : html`<p class="muted small">Пусто. Стёртые заметки хранятся здесь 60 дней.</p>`}
    </details>
    <details class="more"><summary>Снимки на устройстве: ${snaps.length}</summary>
      <p class="muted small">Ежедневный снимок (7 последних) и копии перед переносом и восстановлением (по 10). Нужны для отката, если что-то пошло не так.</p>
      <div class="list">${snaps.slice(0, 30).map(x => html`<div class="small">${new Date(x.createdAt).toLocaleString('ru-RU')} · ${esc(SNAP_RU[x.kind] || x.kind)}${x.counts ? ` · отметок ${x.counts.progress ?? '—'}, попыток ${x.counts.attempts ?? '—'}` : ''}</div>`)}</div>
    </details>
    <details class="more"><summary>Копия одного профиля</summary>
      <p class="muted small">Прежний формат (текущий профиль). Последний экспорт: ${(await store.lastExportAt()) ? new Date(await store.lastExportAt()).toLocaleString('ru-RU') : 'никогда'}.</p>
      <div class="row"><button class="btn sm" data-act="export">Скачать копию профиля</button><button class="btn sm" data-act="import-backup">Загрузить копию профиля</button></div>
    </details>
  </div>`;
}
const SNAP_RU = { daily: 'ежедневный', 'pre-restore': 'перед восстановлением прогресса', 'pre-transfer': 'перед переносом', 'pre-backup-restore': 'перед восстановлением из файла', 'restore-differences': 'версии из файла, не заменившие текущие' };
function conflictLabel(c) {
  const v = c.local || c.remote || {};
  if (c.store === 'progress') return `слово ${String(c.rk)} — здесь: ${MARK_SHORT[c.local?.status] || c.local?.status || '—'}, в облаке: ${MARK_SHORT[c.remote?.status] || c.remote?.status || '—'}`;
  if (c.store === 'notes') return 'заметка: ' + String(v.text || '').slice(0, 40);
  return c.store + ' ' + c.rk;
}

let pendingFile = null;              // готовый файл копии: сохраняется отдельным нажатием (iPhone требует свежее нажатие для «Поделиться»)
async function onSafetyAct(act, b) {
  if (act === 'goto-safety') {
    go('data');
    for (let i = 0; i < 40 && !document.getElementById('safety-box'); i++) await new Promise(r => setTimeout(r, 50));
    document.getElementById('safety-box')?.scrollIntoView({ block: 'start' }); return true;
  }
  if (act === 'cloud-sync') { b.disabled = true; const r = await sync.syncNow('manual'); b.disabled = false; toast(r.ok ? 'Сохранено в облаке' : 'Облако: ' + (r.text || 'не подключено'), 4000); render(); return true; }
  if (act === 'cloud-probe') {
    b.disabled = true; b.textContent = 'Проверяю связь…';
    const r = await sync.probe();
    await sync.saveAttempt([{ name: 'связь с GitHub (без ключа)', ok: r.ok, detail: r.text }], r.ok ? 'связь с GitHub есть' : 'связи с GitHub нет — облако работать не сможет, данные сохраняются на устройстве');
    render(); return true;
  }
  if (act === 'copy-attempt') {
    const a = await sync.lastAttempt(); if (!a) return true;
    try { await navigator.clipboard.writeText(attemptText(a)); toast('Отчёт скопирован — вставьте его в чат', 3500); }
    catch { modal(html`<h3>Отчёт о подключении</h3><textarea readonly rows="10" style="width:100%;font-size:.78rem">${esc(attemptText(a))}</textarea><button class="btn" data-close>Закрыть</button>`); }
    return true;
  }
  if (act === 'cloud-inspect') {
    const token = $('#cloud-token')?.value || '', repo = $('#cloud-repo')?.value || '';
    b.disabled = true; b.textContent = 'Проверяю…';
    const log = [];
    try {
      const net = await sync.probe();
      log.push({ name: 'связь с GitHub', ok: net.ok, detail: net.text });
      if (!net.ok) throw new Error(net.text);
      const info = await sync.inspect(token, repo, log);
      const local = await sync.localSummary();
      if (info.foreign) throw new Error(`в ${info.repo} уже есть посторонние файлы — нужен пустой приватный репозиторий`);
      state.cloudToken = token; state.cloudRepo = info.repo; state.cloudLog = log;
      await sync.saveAttempt(log, 'ключ и репозиторий проверены — ждёт «Подключить» в окне');
      const cur = store.profileId();
      modal(html`<h3>Подключить облако</h3>
        <p class="small">Аккаунт GitHub: <b>${esc(info.login)}</b>. Репозиторий: <b>${esc(info.repo)}</b> (приватный${info.empty ? ', пустой' : ''}).</p>
        ${info.profiles.length ? html`<p class="small">В облаке уже есть профили — они будут <b>загружены</b> на это устройство (облачные данные не заменяются):</p>
          <ul class="small">${info.profiles.map(p => html`<li>${esc(p.name)} — файлов отметок ${p.progressFiles}, дней с ответами ${p.attemptDays}</li>`)}</ul>` : ''}
        <p class="small">Отправить в облако профили этого устройства (отметки, попытки, навыки, заметки, дневник, занятия, настройки и незавершённое занятие; словарь учебника — в закрытую папку):</p>
        <div class="list">${local.map(p => html`<label class="spread small"><span>${esc(p.name)} — отметок ${p.progress}, попыток ${p.attempts}, заметок ${p.notes}${p.owner && p.owner !== info.login + '/' + info.repo ? ' · <b>привязан к другому аккаунту — не отправляется</b>' : ''}</span>
          <input type="checkbox" data-upload="${esc(p.id)}" ${(p.progress + p.attempts + p.notes + p.journal) && (!p.owner || p.owner === info.login + '/' + info.repo) ? 'checked' : ''} ${p.owner && p.owner !== info.login + '/' + info.repo ? 'disabled' : ''} style="width:22px;height:22px"></label>`)}</div>
        <p class="muted small">Пустые профили по умолчанию не отправляются. Тестовые профили не отправляются никогда. Отключить можно в любой момент — данные останутся и здесь, и в облаке.</p>
        <div class="row"><button class="btn primary" data-act="cloud-connect">Подключить</button><button class="btn" data-close>Отмена</button></div>`);
    } catch (e) { await sync.saveAttempt(log, 'не подключено: ' + (e.message || e)); toast('Облако: ' + (e.message || e), 7000); render(); }
    finally { b.disabled = false; b.textContent = 'Проверить'; }
    return true;
  }
  if (act === 'cloud-connect') {
    const ids = [...document.querySelectorAll('#modal [data-upload]')].filter(x => x.checked).map(x => x.dataset.upload);
    b.disabled = true; b.textContent = 'Подключаю…';
    const log = state.cloudLog || [];
    try {
      const r = await sync.connect(state.cloudToken, state.cloudRepo, { uploadIds: ids, log });
      state.cloudToken = null; state.cloudLog = null; closeModal();
      await sync.saveAttempt(log, r.ok ? 'подключено: GitHub подтвердил сохранение' : 'устройство подключено, но облачная копия НЕ обновлена: ' + (r.text || r.code) + ' — данные остаются на устройстве');
      toast(r.ok ? 'Облако подключено · сохранено в облаке' : 'Подключено, но облачная копия не обновлена: ' + (r.text || ''), 7000);
    } catch (e) { await sync.saveAttempt(log, 'не подключено: ' + (e.message || e)); toast('Облако: ' + (e.message || e), 7000); closeModal(); render(); return true; }
    render(); return true;
  }
  if (act === 'cloud-disconnect') {
    modal(html`<h3>Отключить облако на этом устройстве?</h3><p class="small">Ключ будет удалён с устройства. Данные останутся и здесь, и в облаке. Неотправленные изменения (${cloudState.pending}) останутся в очереди и уйдут, если подключить этот же аккаунт снова.</p>
      <div class="row"><button class="btn primary" data-act="cloud-disconnect-yes">Отключить</button><button class="btn" data-close>Отмена</button></div>`);
    return true;
  }
  if (act === 'cloud-disconnect-yes') { await sync.disconnect(); closeModal(); render(); return true; }
  if (act === 'cloud-versions') {
    b.disabled = true;
    try {
      const list = await sync.versions(store.profileId());
      modal(html`<h3>Версии профиля в облаке</h3>
        <p class="muted small">Каждая отправка — версия. Выбранная версия восстанавливается <b>новым профилем</b>: текущие данные не меняются.</p>
        ${list.length ? html`<div class="list">${list.map(v => html`<div class="spread small"><span>${new Date(v.date).toLocaleString('ru-RU')}</span><button class="btn sm" data-act="cloud-version-open" data-id="${esc(v.sha)}">Открыть</button></div>`)}</div>` : html`<p class="small">Для этого профиля в облаке версий нет.</p>`}
        <button class="btn" data-close>Закрыть</button>`);
    } catch (e) { toast('Облако: ' + (e.message || e), 6000); }
    b.disabled = false; return true;
  }
  if (act === 'cloud-version-open') {
    const snap = await sync.snapshotAt(b.dataset.id, store.profileId()).catch(e => { toast('Облако: ' + e.message, 6000); return null; });
    if (!snap) return true;
    state.cloudSnap = snap;
    const known = snap.progress.filter(p => p.status === 'known').length;
    modal(html`<h3>Версия от ${new Date(snap.date).toLocaleString('ru-RU')}</h3>
      <p class="small">Профиль «${esc(snap.profile?.name || '—')}»: отметок ${snap.progress.length} (знаю ${known}), попыток ${snap.attempts.length}, заметок ${snap.notes.length}, записей дневника ${snap.journal.length}, занятий ${snap.sessions.length}.</p>
      <div class="row"><button class="btn primary" data-act="cloud-version-restore">Восстановить как новый профиль</button><button class="btn" data-close>Закрыть</button></div>`);
    return true;
  }
  if (act === 'cloud-version-restore') {
    const r = await sync.restoreAsNewProfile(state.cloudSnap); state.cloudSnap = null;
    await store.setProfile(r.id); closeModal();
    toast(`Восстановлено в новый профиль «${r.name}»: отметок ${r.counts.progress}`, 6000); render(); return true;
  }
  if (act === 'conflict-take') { const ok = await sync.takeOther(b.dataset.id); toast(ok ? 'Взята другая версия' : 'Эту версию взять нельзя', 3000); render(); return true; }
  if (act === 'untrash') { const r = await backup.untrash(b.dataset.id); toast(r === true ? 'Возвращено' : r === 'occupied' ? 'На этом месте уже есть новая запись — не заменяю' : 'Не найдено', 4000); render(); return true; }
  if (act === 'full-backup') {
    b.disabled = true;
    const obj = await backup.makeFullBackup({ appVersion: BUILD });
    const text = JSON.stringify(obj);
    pendingFile = { name: `hanzi-hsk123-резервная-копия-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.json`, text, at: obj.exportedAt };
    b.disabled = false;
    const c = obj.counts;
    modal(html`<h3>Резервная копия готова</h3>
      <p class="small">Профилей ${c.profiles}, отметок ${c.progress}, попыток ${c.attempts}, заметок ${c.notes}, дневник ${c.journal}, занятий ${c.sessions}, настроек ${c.settings}${obj.data.bookWords ? ', словарь учебника' : ''}. Размер ${(text.length / 1024).toFixed(0)} КБ. Контрольная сумма ${obj.checksum}.</p>
      <p class="muted small">На iPhone: «Сохранить в Файлы» → iCloud Drive или «На iPhone».</p>
      <div class="row"><button class="btn primary" data-act="full-backup-save">Сохранить файл</button><button class="btn" data-close>Отмена</button></div>`);
    return true;
  }
  if (act === 'full-backup-save') {
    if (!pendingFile) return true;
    const how = await saveJSONFile(pendingFile.name, pendingFile.text, { share: true });
    if (how === 'cancelled') { toast('Файл не сохранён', 3000); return true; }
    await backup.markSaved(pendingFile.at); pendingFile = null; closeModal();
    toast(how === 'shared' ? 'Файл передан в «Поделиться» — проверьте, что он появился в «Файлах»' : 'Файл сохранён в загрузки', 5000);
    render(); return true;
  }
  if (act === 'full-restore-merge' || act === 'full-restore-new') {
    const obj = state.restoreFile; if (!obj) return true;
    b.disabled = true;
    try {
      const r = await backup.restoreFull(obj, { mode: act === 'full-restore-new' ? 'new' : 'merge' });
      if (obj.data.bookWords && r.stats.bookWords) { try { await cat.importBookWords(obj.data.bookWords, { name: 'резервная копия' }); } catch {} }
      await store.focusFilled(r.profiles);
      state.restoreFile = null; closeModal();
      const s = r.stats;
      modal(html`<h3>Восстановлено</h3><p class="small">Добавлено записей ${s.added}, уже были ${s.same}, оставлены текущие (отличались) ${s.kept}; новых профилей ${s.profiles}, настроек ${s.settings}.</p>
        <p class="muted small">Перед восстановлением сохранён снимок текущих данных${r.differences ? '; версии из файла, не заменившие текущие, сохранены отдельно' : ''}.</p><button class="btn" data-close>Закрыть</button>`);
    } catch (e) { toast('Не восстановлено: ' + (e.message || e), 7000); }
    render(); return true;
  }
  return false;
}
function previewRestore(obj) {
  const chk = backup.inspectFile(obj);
  if (!chk.ok) return modal(html`<h3>Файл не принят</h3><p class="err small">${esc(chk.problems.join('; '))}</p><p class="muted small">Ничего не изменено.</p><button class="btn" data-close>Закрыть</button>`);
  state.restoreFile = obj;
  const s = chk.summary;
  modal(html`<h3>Резервная копия от ${new Date(s.exportedAt).toLocaleString('ru-RU')}</h3>
    <p class="muted small">Файл цел (контрольная сумма и число записей совпали)${s.appVersion ? `, версия приложения ${esc(s.appVersion)}` : ''}.</p>
    <ul class="small">${s.profiles.map(p => html`<li><b>${esc(p.name)}</b>: отметок ${p.marks} (знаю ${p.known}), попыток ${p.attempts}, заметок ${p.notes}</li>`)}</ul>
    <p class="small">Как восстановить? Перед записью будет сохранён снимок текущих данных.</p>
    <div class="list">
      <button class="btn primary" data-act="full-restore-merge">Добавить недостающее (совпадающее пропускается, отличающееся не заменяется)</button>
      <button class="btn" data-act="full-restore-new">Восстановить в новые профили (ничего не менять)</button>
      <button class="btn" data-close>Отмена</button>
    </div>`);
}

/* ---------- обработчики ---------- */
async function onViewClick(ev) {
  const closer = ev.target.closest('[data-close]');
  if (closer && !closer.hasAttribute('data-act')) { closeModal(); return; }
  const b = ev.target.closest('[data-act]'); if (!b) return;
  const { act, id } = b.dataset;
  if (b.closest('#menu')) return;                              // меню обрабатывается отдельно
  if (await onSafetyAct(act, b)) return;
  if (act === 'profiles') return openProfiles();
  if (act === 'goto') { ev.preventDefault(); closeModal(); return go(id); }
  if (act.startsWith('rc-')) return onRestoreAct(act, b);
  if (act === 'mat-kind' || act === 'mat-level') {
    const m = await getMaterial();
    if (act === 'mat-kind') m.kind = id;
    else { const set = new Set(m.levels || []); set.has(id) ? set.delete(id) : set.add(id); m.levels = [...set].sort((x, y) => x.localeCompare(y, 'en', { numeric: true })); }
    await setMaterial(m); return render();
  }
  if (act === 'start') return startFromHome('recall');
  if (act === 'resume') return resumeDrill();
  if (act === 'start-quiz') return startFromHome('quiz');
  if (act === 'mat-words') { state.lessonId = '__mat__'; return render(); }
  if (act === 'word') return openWord(id, b.dataset.link);
  if (act === 'volume') { state.volume = id; return render(); }
  if (act === 'lesson' || act === 'open-hsk') { state.lessonId = id; state.drill = null; $('#search-results').hidden = true; return render(); }
  if (act === 'back') { state.lessonId = null; state.drill = null; return render(); }
  if (act === 'say') { speech.speak(b.dataset.text, { slow: !!b.dataset.slow }); return; }
  if (act === 'tok') return openTok(b.dataset.ex, Number(b.dataset.i));
  if (act === 'pop-close') return closePop();
  if (act === 'voice-try') { speech.speak('你好，妈麻马骂', { voiceUri: b.dataset.uri || null }); return; }   // тоны 1–4
  if (act === 'voice-pick' || act === 'voice-auto') {
    const p = act === 'voice-pick' ? { uri: b.dataset.uri, name: b.dataset.name, lang: b.dataset.lang } : null;
    await db.metaSet('voicePref', p); speech.setPreferred(p);
    const box = $('#voice-box'); if (box) box.innerHTML = '<summary>Голос</summary>' + voicePicker();
    toast(p ? 'Голос выбран: ' + p.name : 'Голос выбирается автоматически'); return;
  }
  if (act === 'speech-report-refresh' || act === 'speech-report-copy') {
    const ta = $('#speech-report'); if (!ta) return;
    ta.value = speech.report({ version: BUILD + ' · ' + (((await caches.keys().catch(() => [])).find(k => SHELL_RE.test(k)) || '').replace(SHELL_RE, 'оболочка $1')) });
    if (act === 'speech-report-refresh') return;
    try { await navigator.clipboard.writeText(ta.value); toast('Отчёт скопирован'); }
    catch { ta.focus(); ta.select(); toast('Выделено — нажмите «Скопировать» в меню', 4000); }
    return;
  }
  if (act === 'update-app') {
    toast('Загружается новая версия…', 6000);
    const reg = await navigator.serviceWorker?.getRegistration().catch(() => null);
    try { await reg?.update(); } catch {}
    setTimeout(() => location.reload(), 1500);                   // данные в IndexedDB не затрагиваются
    return;
  }
  if (act === 'ex-say') { const x = exCache.get(b.dataset.ex); if (x) speech.speak(x.zh, { slow: !!b.dataset.slow }); return; }
  if (act === 'ex-practice') return startSentenceDrill(id);
  if (act === 'tok-practice') {
    if (!(await ensureEntry(id, b.dataset.pack))) return toast('Слово не скачано — нужна сеть', 4000);
    closePop(); closeModal(); $('#search-results').hidden = true;
    return startDrill('__word__', 'recall', { ids: [id], from: state.lessonId ? 'lesson' : state.view });
  }
  if (act === 'tok-review') { await store.addToReview(id); toast('Добавлено к повторению'); return; }
  if (act === 'mark') {
    try { await store.setMark(id, b.dataset.mark); }
    catch { return; }                                           // ошибку покажет индикатор записи
    b.parentElement.querySelectorAll('[data-act="mark"]').forEach(x => x.setAttribute('aria-pressed', String(x.dataset.mark === b.dataset.mark)));
    state.dirty = true; return;
  }
  if (act === 'confirm-link') { await cat.confirmLink(id); toast('Строка отмечена как сверенная'); return render(); }
  if (act === 'confirm-lesson') {
    const src = prompt('Чем сверяли? Например: «上册, стр. 68–69, фото 2026-09-23»');
    if (src === null) return;
    try { await cat.markLessonConfirmed(id, src); toast('Урок отмечен как сверенный'); }
    catch (e) { toast(e.message, 4000); }
    return render();
  }
  if (act === 'goto-checks') { ev.preventDefault(); return openChecks(); }
  if (act === 'drill') return startDrill(id, 'recall');
  if (act === 'quiz') return startDrill(id, 'quiz');
  if (act === 'reveal') {
    const d = state.drill; if (!d || d.revealed || d.mode === 'quiz') return;
    d.revealed = true;
    if (autoSpeakOn && d.say) speech.speak(d.say);           // из самого нажатия — так требует Safari на iPhone
    return renderDrill();
  }
  if (act === 'goto-review') { closeModal(); state.drill = null; await db.metaSet(drillKey(), null).catch(() => {}); return go('review'); }
  if (act === 'pick-material') { closeModal(); state.drill = null; state.view = 'home'; await render(); setTimeout(() => document.querySelector('.seg, #mat-lesson')?.scrollIntoView({ block: 'center' }), 50); return toast('Выберите урок или уровень, затем «Начать»', 3500); }
  if (act === 'retry-nolimit') { closeModal(); const r = state.retry; state.retry = null; return r && startDrill(r.scope, r.mode, { ids: r.ids, from: r.from, newLimit: Infinity }); }
  if (act === 'again') {
    const d = state.drill; state.drill = null;
    if (!d) return render();
    if (d.mode === 'sentence') return startSentenceDrill(d.sentenceOf);
    const newLimit = d.from === 'home' && !b.dataset.nolimit ? await store.newLeftToday() : Infinity;
    return startDrill(d.scope, d.mode, { ids: d.pool, from: d.from, newLimit });
  }
  if (act === 'stop-drill') {
    const d = state.drill; if (!d?.finished) await store.endSession();
    // «Закончить»: ответы уже записаны; незавершённая порция сохраняется — на главной «Продолжить занятие»
    if (d && d.mode !== 'sentence') { if (d.finished) await db.metaSet(drillKey(), null).catch(() => {}); else await saveDrill(d.revealed ? 0 : 0); }
    state.drill = null;
    if (d?.from === 'lesson' && d.lessonId) state.lessonId = d.lessonId; else if (d?.from === 'home') state.view = 'home';
    return render();
  }
  if (act === 'grade') {
    const d = state.drill; if (!d || b.disabled || d.busy) return;
    const ok = b.dataset.ok === '1', almost = b.dataset.ok === 'half';
    d.busy = true; view.querySelectorAll('[data-act="grade"]').forEach(x => { x.disabled = true; });
    const sent = d.mode === 'sentence' ? d.items[d.i] : null;
    const dir = d.dir || 'hz', entryId = sent ? sent.tid : d.ids[d.i];
    try { await store.recordAttempt({ entryId, lessonId: d.lessonId, correct: ok, almost, mode: sent ? 'sentence' : P.DIRS[dir].mode, answer: sent ? sent.id : '', ms: Date.now() - d.t0 }); }
    catch { d.busy = false; view.querySelectorAll('[data-act="grade"]').forEach(x => { x.disabled = false; }); return; }  // не записалось — ответ можно повторить
    ok ? d.right++ : almost ? d.almost++ : d.wrong++;
    if (!sent) {
      d.log?.push({ id: entryId, dir, res: ok ? 'ok' : almost ? 'almost' : 'bad' });
      if (!ok && !almost && !d.again.includes(entryId)) { d.again.push(entryId); d.ids.push(entryId); d.dirs.push('hz'); }   // «не знаю» — ещё раз в конце занятия
    }
    d.i++; d.revealed = false; d.t0 = Date.now(); d.busy = false; saveDrill(); return renderDrill();
  }
  if (act === 'answer') {
    const d = state.drill; if (!d || d.busy || (d.fb && d.fb.i === d.i)) return;
    const target = d.ids[d.i], correct = id === target, dir = d.dirs?.[d.i] || 'hz';
    d.busy = true; view.querySelectorAll('[data-act="answer"]').forEach(x => { x.disabled = true; });
    try { await store.recordAttempt({ entryId: target, lessonId: d.lessonId, correct, mode: dir === 'au' ? 'quiz-au' : 'quiz', answer: id, ms: Date.now() - d.t0 }); }
    catch { d.busy = false; view.querySelectorAll('[data-act="answer"]').forEach(x => { x.disabled = false; }); return; }
    correct ? d.right++ : d.wrong++;
    d.log?.push({ id: target, dir, res: correct ? 'ok' : 'bad', chosen: id });
    const chosenEntry = correct ? null : await cat.getEntry(id);
    const pair = correct ? null : d.opts?.[d.i]?.partners.find(p => p.entry.id === id)?.note || null;   // объяснение — только для проверенной пары
    if (!correct && !d.again.includes(target)) { d.again.push(target); d.ids.push(target); d.dirs.push(dir); }
    d.fb = { i: d.i, chosen: id, correct, chosenEntry, pair };
    saveDrill(1);                                                 // ответ записан: при продолжении — следующее слово
    if (autoSpeakOn) speech.speak(d.say);                        // из нажатия: после ответа слово звучит
    d.busy = false; return renderDrill();
  }
  if (act === 'next') {
    const d = state.drill; if (!d || !d.fb || d.fb.i !== d.i) return;
    d.i++; d.t0 = Date.now(); d.fb = null; saveDrill(); return renderDrill();
  }
  if (act === 'add-word') return openAddWord(id);
  if (act === 'import-lesson') return openImport({ lessonId: id, collectionId: cat.TEXTBOOK_ID });
  if (act === 'import-hsk') return openImport({ lessonId: null, collectionId: cat.HSK_ID });
  if (act === 'download') return doDownload(id, b);
  if (act === 'download-all') return doDownloadAll(b);
  if (act === 'goto-hsk') return go('hsk');
  if (act === 'precache') return doPrecache();
  if (act === 'export') return doExport();
  if (act === 'export-all') {
    const how = await saveJSONFile(`hanzi-hsk123-все-данные-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.json`, JSON.stringify(await recover.deviceDump(), null, 1));
    return toast(how === 'cancelled' ? 'Файл не сохранён' : how === 'shared' ? 'Выберите «Сохранить в Файлы»' : 'Файл сохранён в загрузки');
  }
  if (act === 'import-backup') return openImportBackup();
  if (act === 'use-profile') { await store.setProfile(id); closeModal(); toast('Профиль переключён'); if (state.view === 'restore') state.rc = null; return render(); }
  if (act === 'new-profile') {
    const name = prompt('Название профиля'); if (!name) return;
    const p = await store.createProfile(name); await store.setProfile(p.id); closeModal(); return render();
  }
  if (act === 'migrate-preview') {
    const r = await migrate.migrate({ dryRun: true });
    return modal(html`<h3>Проверка переноса</h3>
      <p>Найдено профилей: ${r.profiles.length}. Слов опознано: <b>${r.matched}</b>, не опознано: <b>${r.unmatched}</b>.</p>
      <ul class="small">${r.profiles.map(p => html`<li>${esc(p.name)}: версия v${p.version}, записей ${p.found}, опознано ${p.moved}${p.skipped ? `, не опознано ${p.skipped}` : ''}</li>`).join('')}</ul>
      ${r.unmatched ? html`<p class="muted small">Не опознаны, например: ${esc(r.unmatchedSamples.join(', '))}. Таких слов нет в текущем словаре HSK; их исходные записи остаются в резервной копии.</p>` : ''}
      <p class="muted small">Ничего не записано и не удалено.</p><button class="btn" data-close>Закрыть</button>`);
  }
  if (act === 'migrate-run') {
    closeModal();
    const r = await migrate.migrate();
    toast(`Перенесено ${r.written}, уже было ${r.already}, не опознано ${r.unmatched}. ${r.backupReused ? 'Копия старых данных уже была сохранена.' : 'Копия старых данных сохранена.'}`);
    return render();
  }
  if (act === 'remove-demo') { const n = await cat.removeDemo(); toast(`Демо-набор удалён (${n} связей)`); return render(); }
  if (b.hasAttribute('data-close')) closeModal();
}

async function onViewChange(ev) {
  if (ev.target.dataset?.mode === 'new-limit') { await store.setNewPerDay(ev.target.value); return render(); }
  if (ev.target.dataset?.mode === 'autospeak') { autoSpeakOn = ev.target.checked; await db.metaSet('autoSpeak', ev.target.checked); return; }
  if (ev.target.dataset?.mode === 'rc-src') { const s = state.rc.sel; ev.target.checked ? s.add(ev.target.dataset.id) : s.delete(ev.target.dataset.id); return render(); }
  if (ev.target.dataset?.mode === 'rc-target') { state.rc.target = ev.target.value; return render(); }
  if (ev.target.dataset?.mode === 'rc-file') {
    const f = ev.target.files?.[0]; if (!f) return;
    try {
      const raw = recover.rawFromFile(JSON.parse(await f.text()));
      await db.put('backups', { id: 'legacy-file:' + (await import('./model.js')).checksum(raw), kind: 'legacy-file', createdAt: new Date().toISOString(), name: f.name, raw });
      state.rc.sel = null; await rcScan(); toast('Файл прочитан и сохранён в приложении');
    } catch (e) { toast('Файл не принят: ' + (e?.message || e), 6000); }
    return render();
  }
  const input = ev.target.closest('input[type=file]'); if (!input) return;
  const file = input.files?.[0]; if (!file) return;
  const text = await file.text();
  const mode = input.dataset.mode;
  try {
    if (mode === 'legacy') {
      const source = migrate.parseLegacyDump(JSON.parse(text));
      const r = await migrate.migrate({ source });
      input.value = '';
      modal(html`<h3>Старый прогресс перенесён</h3>
        <p>Записано ${r.written}, уже было ${r.already}, не опознано ${r.unmatched}.</p>
        <ul class="small">${r.profiles.map(p => html`<li>${esc(p.name)}: v${p.version}, записей ${p.found}, перенесено ${p.moved}, уже было ${p.already}</li>`).join('')}</ul>
        <p class="muted small">${r.backupReused ? 'Такая копия уже была сохранена раньше.' : 'Исходные данные сохранены копией в базе.'}</p><button class="btn" data-close>Закрыть</button>`);
      return render();
    }
    if (mode === 'book-words') {
      input.value = '';
      let data; try { data = JSON.parse(text); } catch { throw new Error('файл не разбирается как JSON'); }
      const r = await cat.importBookWords(data, { name: file.name });
      toast(r.count ? `Словарь учебника загружен: ${r.count} слов уроков` : 'Словарь учебника уже загружен — без изменений', 5000);
      return render();
    }
    if (mode === 'full-backup') {
      input.value = '';
      let obj; try { obj = JSON.parse(text); } catch { throw new Error('файл не разбирается как JSON'); }
      return previewRestore(obj);
    }
    if (mode === 'transfer') {
      input.value = '';
      const obj = JSON.parse(text);
      const r = await store.importTransfer(obj);
      const st = r.stats;
      // прогресс прежней однофайловой версии, который на старом адресе так и остался в localStorage
      const legacySrc = migrate.legacyFromDump(obj);
      const lg = legacySrc ? await migrate.migrate({ source: legacySrc, profileMap: migrate.legacyProfilesInDump(obj) }) : null;
      if (lg) await store.focusFilled(lg.profiles.map(p => p.profileId));
      const lgMarks = lg ? lg.written + lg.already : 0;
      const found = st.progress + st.duplicates + st.keptNewer + lgMarks + st.attempts + st.notes + st.journal;
      modal(html`<h3>${found ? 'Данные перенесены' : 'В файле нет отметок для переноса'}</h3>
        <p>Файл: ${esc(r.kind)}${r.from ? ` с ${esc(r.from)}` : ''}${r.exportedAt ? `, от ${esc(new Date(r.exportedAt).toLocaleString('ru-RU'))}` : ''}.</p>
        <p class="small">Профили: ${esc(r.names.join(', ') || '—')} (новых ${st.profiles}, дополнено ${st.merged})</p>
        <p class="small">Записано: отметки ${st.progress} · попытки ${st.attempts} · заметки ${st.notes} · дневник ${st.journal} · занятия ${st.sessions}${st.entries ? ` · свои слова ${st.entries}` : ''}</p>
        ${lg ? html`<p class="small">Прежняя версия (старые ключи): записано ${lg.written}, уже было ${lg.already}, не опознано ${lg.unmatched}.</p>
          <ul class="small">${lg.profiles.map(p => html`<li>${esc(p.name)}: отметок в файле ${p.found}, перенесено ${p.moved}, уже было ${p.already}</li>`).join('')}</ul>` : ''}
        <p class="muted small">Уже были: ${st.duplicates}; оставлены более новые здешние записи: ${st.keptNewer}. Копия прежних данных этого адреса сохранена${lg ? '; старые ключи сохранены копией в базе' : ''}.</p>
        <button class="btn" data-close>Закрыть</button>`);
      return render();
    }
    if (mode === 'backup') {
      const obj = JSON.parse(text);
      const problems = store.verifyBackup(obj);
      if (problems.length) return modal(html`<h3>Копия не принята</h3><p class="err">${esc(problems.join('; '))}</p><button class="btn" data-close>Закрыть</button>`);
      const target = input.dataset.target || 'new';
      if (target === 'current') await backup.snapshot('pre-backup-restore', 'перед загрузкой копии профиля в текущий профиль');   // откат возможен
      const res = await store.importBackup(obj, { into: target, name: target === 'test' ? 'Тестовый профиль' : null });
      closeModal();
      return modal(html`<h3>Копия загружена</h3><p>Профиль: <b>${esc(res.profile.name)}</b></p>
        <p class="small">Прогресс ${res.stats.progress} · попытки ${res.stats.attempts} · заметки ${res.stats.notes} · дневник ${res.stats.journal} · сессии ${res.stats.sessions} · пропущено дублей ${res.stats.duplicates}</p>
        <p class="muted small">Текущий профиль не изменён.</p><button class="btn" data-close>Закрыть</button>`);
    }
    const report = await cat.importWordFile(text, { lessonId: input.dataset.lesson || null, collectionId: input.dataset.collection, sourceLabel: 'import', filename: file.name });
    closeModal();
    toast(`Импортировано слов: ${report.entries}, связей: ${report.newLinks ?? report.links}`);
    if (report.issues.length) {
      modal(html`<h3>Импорт завершён с замечаниями</h3><p>Принято слов: ${report.entries}. Строк с проблемами: ${report.issues.length}.</p>
        <table><tbody>${report.issues.slice(0, 15).map(i => html`<tr><td>стр. ${i.line}</td><td>${esc(i.hanzi)}</td><td class="err">${esc(i.problems.join(', '))}</td></tr>`)}</tbody></table>
        <button class="btn" data-close>Закрыть</button>`);
    }
    render();
  } catch (e) { modal(html`<h3>Ошибка импорта</h3><p class="err">${esc(e.message)}</p><button class="btn" data-close>Закрыть</button>`); }
}

async function onViewSubmit(ev) {
  const form = ev.target.closest('form[data-form]'); if (!form) return;
  ev.preventDefault();
  const fd = Object.fromEntries(new FormData(form).entries());
  const kind = form.dataset.form;
  if (kind === 'lesson-note' || kind === 'entry-note') {
    noteTimers.set(form, 0);                       // принудительно записать немедленно
    await flushNote(form);
    if (kind === 'entry-note' && form.querySelector('.note-status')?.dataset.state === 'saved') closeModal();
    return;
  }
  if (kind === 'journal') {
    if (!fd.understood && !fd.notUnderstood && !fd.toReview) return toast('Пустая запись');
    clearTimeout(draftTimers.get(form)); draftTimers.delete(form);
    try {
      await store.addJournal(fd);
      await db.metaSet(draftKey(), null);
      toast('Запись в дневнике сохранена на устройстве');
    } catch (e) { setNoteStatus(form, 'error', 'Не сохранено: ' + db.storageErrorText(e)); return; }
    return render();
  }
  if (kind === 'add-word') {
    if (!fd.hanzi?.trim()) return toast('Нужен иероглиф');
    await cat.addWord(fd, { lessonId: form.dataset.id || null, collectionId: form.dataset.collection || cat.TEXTBOOK_ID, source: 'user:ручной ввод' });
    closeModal(); toast('Слово добавлено'); return render();
  }
}

/* ---------- диалоги ---------- */
async function openProfiles() {
  const profiles = await store.listProfiles();
  const cur = store.profileId();
  modal(html`<h3>Профиль</h3>
    <p class="muted small">Прогресс, заметки и дневник хранятся отдельно для каждого профиля.</p>
    <div class="list">${profiles.map(p => html`<div class="spread card tight">
      <span>${esc(p.name)} ${p.kind === 'test' ? '<span class="badge">тестовый</span>' : ''} ${p.id === cur ? '<span class="badge confirmed">текущий</span>' : ''}</span>
      <button class="btn sm" data-act="use-profile" data-id="${p.id}">Выбрать</button></div>`)}</div>
    <div class="row" style="margin-top:10px"><button class="btn sm" data-act="new-profile">Новый профиль</button><button class="btn sm" data-close>Закрыть</button></div>`);
}

function openAddWord(lessonId) {
  modal(html`<h3>Новое слово</h3>
    <form data-form="add-word" data-id="${lessonId || ''}" data-collection="${lessonId && lessonId.startsWith('hsk') ? cat.HSK_ID : cat.TEXTBOOK_ID}">
      <label class="field"><span>汉字</span><input name="hanzi" type="text" required></label>
      <label class="field"><span>Пиньинь с тонами</span><input name="pinyin" type="text" placeholder="nǐ hǎo"></label>
      <label class="field"><span>Перевод</span><input name="ru" type="text"></label>
      <label class="field"><span>Значение (чтобы не сливать омонимы)</span><input name="sense" type="text" placeholder="напр. «играть на скрипке»"></label>
      <label class="field"><span>Страница учебника</span><input name="page" type="text"></label>
      <div class="row"><button class="btn primary" type="submit">Добавить</button><button class="btn" type="button" data-close>Отмена</button></div>
    </form>`);
}
async function openChecks() {
  const rows = await cat.pendingChecks();
  if (!rows.length) return toast('Непроверенных строк нет');
  modal(html`<h3>Строки на проверке</h3>
    <p class="muted small">Эти строки импортированы с пометкой confidence=low и ещё не сверены с книгой. Приложение само изображения не распознаёт: пометку ставит тот, кто готовил CSV. Исправлять можно прямо в уроке.</p>
    <div class="list">${rows.slice(0, 40).map(r => html`<div class="spread card tight">
      <span>${esc(r.entry.hanzi)} <span class="muted">${esc(r.entry.pinyin)}</span> — ${esc(r.entry.ru)}<br>
      <span class="meta">第${r.lesson.number}课${r.link.page ? ', стр. ' + esc(r.link.page) : ''}</span></span>
      <button class="btn sm" data-act="confirm-link" data-id="${r.link.id}">Сверено</button></div>`)}</div>
    <button class="btn" data-close>Закрыть</button>`);
}

function openImport({ lessonId, collectionId }) {
  modal(html`<h3>Импорт слов</h3>
    <p class="muted small">CSV с колонками <code>lesson,hanzi,pinyin,ru,pos,sense,page,confidence,example,example_pinyin,example_ru</code>. Колонка <code>confidence</code> со значением <code>low</code> помечает строку как неуверенную — такая строка попадёт в проверку и не даст отметить урок сверенным. или JSON (в том числе формат <code>{k,h,p,r,l}</code> из опубликованной версии).
    ${lessonId ? 'Колонка lesson не обязательна: всё уйдёт в открытый урок.' : 'Номер урока берётся из колонки lesson.'}</p>
    <input type="file" accept=".csv,.json,.txt" data-mode="words" data-lesson="${lessonId || ''}" data-collection="${collectionId}">
    <p class="muted small">Существующие слова не дублируются: совпадение по иероглифу, чтению и помеченному значению.</p>
    <button class="btn" data-close>Закрыть</button>`);
}
function openImportBackup() {
  modal(html`<h3>Загрузить резервную копию</h3>
    <label class="field"><span>Куда импортировать</span>
      <select id="imp-target"><option value="new">в новый профиль (безопасно)</option><option value="test">в чистый тестовый профиль</option><option value="current">в текущий профиль</option></select></label>
    <input type="file" accept=".json" data-mode="backup" data-target="new" id="imp-file">
    <p class="muted small">Повторная загрузка того же файла не создаёт дублей.</p>
    <button class="btn" data-close>Закрыть</button>`);
  $('#imp-target').addEventListener('change', e => { $('#imp-file').dataset.target = e.target.value; });
}

/* ---------- действия ---------- */
async function doExport() {
  const backup = await store.exportBackup();
  // на iPhone в приложении с экрана «Домой» — через «Поделиться» → «Сохранить в Файлы»
  const how = await saveJSONFile(`hanzi-hsk123-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(backup, null, 2));
  toast(how === 'cancelled' ? 'Копия не сохранена' : how === 'shared' ? 'Выберите «Сохранить в Файлы»' : 'Копия сохранена в загрузки');
  render();
}

async function doDownload(packId, button) {
  const packs = await cat.hskPacks();
  const pack = packs.find(p => p.id === packId); if (!pack) return;
  const slot = view.querySelector(`.progress-slot[data-pack="${packId}"]`);
  button.disabled = true; button.textContent = 'Скачиваю…';
  try {
    const res = await cat.downloadPack(pack, {
      onProgress: ({ done, total }) => { if (slot) slot.innerHTML = `<progress value="${done}" max="${total}"></progress><span class="muted small">${done} / ${total}</span>`; }
    });
    toast(`${pack.title}: ${res.count} слов доступно офлайн`);
  } catch (e) {
    toast('Не скачалось: ' + e.message, 5000);
  } finally { render(); }
}

async function doDownloadAll(button) {
  const packs = await cat.hskPacks();
  const slot = view.querySelector('.progress-slot[data-pack="__all__"]');
  button.disabled = true;
  let ok = 0, failed = [];
  for (const pack of packs) {
    if (slot) slot.innerHTML = `<span class="muted small">${esc(pack.title)}…</span>`;
    try { await cat.downloadPack(pack, { onProgress: ({ done, total }) => { if (slot) slot.innerHTML = `<progress value="${done}" max="${total}"></progress><span class="muted small">${esc(pack.title)}: ${done} / ${total}</span>`; } }); ok++; }
    catch (e) { failed.push(`${pack.title}: ${e.message}`); }
  }
  toast(failed.length ? `Скачано наборов: ${ok}. Не удалось: ${failed.length}` : `Готово: ${ok} наборов доступны офлайн`, 5000);
  render();
}

/** Честный статус офлайна: регистрация есть, страница под управлением воркера, оболочка в кэше. */
async function offlineStatus() {
  if (!('serviceWorker' in navigator)) return { ok: false, text: 'нет: браузер или среда публикации не даёт service worker' };
  if (!window.isSecureContext) return { ok: false, text: 'нет: нужен https:// (или localhost)' };
  if (swError) return { ok: false, text: 'нет: service worker не зарегистрирован — ' + swError };
  const reg = await navigator.serviceWorker.getRegistration().catch(() => null);
  if (!reg) return { ok: false, text: 'нет: service worker ещё не зарегистрирован' };
  const cached = await caches.match('./index.html').catch(() => null);
  if (!cached) return { ok: false, text: 'пока нет: файлы ещё не сохранены — нажмите «Подготовить офлайн-режим»' };
  if (!navigator.serviceWorker.controller) return { ok: false, text: 'почти: файлы сохранены, перезагрузите страницу один раз' };
  return { ok: true, text: 'да' };
}

async function doPrecache() {
  if (!('serviceWorker' in navigator)) return toast('Этот браузер не поддерживает офлайн-кэш');
  const reg = await navigator.serviceWorker.getRegistration() || await navigator.serviceWorker.register('sw.js');
  await navigator.serviceWorker.ready;
  (reg.active || navigator.serviceWorker.controller)?.postMessage({ type: 'precache' });
  toast('Интерфейс сохранён для работы без сети');
  setTimeout(render, 600);
}

async function maybeOfferMigration() {
  if (!migrate.hasLegacy()) return;
  if (await migrate.migratedAt() || await recover.lastReport(store.profileId())) return;
  modal(html`<h3>Найден прогресс прежней версии</h3>
    <p class="muted small">В этом браузере есть данные старого приложения. Можно посмотреть, что найдено, сохранить копию и вернуть отметки в ваш профиль. Ничего не удаляется.</p>
    <div class="row"><button class="btn primary" data-act="goto" data-id="restore">Посмотреть и восстановить</button><button class="btn" data-close>Позже</button></div>`);
}

/* ---------- восстановление прежнего прогресса ---------- */
const MARK_SHORT = { known: 'знаю', learning: 'учу', hard: 'не знаю', new: 'новое' };
const levelName = (id) => /^hsk/.test(id || '') ? 'HSK ' + LEVEL_LABEL(id) : (id || 'другое');
const fmtDate = (ms) => ms ? new Date(ms).toLocaleString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'дата неизвестна';
const countsLine = (c) => `знаю <b>${c.known}</b> · учу <b>${c.learning}</b> · не знаю <b>${c.hard}</b> · всего ${c.total}`;
const levelsLine = (c) => Object.entries(c.byLevel).sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true }))
  .map(([lv, x]) => `${levelName(lv)}: ${x.known} / ${x.learning} / ${x.hard}`).join(' · ');

async function rcScan(extra = null) {
  const rc = state.rc || (state.rc = { sel: null, target: store.profileId(), copied: false, result: null });
  rc.error = null;
  try { rc.scan = await recover.scan(extra || rc.extra || {}); }
  catch (e) { rc.error = String(e?.message || e); rc.scan = null; }
  if (rc.scan && !rc.sel) rc.sel = new Set(rc.scan.sources.filter(s => s.defaultOn).map(s => s.id));
  try { rc.dump = JSON.stringify(await recover.deviceDump(), null, 1); } catch (e) { rc.dump = null; rc.error = rc.error || String(e?.message || e); }
}

async function renderRestore() {
  if (!state.rc || !state.rc.scan) {
    view.innerHTML = html`<h1>Восстановить прежний прогресс</h1><p class="lede">Ищу прежние данные на этом устройстве… Первый раз загружается словарь, это может занять до минуты.</p>`;
    await rcScan();
    if (state.view !== 'restore') return;                        // пока искали, пользователь ушёл на другой экран
  }
  const rc = state.rc, sc = rc.scan;
  if (!rc.target || !(await db.get('profiles', rc.target))) rc.target = store.profileId();
  const conflicts = await recover.listConflicts(rc.target);
  const r = rc.result;
  const src = sc ? sc.sources : [];
  const selected = src.filter(x => rc.sel.has(x.id) && x.profileId !== rc.target);
  view.innerHTML = html`
    <h1>Восстановить прежний прогресс</h1>
    <p class="lede">Поиск идёт только на этом устройстве, ничего не удаляется и не отправляется на сервер.</p>
    <p class="muted small">Сейчас сайт открыт ${sc?.standalone ? 'как приложение со значка на экране «Домой»' : 'в браузере'}. На iPhone Safari и значок на экране «Домой» хранят данные раздельно: если здесь пусто, откройте этот пункт и во втором месте.</p>
    ${rc.error ? html`<p class="err">${esc(rc.error)}</p>` : ''}
    ${sc?.dictFailed?.length ? html`<p class="err">Словарь загружен не полностью (${esc(sc.dictFailed.join(', '))}) — подключитесь к сети и нажмите «Искать заново». Без словаря отметки не сопоставить со словами.</p>` : ''}

    <div class="card">
      <h3>Найдено</h3>
      ${src.length ? html`<div class="list">${src.map(x => html`<label class="card tight rc-src">
        <span class="spread"><span><input type="checkbox" data-mode="rc-src" data-id="${esc(x.id)}" ${rc.sel.has(x.id) ? 'checked' : ''} ${x.profileId === rc.target ? 'disabled' : ''}>
          <b>${esc(x.name)}</b></span>${x.kind === 'profile' ? html`<button class="btn sm" data-act="use-profile" data-id="${x.profileId}">Сделать текущим</button>` : ''}</span>
        <span class="muted small">${esc(x.kind === 'legacy' ? 'прежняя версия, ' : x.kind === 'legacy-backup' ? 'запасная запись прежней версии, ' : '')}${esc(x.where)} · ${esc(fmtDate(x.lastMs))}${x.version ? ` · формат v${x.version}` : ''}${x.attempts ? ` · ответов ${x.attempts}` : ''}</span>
        <span class="small">${countsLine(x.counts)}</span>
        ${x.counts.total ? html`<span class="muted small">по уровням (знаю / учу / не знаю): ${esc(levelsLine(x.counts))}</span>` : ''}
        ${x.unknown.length ? html`<span class="muted small">Не опознано ключей: ${x.unknown.length} (${esc(x.unknown.slice(0, 6).map(u => u.key).join(', '))}) — сохранятся в отчёте</span>` : ''}
        ${x.alsoIn.length ? html`<span class="muted small">То же самое есть: ${esc(x.alsoIn.join('; '))}</span>` : ''}
      </label>`)}</div>` : html`<p>Прежних отметок здесь не найдено.</p>`}
      <p class="muted small" style="margin-top:8px">Проверено: localStorage этого ${sc?.standalone ? 'приложения' : 'браузера'} — ключей ${sc?.localKeyCount ?? 0}${sc?.legacyKeys?.length ? ` (прежней версии: ${esc(sc.legacyKeys.join(', '))})` : ', ключей прежней версии нет'}; копий в базе приложения: ${sc?.copies ?? 0}; профилей: ${sc?.profiles?.length ?? 0}.${sc?.otherKeys?.length ? ` Другие ключи: ${esc(sc.otherKeys.map(k => k.key).join(', '))}.` : ''}</p>
      <div class="row"><button class="btn sm" data-act="rc-rescan">Искать заново</button>
        <label class="btn sm">Загрузить файл выгрузки<input type="file" accept=".json,application/json" data-mode="rc-file" hidden></label></div>
    </div>

    <div class="card">
      <h3>Профили в приложении</h3>
      <div class="list">${(sc?.profiles || []).map(p => html`<div class="card tight">
        <span class="spread"><span>${esc(p.name)} ${p.current ? '<span class="badge confirmed">текущий</span>' : ''}${p.kind === 'test' ? ' <span class="badge">тестовый</span>' : ''}</span>
        ${p.current ? '' : html`<button class="btn sm" data-act="use-profile" data-id="${p.id}">Сделать текущим</button>`}</span>
        <span class="small">${countsLine(p.counts)}${p.attempts ? ` · ответов ${p.attempts}` : ''}</span></div>`)}</div>
    </div>

    <div class="card">
      <h3>Вернуть отметки</h3>
      <label class="field"><span>В профиль</span><select data-mode="rc-target">
        ${(sc?.profiles || []).filter(p => p.kind !== 'test').map(p => html`<option value="${p.id}" ${p.id === rc.target ? 'selected' : ''}>${esc(p.name)}${p.current ? ' (текущий)' : ''} — отмечено ${p.counts.total}</option>`)}
        <option value="__new">Новый профиль «Прежний прогресс»</option></select></label>
      <p class="muted small">Новые отметки в этом профиле сохраняются. Если слово отмечено по-разному, остаётся более новая отметка; если дат нет или неясно, какая новее, слово попадёт в список «Выбрать» ниже — ничего не затирается.</p>
      <div class="row">
        <button class="btn" data-act="rc-copy" ${rc.dump ? '' : 'disabled'}>1. Сохранить копию всех данных</button>
        <button class="btn primary" data-act="rc-run" ${rc.copied && selected.length && !sc?.dictFailed?.length ? '' : 'disabled'}>2. Восстановить выбранное (${selected.length})</button>
      </div>
      <p class="muted small">${rc.copied ? 'Копия сохранена. ' : 'Сначала сохраните копию: файл .json с прежними и новыми данными. '}Перед восстановлением приложение дополнительно записывает такую же копию внутри себя.</p>
    </div>

    ${r ? html`<div class="card">
      <h3>Результат</h3>
      <p>В профиль «${esc(r.targetName)}»: возвращено <b>${r.added + r.replacedOlder}</b>, совпало ${r.same}, оставлены более новые ${r.keptNewer}, на выбор ${r.conflicts}${r.attempts ? `, ответов из профиля ${r.attempts}` : ''}.</p>
      ${r.unknown.length ? html`<p class="muted small">Не опознано ${r.unknown.length} ключей — записаны в отчёт восстановления: ${esc(r.unknown.slice(0, 10).map(u => u.key).join(', '))}</p>` : ''}
      ${r.packErrors?.length ? html`<p class="err small">Не скачались уровни: ${esc(r.packErrors.join('; '))}. Подключитесь к сети — слова появятся на главной после скачивания.</p>` : ''}
      <div class="row"><button class="btn" data-act="rc-show">Показать возвращённые слова</button>
        ${r.packs?.length ? html`<button class="btn" data-act="rc-levels">Показать на главной: ${esc(r.packs.filter(x => /^hsk/.test(x)).map(levelName).join(', '))}</button>` : ''}</div>
    </div>` : ''}

    ${conflicts.length ? html`<div class="card">
      <h3>Выбрать: ${conflicts.length}</h3>
      <p class="muted small">У этих слов прежняя и нынешняя отметки различаются, а какая новее — неизвестно. Обе версии сохранены.</p>
      <div class="row"><button class="btn sm" data-act="rc-conf-all" data-choice="incoming">Везде взять прежние</button><button class="btn sm" data-act="rc-conf-all" data-choice="current">Везде оставить нынешние</button></div>
      <div class="list">${conflicts.slice(0, 200).map(c => html`<div class="card tight spread">
        <span><b>${esc(c.hanzi)}</b> <span class="muted small">${esc(c.pinyin)} — ${esc((c.ru || '').slice(0, 40))}</span></span>
        <span class="row"><button class="btn sm" data-act="rc-conf" data-id="${esc(c.id)}" data-choice="current">сейчас: ${MARK_SHORT[c.current.status] || c.current.status}</button>
        <button class="btn sm" data-act="rc-conf" data-id="${esc(c.id)}" data-choice="incoming">раньше: ${MARK_SHORT[c.incoming.status]}</button></span></div>`)}</div>
    </div>` : ''}`;
}

async function saveJSONFile(name, text, { share = false } = {}) {
  const file = new File([text], name, { type: 'application/json' });
  const touch = /iPhone|iPad|iPod|Android/.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));
  if ((recover.isStandalone() || (share && touch)) && navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return 'shared'; }
    catch (e) { if (e?.name === 'AbortError') return 'cancelled'; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  return 'downloaded';
}

async function onRestoreAct(act, b) {
  const rc = state.rc;
  if (act === 'rc-rescan') { rc.sel = null; await rcScan(); return render(); }
  if (act === 'rc-copy') {
    if (!rc.dump) return;
    const how = await saveJSONFile(`hanzi-hsk123-все-данные-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.json`, rc.dump);
    if (how === 'cancelled') return toast('Копия не сохранена');
    rc.copied = true;
    toast(how === 'shared' ? 'Выберите «Сохранить в Файлы»' : 'Копия сохранена в загрузки');
    return render();
  }
  if (act === 'rc-run') {
    b.disabled = true;
    try {
      let target = rc.target;
      if (target === '__new') target = (await store.createProfile('Прежний прогресс')).id;
      rc.result = await recover.restore(rc.scan, { sourceIds: [...rc.sel], targetId: target });
      rc.target = target;
      if (store.profileId() !== target) await store.setProfile(target);
      await rcScan();
      toast('Отметки возвращены');
    } catch (e) { toast('Не восстановлено: ' + (e?.message || e), 6000); }
    return render();
  }
  if (act === 'rc-conf' || act === 'rc-conf-all') {
    const ids = act === 'rc-conf' ? [b.dataset.id] : (await recover.listConflicts(rc.target)).map(c => c.id);
    const n = await recover.resolveConflicts(rc.target, ids, b.dataset.choice);
    toast(`Выбор сохранён: ${n}`);
    return render();
  }
  if (act === 'rc-levels') {
    const m = await getMaterial();
    m.kind = 'hsk';
    m.levels = [...new Set([...(m.levels || []), ...rc.result.packs.filter(x => /^hsk/.test(x))])].sort((x, y) => x.localeCompare(y, 'en', { numeric: true }));
    await setMaterial(m);
    return go('home');
  }
  if (act === 'rc-show') {
    const pm = await store.profileProgress();
    const rows = rc.result.restored.map(pk => pm.get(pk.split('::')[1])).filter(Boolean);
    const words = await Promise.all(rows.slice(0, 400).map(async p => ({ p, e: await db.get('entries', p.entryId) })));
    const order = { known: 0, learning: 1, hard: 2, new: 3 };
    words.sort((a, b) => order[a.p.status] - order[b.p.status]);
    return modal(html`<h3>Возвращено: ${rows.length}</h3>
      <div class="list">${words.map(({ p, e }) => html`<div class="spread small"><span><b>${esc(e?.hanzi || '?')}</b> ${esc(e?.pinyin || '')} — ${esc((e?.ru || '').slice(0, 36))}</span><span style="white-space:nowrap"><i class="dot c-${p.status === 'known' ? 'known' : p.status === 'hard' ? 'hard' : 'learning'}"></i>${MARK_SHORT[p.status]}</span></div>`)}</div>
      ${rows.length > 400 ? html`<p class="muted small">Показаны первые 400.</p>` : ''}<button class="btn" data-close>Закрыть</button>`);
  }
}

/* ---------- поиск ---------- */
async function doSearch(q) {
  const box = $('#search-results'), list = $('#search-list');
  if (!q.trim()) { box.hidden = true; return; }
  const found = await cat.search(q);
  box.hidden = false;
  list.innerHTML = found.length
    ? (await Promise.all(found.map(e => wordRow(e)))).join('')
    : `<p class="muted">Ничего не найдено. Если нужный уровень HSK ещё не скачан, выберите его на главной и начните занятие — он скачается.</p>`;
}

boot();
