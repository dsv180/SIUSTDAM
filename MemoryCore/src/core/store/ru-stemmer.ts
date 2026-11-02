/**
 * Русский стеммер для store-layer токенизации.
 *
 * Обёртка над `snowball-stemmers` (официальный порт Snowball, ISC).
 * Ленивая инициализация; при недоступности пакета — identity (prefix-поиск
 * на query-стороне частично компенсирует).
 *
 * Применение по схеме Elastic/Postgres `russian`-анализатора: ОДИН И ТОТ ЖЕ
 * стеммер на write-side (индекс) и query-side (запрос) — тогда словоформы
 * «регламенту/регламенте/регламент» сводятся к общему стему «регламент».
 */

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

interface SnowballStemmer {
  stem(word: string): string;
}

let _ru: SnowballStemmer | null | undefined; // undefined = not yet tried

function getRuStemmer(): SnowballStemmer | null {
  if (_ru !== undefined) return _ru;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { newStemmer } = require("snowball-stemmers");
    _ru = newStemmer("russian") as SnowballStemmer;
  } catch {
    _ru = null; // пакет недоступен — identity
  }
  return _ru;
}

/**
 * Стемминг одного слова (русский Snowball). Не-русские и короткие слова
 * возвращаются как есть (lowercase делает вызывающий).
 */
export function stemRuWord(word: string): string {
  const stemmer = getRuStemmer();
  if (!stemmer) return word;
  try {
    return stemmer.stem(word);
  } catch {
    return word;
  }
}

/**
 * Русские стоп-слова (компактный набор высокочастотных служебных слов;
 * расширенный вариант — как в Elastic `russian` stop-фильтре).
 */
export const RU_STOP_WORDS = new Set([
  "и", "в", "во", "не", "что", "он", "на", "я", "с", "со", "как", "а", "то",
  "все", "она", "так", "его", "но", "да", "ты", "к", "у", "же", "вы", "за",
  "бы", "по", "только", "ее", "мне", "было", "вот", "от", "меня", "еще", "нет",
  "о", "из", "ему", "теперь", "когда", "даже", "ну", "ли", "если", "уже",
  "или", "ни", "быть", "был", "до", "вас", "уж", "вам", "ведь", "там",
  "потом", "себя", "ничего", "ей", "может", "они", "тут", "где", "есть",
  "надо", "ней", "для", "мы", "тебя", "их", "чем", "была", "сам", "чтоб",
  "без", "будет", "тогда", "кто", "этот", "этого", "какой", "совсем", "ним",
  "здесь", "этом", "один", "почти", "мой", "тем", "чтобы", "нее", "сейчас",
  "были", "куда", "зачем", "всех", "никогда", "можно", "при", "наконец",
  "два", "об", "другой", "хоть", "после", "над", "больше", "тот", "через",
  "эти", "нас", "про", "всего", "них", "какая", "много", "разве", "три",
  "эту", "моя", "впрочем", "хорошо", "свою", "этой", "перед", "иногда",
  "лучше", "чуть", "том", "нельзя", "такой", "им", "более", "всегда",
  "конечно", "всю", "между",
]);

/**
 * Полный конвейер обработки русских токенов:
 * lowercase → стоп-слова → стемминг → дедупликация.
 */
export function stemRuTokens(tokens: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of tokens) {
    const w = raw.toLowerCase();
    if (!w || RU_STOP_WORDS.has(w)) continue;
    const stemmed = stemRuWord(w);
    if (!stemmed || seen.has(stemmed)) continue;
    seen.add(stemmed);
    out.push(stemmed);
  }
  return out;
}
