// Озвучивание голосом устройства (Web Speech API).
// Запуск реплики — как в версии, которая работала на iPhone (до 25.09): cancel(), затем speak() прямо из нажатия,
// без resume() и без повторной постановки в очередь. Голос можно выбрать вручную (сохраняется в настройках).
// Каждое действие и событие синтезатора пишется в короткий журнал — он виден в «Данных» (отчёт для iPhone).
// Правильность произношения синтезатором не доказана: в карточке всегда виден пиньинь.
let voices = [];
let chosen = null;
let pref = null;                  // выбранный пользователем голос { uri, name, lang } или null — «автоматически»
let prefMissing = false;          // выбранный голос на этом устройстве не найден
let notify = () => {};
let seq = 0;
let current = null;               // ссылка на реплику: иначе браузер может собрать её до окончания
const LOG = [];
let lastAction = null;

const now = () => new Date().toISOString().slice(11, 23);
function log(ev, detail = '') {
  LOG.push(`${now()} ${ev}${detail ? ' ' + detail : ''}`);
  if (LOG.length > 30) LOG.shift();
}
const q = () => (typeof speechSynthesis === 'undefined' ? '—' : `speaking=${speechSynthesis.speaking} pending=${speechSynthesis.pending} paused=${speechSynthesis.paused}`);

const BAD = /zh[-_](TW|HK|MO)|yue|cantonese|粤|台灣|香港|臺灣/i;
// Известные женские голоса путунхуа (браузер пол не сообщает — только по имени): Apple Tingting/Lili,
// Microsoft Xiaoxiao/Xiaoyi/Yaoyao/Huihui…, Google «普通话（中国大陆）». Yu-shu — женский, но это Siri (см. ниже).
const FEMALE = /ting-?ting|тин-?тин|婷婷|\blili(an)?\b|莉莉|xiao(xiao|yi|han|mo|rui|xuan|chen|meng|qiu|shuang|zhen)|yaoyao|huihui|yu-?shu|google\s*普通话/i;
export const isFemale = (name) => FEMALE.test(String(name || ''));
const isZh = (v) => /^(zh|cmn)/i.test(String(v.lang || '').replace('_', '-')) && !BAD.test(v.lang || '') && !BAD.test(v.name || '');
function score(v) {
  let s = 0;
  const lang = String(v.lang || '').replace('_', '-');
  if (/^zh-CN$/i.test(lang) || /^cmn-Hans/i.test(lang)) s += 5;
  if (v.localService) s += 4;
  if (v.default) s += 1;
  if (/premium|enhanced|增强|高品质|neural|natural/i.test(v.name)) s += 2;
  if (isFemale(v.name)) s += 3;     // женский голос путунхуа — предпочтительный (как в рабочей версии 638cee3: Ting-Ting, Lili)
  // голоса Siri (Li-mu, Yu-shu) в списке бывают, но веб-страницам могут отдавать тишину — только вручную
  if (/siri|li-?mu|yu-?shu/i.test(v.name) || /siri/i.test(v.voiceURI || '')) s -= 6;
  // «игрушечные» голоса Apple звучат хуже основного
  if (/^(eddy|flo|grandma|grandpa|reed|rocko|sandy|shelley|bad news|bahh|bells|boing|bubbles|cellos|good news|jester|organ|superstar|trinoids|whisper|wobble|zarvox)\b/i.test(v.name)) s -= 4;
  return s;
}
const same = (v, p) => p && (p.uri ? v.voiceURI === p.uri : false) || (p && v.name === p.name && String(v.lang) === String(p.lang));
export function refreshVoices() {
  if (typeof speechSynthesis === 'undefined') { voices = []; chosen = null; return voices; }
  try { voices = speechSynthesis.getVoices() || []; } catch { voices = []; }
  const zh = voices.filter(isZh);
  const mine = pref ? zh.find(v => same(v, pref)) : null;
  prefMissing = !!pref && voices.length > 0 && !mine;
  chosen = mine || zh.map(v => [score(v), v]).sort((a, b) => b[0] - a[0])[0]?.[1] || null;
  return voices;
}
/** Подходящие голоса путунхуа этого устройства, лучшие сверху. local — только то, что сообщает браузер. */
export const zhVoices = () => voices.filter(isZh).map(v => [score(v), v]).sort((a, b) => b[0] - a[0])
  .map(([, v]) => ({ uri: v.voiceURI || '', name: v.name, lang: v.lang, local: v.localService === true, female: isFemale(v.name), chosen: v === chosen }));
export const onMessage = (fn) => { notify = fn || (() => {}); };
/** Выбор пользователя: { uri, name, lang } или null — автоматически. */
export function setPreferred(p) { pref = p && (p.uri || p.name) ? p : null; refreshVoices(); log('voice-pref', pref ? pref.name : 'auto'); }
export const preferred = () => pref;

const NO_VOICE = 'На устройстве нет китайского голоса. iPhone: Настройки → Универсальный доступ → Устный контент → Голоса → Китайский (материковый Китай) — скачайте голос. Текст и пиньинь работают и без звука.';

export function status() {
  if (typeof speechSynthesis === 'undefined') return { ok: false, text: 'Браузер не поддерживает озвучивание — учиться можно по тексту и пиньиню' };
  if (!voices.length) refreshVoices();
  if (!voices.length) return { ok: true, text: 'Список голосов ещё не загружен — будет использован китайский голос системы' };
  if (!chosen) return { ok: false, text: NO_VOICE };
  const miss = prefMissing ? `Выбранный голос «${pref.name}» на этом устройстве недоступен. ` : '';
  return { ok: true, voice: chosen.name, text: `${miss}Голос: ${chosen.name} (${chosen.lang})${chosen.localService === true ? ', по данным браузера — на устройстве' : ''}` };
}

