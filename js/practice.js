// Учебные задания: выбор направления вспоминания, подбор похожих вариантов, пары «не путать», пропуск в предложении.
// Только чистые функции (без базы и DOM) — проверяются tests/unit/practice.test.mjs.

/** Направления самостоятельного вспоминания и навыки, которые они проверяют. */
export const DIRS = {
  hz: { skill: 'rec', mode: 'recall', title: 'Иероглифы → чтение и значение' },
  ru: { skill: 'prod', mode: 'recall-ru', title: 'Смысл → китайское слово' },
  au: { skill: 'listen', mode: 'recall-au', title: 'На слух → слово' },
  use: { skill: 'use', mode: 'cloze', title: 'Слово в предложении' }
};
/** Режим ответа → навык. Выбор из вариантов (quiz*) — слабое свидетельство: навык «choice»/«listen». */
export const MODE_SKILL = { recall: 'rec', 'recall-ru': 'prod', 'recall-au': 'listen', cloze: 'use', sentence: 'ctx', quiz: 'choice', 'quiz-au': 'listen' };
export const CHOICE_MODES = new Set(['quiz', 'quiz-au']);
export const SKILL_RU = { rec: 'узнавание иероглифов', prod: 'вспоминание по смыслу', listen: 'на слух', use: 'в предложении', ctx: 'понимание предложений', choice: 'выбор перевода' };

/**
 * Направление для слова. Первое знакомство — всегда с иероглифами (слово надо увидеть).
 * Дальше — направление, которое проверялось реже всего. Старые записи без раздельного учёта
 * считаются проверенными по иероглифам (так работала прежняя версия) — поэтому им сначала
 * достанутся «по смыслу» и «на слух», без переоценки самих отметок.
 */
export function chooseDirection(p, { audio = false, cloze = false } = {}) {
  if (!p || !p.reps) return 'hz';
  const cand = ['ru', ...(audio ? ['au'] : []), ...(cloze ? ['use'] : []), 'hz'];
  const n = (d) => { const s = DIRS[d].skill; const k = p.skills?.[s]?.n; return k ?? (s === 'rec' ? p.reps : 0); };
  let best = cand[0];
  for (const d of cand) if (n(d) < n(best)) best = d;
  return best;
}

/* ---------- похожие варианты ---------- */
const MARKS = { ā: 'a', á: 'a', ǎ: 'a', à: 'a', ē: 'e', é: 'e', ě: 'e', è: 'e', ī: 'i', í: 'i', ǐ: 'i', ì: 'i', ō: 'o', ó: 'o', ǒ: 'o', ò: 'o', ū: 'u', ú: 'u', ǔ: 'u', ù: 'u', ǖ: 'ü', ǘ: 'ü', ǚ: 'ü', ǜ: 'ü' };
export const toneless = (py) => String(py || '').toLowerCase().normalize('NFC').replace(/[āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ]/g, c => MARKS[c]).replace(/[^a-zü]/g, '');
/** Значения через «;» и «,» — без пояснений в скобках. */
export const meaningParts = (ru) => String(ru || '').toLowerCase().replace(/\([^)]*\)/g, '').split(/[;,]/).map(s => s.trim()).filter(s => s.length > 1);
/** Варианты с общим значением не годятся в отвлекающие: оба ответа были бы верны. */
export function meaningOverlap(a, b) {
  const A = meaningParts(a), B = new Set(meaningParts(b));
  return A.some(x => B.has(x));
}

/**
 * Отвлекающие варианты — не случайные: пара «не путать», общий знак, похожее звучание,
 * та же часть речи и длина. Слова с пересекающимся значением и то же написание исключаются.
 * kind: 'meaning' — выбирают перевод (важно не совпадение значения); 'sound' — выбирают слово на слух.
 */
export function pickDistractors(target, pool, { n = 3, kind = 'meaning', partners = [], rnd = Math.random } = {}) {
  const tSyl = toneless(target.pinyin), tChars = new Set([...target.hanzi]);
  const seenRu = new Set([String(target.ru || '').trim()]), seenHz = new Set([target.hanzi]);
  const scored = [];
  for (const x of pool) {
    if (!x || x.id === target.id || seenHz.has(x.hanzi) || !x.ru) continue;
    if (meaningOverlap(target.ru, x.ru)) continue;
    let s = 0;
    if (partners.includes(x.id)) s += 10;
    if ([...x.hanzi].some(c => tChars.has(c))) s += 3;
    const xs = toneless(x.pinyin);
    if (xs === tSyl) s += kind === 'sound' ? 6 : 2; else if (xs && tSyl && (xs.startsWith(tSyl.slice(0, 2)) || tSyl.startsWith(xs.slice(0, 2)))) s += kind === 'sound' ? 2 : 0;
    if (x.pos && target.pos && x.pos === target.pos) s += 1;
    if ([...x.hanzi].length === [...target.hanzi].length) s += 1;
    if (x.hskLevel && x.hskLevel === target.hskLevel) s += 0.5;
    scored.push({ x, s: s + rnd() * 0.4 });
  }
  scored.sort((a, b) => b.s - a.s);
  const out = [];
  for (const { x } of scored) {
    if (out.length >= n) break;
    if (seenRu.has(String(x.ru).trim()) || seenHz.has(x.hanzi) || out.some(o => meaningOverlap(o.ru, x.ru))) continue;
    seenRu.add(String(x.ru).trim()); seenHz.add(x.hanzi); out.push(x);
  }
  return out;
}

/* ---------- пары «не путать» ---------- */
/** Индекс пар по ключу словаря HSK (иероглифы; у многозначных — основное чтение). */
export function pairIndex(data) {
  const idx = new Map();
  for (const p of data?.pairs || []) {
    for (const [x, y] of [[p.a, p.b], [p.b, p.a]]) { if (!idx.has(x)) idx.set(x, []); idx.get(x).push({ other: y, note: p.note }); }
  }
  return idx;
}

/* ---------- пропуск в предложении ---------- */
/**
 * Пропуск изучаемого слова в проверенном примере. Пример подходит, только если его целевое слово —
 * это слово (по id, то есть то же написание, чтение и значение), а не просто те же иероглифы.
 * Возвращает null, если слово в предложении встречается больше одного раза (пропуск неоднозначен).
 */
export function makeCloze(x, targetId, known = () => true) {
  if (!x || x.tid !== targetId) return null;
  const idx = x.toks.map((t, i) => (t.t ? i : -1)).filter(i => i >= 0);
  if (idx.length !== 1) return null;
  const ti = idx[0], tgt = x.toks[ti];
  if (x.toks.filter(t => t.h === tgt.h).length > 1) return null;
  const unknown = x.toks.filter((t, i) => i !== ti && t.k && !known(t.id)).map(t => t.h);
  return { ex: x, ti, target: tgt, unknown };
}
/** Лучший пример для пропуска: меньше всего незнакомых слов, потом короче. */
export function bestCloze(examples, targetId, known) {
  return examples.map(x => makeCloze(x, targetId, known)).filter(Boolean)
    .sort((a, b) => a.unknown.length - b.unknown.length || a.ex.zh.length - b.ex.zh.length)[0] || null;
}

/** Основное значение целого слова — первым; остальные — отдельно (по раскрытию). */
export function splitMeaning(ru) {
  const parts = String(ru || '').split(/\s*;\s*/).map(s => s.trim()).filter(Boolean);
  return { main: parts[0] || '', rest: parts.slice(1) };
}