const ERR = {
  'not-allowed': 'Браузер не дал включить звук — нажмите на динамик ещё раз',
  'audio-busy': 'Звук занят другим приложением',
  'audio-hardware': 'Нет доступа к динамику',
  'network': 'Сетевой голос недоступен без интернета',
  'synthesis-unavailable': NO_VOICE, 'language-unavailable': NO_VOICE, 'voice-unavailable': 'Выбранный голос недоступен — выберите другой в «Данных» → «Голос»'
};

/**
 * Произнести китайский текст (иероглифы, не пиньинь). Вызывать прямо из обработчика нажатия.
 * Предыдущая реплика прерывается — обычная и медленная не накладываются; повторное нажатие повторяет.
 * @returns false, если озвучивание невозможно (сообщение уже отправлено в onMessage)
 */
export function speak(text, { slow = false, rate = null, voiceUri = null } = {}) {
  text = String(text || '').trim();
  if (!text) return false;
  if (typeof speechSynthesis === 'undefined' || typeof SpeechSynthesisUtterance === 'undefined') { log('unsupported'); notify(status().text); return false; }
  if (!voices.length || !chosen) refreshVoices();
  const v = voiceUri ? voices.find(x => x.voiceURI === voiceUri) || chosen : chosen;
  if (voices.length && !v) { log('no-zh-voice', `voices=${voices.length}`); notify(NO_VOICE); return false; }
  const my = ++seq;
  lastAction = { at: now(), text, slow: !!slow, voice: v ? `${v.name} (${v.lang})` : 'системный zh-CN' };
  let started = false;
  try {
    speechSynthesis.cancel();                                   // как раньше: всегда, затем сразу speak
    const u = new SpeechSynthesisUtterance(text);
    u.lang = v ? String(v.lang).replace('_', '-') : 'zh-CN';
    if (v) u.voice = v;
    u.rate = rate ?? (slow ? 0.6 : 0.9);
    u.onstart = () => { started = true; log('start', `#${my}`); };
    u.onend = () => { log('end', `#${my}`); if (current === u) current = null; };
    u.onerror = (e) => {
      log('error', `#${my} ${e.error || ''}`);
      if (my !== seq || e.error === 'interrupted' || e.error === 'canceled') return;   // прервали сами
      notify(ERR[e.error] || `Озвучивание не удалось (${e.error || 'ошибка'})`);
    };
    current = u;
    speechSynthesis.speak(u);
    log('speak', `#${my} «${text.slice(0, 20)}» ${lastAction.voice} rate=${u.rate} → ${q()}`);
  } catch (e) { log('exception', String(e?.message || e)); notify('Озвучивание не удалось: ' + (e?.message || e)); return false; }
  // только сообщение и запись в журнал — без повторной постановки в очередь
  setTimeout(() => {
    if (my !== seq || started) return;
    log('no-start', `#${my} за 2,5 с → ${q()}`);
    notify('Звук не начался. Проверьте беззвучный режим и громкость; если повторится — «Данные» → «Отчёт об озвучке».');
  }, 2500);
  return true;
}

export const stop = () => { seq++; try { speechSynthesis.cancel(); } catch {} log('stop'); };

/** Текст отчёта для «Данных»: без прогресса, только сведения об устройстве и озвучке. */
export function report(extra = {}) {
  const has = typeof speechSynthesis !== 'undefined';
  if (has && !voices.length) refreshVoices();
  const zh = zhVoices();
  return [
    `Приложение: ${extra.version || '—'}`,
    `Браузер: ${typeof navigator !== 'undefined' ? navigator.userAgent : '—'}`,
    `Синтез речи: ${has ? 'есть' : 'нет'}${typeof SpeechSynthesisUtterance === 'undefined' ? ', SpeechSynthesisUtterance нет' : ''}`,
    `Голосов всего: ${voices.length}, китайских (путунхуа): ${zh.length}`,
    ...zh.map(v => `  ${v.chosen ? '→' : ' '} ${v.name} | ${v.lang} | localService=${v.local}${v.female ? ' | женский' : ''} | ${v.uri}`),
    `Выбор: ${pref ? `${pref.name} (${pref.lang})${prefMissing ? ' — НЕ НАЙДЕН на устройстве' : ''}` : 'автоматически'}`,
    `Используется: ${chosen ? `${chosen.name} (${chosen.lang})` : voices.length ? 'нет подходящего' : 'системный zh-CN (список голосов пуст)'}`,
    `Последнее действие: ${lastAction ? `${lastAction.at} «${lastAction.text}» ${lastAction.slow ? 'медленно' : 'обычно'} · ${lastAction.voice}` : 'не было'}`,
    `Очередь сейчас: ${q()}`,
    'События:', ...(LOG.length ? LOG.map(l => '  ' + l) : ['  —'])
  ].join('\n');
}

if (typeof speechSynthesis !== 'undefined') {
  refreshVoices();
  log('init', `voices=${voices.length}`);
  const onVoices = () => { refreshVoices(); log('voiceschanged', `voices=${voices.length} zh=${voices.filter(isZh).length}`); };
  try { speechSynthesis.addEventListener('voiceschanged', onVoices); } catch { speechSynthesis.onvoiceschanged = onVoices; }
  document.addEventListener('visibilitychange', () => { log('visibility', document.visibilityState); if (!document.hidden) refreshVoices(); });
}
