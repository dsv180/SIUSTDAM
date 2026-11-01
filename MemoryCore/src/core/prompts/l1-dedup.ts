/**
 * L1 Conflict Detection Prompt (Batch Mode)
 *
 * Based on Kenty's validated prototype prompt (l1_conflict_detection_prompt.md).
 * Batch-compares multiple new memories against a unified candidate pool,
 * supporting cross-type merge and multi-target operations.
 *
 * [pilot-patch] Русифицировано (было: китайский скелет). Семантика правил,
 * имена JSON-полей, enum'ы и диапазоны priority сохранены 1:1.
 */

import type { MemoryPromptMode } from "../../config.js";
import type { MemoryRecord, ExtractedMemory } from "../record/l1-writer.js";

// ============================
// System Prompt
// ============================

export const CONFLICT_DETECTION_SYSTEM_PROMPT = `Ты — детектор конфликтов памяти. Пакетно сравнивай несколько【Новых воспоминаний】с уже имеющимися в【Едином пуле кандидатов】и для каждого решай, как поступить.

**Язык вывода**: \`merged_content\` пиши на языке уже имеющихся воспоминаний из пула кандидатов; имена JSON-полей, значения enum, record_id и ISO-времена оставляй на английском.

## Ключевые правила

- **Межтиповые слияния**: воспоминания разных type (persona / episodic / instruction / work_fact / work_task / work_method / work_artifact), семантически описывающие один и тот же факт/событие, **можно объединять**.
- **Слияния «многие-к-одному»**: одно новое воспоминание может одновременно заменить/поглотить **несколько** существующих из пула (через массив target_ids).
- После слияния ты обязан определить лучший type объединённого воспоминания (merged_type).

## Логика решения

1. **Определи природу воспоминания**:
   - **Состояние** (persona/instruction): предпочтения, черты, долгосрочные установки, относительно стабильные факты, правила поведения.
   - **Событие** (episodic): разовый опыт, объективная запись с привязкой ко времени; рекомендуется объединять причины и следствия одного события.

2. **Определи, тот ли это факт/событие**: субъект тот же, тема совпадает, время близко, scene_name похожи.

3. **Выбери действие**:
   - "store": новая информация — добавить текущее воспоминание.
   - "skip": существующее воспоминание лучше, новое не даёт приращения или более размыто — игнорировать.
   - "update": тот же факт/событие, новое воспоминание лучше по содержанию или времени (конкретнее, позднее или исправляет ошибку) — поверх старого, сохраняя всё ещё верные детали старого.
   - "merge": тот же факт или та же эволюция, несколько воспоминаний взаимодополняющи и не противоречат — слить в одно более полное, без избыточности.

4. **Стратегические склонности**:
   - Состояния: несколько описаний одной черты/предпочтения → склоняйся к merge; нет приращения → skip; явное обновление → update.
   - События: причины/следствия и разные этапы одного события → склоняйся к merge в одно целостное повествование; полностью совпадают → skip.
   - Межтиповой пример: episodic «Пользователь с 2018 года ведёт подкаст» + persona «Пользователь имеет опыт продюсирования подкастов» → можно merge в одну persona или episodic (по фокусу информации).

5. **Обработка timestamp**:
   - При merge / update поле merged_timestamps должно содержать **объединение временных меток всех затронутых воспоминаний** (дедупликация + сортировка).
   - Так сохраняется полная хронология события.

## Формат вывода

Строго JSON-массив, по одному элементу на каждое новое воспоминание. Ничего другого не выводи:

[
  {
    "record_id": "record_id нового воспоминания",
    "action": "store|update|skip|merge",
    "target_ids": ["record_id заменяемого старого воспоминания 1", "record_id 2"],
    "merged_content": "текст воспоминания после слияния/обновления (обязательно для merge/update)",
    "merged_type": "лучший type после слияния: persona|episodic|instruction|work_fact|work_task|work_method|work_artifact (обязательно для merge/update)",
    "merged_priority": 85,
    "merged_timestamps": ["массив временных меток после слияния — объединение всех старых и новых (обязательно для merge/update)"]
  }
]

Пояснения к полям:
- target_ids: **массив** ID старых воспоминаний к замене/удалению (одно или несколько). При store/skip — пустой или отсутствует.
- merged_content: итоговый текст воспоминания при merge/update. При store/skip — отсутствует.
- merged_type: type, к которому должно относиться воспоминание после merge/update. Определяется по сути объединённого содержимого.
- merged_priority: новый приоритет после merge/update (целое 0-100, обязательно для merge/update). Объединённое воспоминание полнее и определённее — priority обычно следует **разумно повысить** (например, две записи с priority 70 после слияния могут получить 80). Ориентиры: 80-100 (ключевые черты/важные события), 60-79 (обычные предпочтения/активности), <60 (второстепенное).
- merged_timestamps: массив временных меток после слияния. Собери timestamps нового воспоминания и всех поглощённых старых, удали дубликаты, отсортируй.`;

export const WORK_CONFLICT_DETECTION_SYSTEM_PROMPT = `Ты — детектор конфликтов командной рабочей памяти. Пакетно сравнивай несколько【Новых воспоминаний】с уже имеющимися в【Едином пуле кандидатов】и для каждого решай, как поступить.

**Язык вывода**: \`merged_content\` пиши на языке уже имеющихся воспоминаний из пула кандидатов; имена JSON-полей, значения enum, record_id и ISO-времена оставляй на английском.

## Ключевые правила

- **Межтиповые слияния**: воспоминания разных type (work_fact / work_task / work_method / work_artifact), семантически описывающие один рабочий объект, задачу, метод или артефакт, **можно объединять**.
- **Слияния «многие-к-одному»**: одно новое воспоминание может одновременно заменить/поглотить **несколько** существующих из пула (через массив target_ids).
- После слияния ты обязан определить лучший type объединённого воспоминания (merged_type).
- Воспоминания по умолчанию разделяются внутри проектной команды — в объединённом содержимом оставляй только рабочую информацию.

## Логика решения

1. **Определи природу воспоминания**:
   - **Рабочие факты (work_fact)**: факты проекта, требования, решения, состояние, риски, ограничения, результаты экспериментов, обратная связь клиентов.
   - **Рабочие задачи (work_task)**: todo, owner, deadline, следующие шаги, изменения статусов задач.
   - **Рабочие методы (work_method)**: SOP, запреты, принципы, опыт, проектные соображения, критерии оценки, правила поведения агентов.
   - **Рабочие артефакты (work_artifact)**: документы, PR, Issue, промпты, отчёты, ветки кода, макеты, ссылки и т.п.

2. **Определи, тот ли это рабочий объект / та ли эволюция**:
   - Тот же проект, модуль, требование, задача, риск, решение, метод или артефакт, и scene_name либо семантика высоко похожи.
   - Разные этапы одной задачи, дополнения одного метода, версии/назначения одного артефакта — обычно можно объединять.
   - Лишь общая принадлежность к одному большому проекту при разных предметах обсуждения — не объединяй искусственно.

3. **Выбери действие**:
   - "store": новая информация — добавить текущее воспоминание.
   - "skip": существующее лучше, новое не даёт приращения или более размыто — игнорировать.
   - "update": тот же рабочий объект, новое конкретнее, свежее, авторитетнее или исправляет старое — поверх старого, сохраняя всё ещё верные детали.
   - "merge": тот же рабочий объект или та же эволюция, новое и старое взаимодополняющи и не противоречат — слить в одно более полное, без избыточности.

4. **Стратегические склонности**:
   - work_fact: дополнение или поправка того же факта/решения/состояния → склоняйся к update или merge.
   - work_task: изменения owner, deadline, статуса той же задачи → склоняйся к update; дополнение зависимостей или критериев приёмки → склоняйся к merge.
   - work_method: дополнение того же SOP, запрета, принципа, опыта → склоняйся к merge; более чёткая и общая формулировка → склоняйся к update.
   - work_artifact: дополнение назначения, версии или ссылок того же документа/PR/промпта/отчёта → склоняйся к merge или update.
   - Межтиповой пример: work_fact «Команда решила сохранять небольшое число высокоуровневых L1 type» + work_method «L1 type не должен быть слишком дробным, иначе страдает агрегация L2/L3» → можно merge в work_method.

5. **Обработка timestamp**:
   - При merge / update поле merged_timestamps должно содержать **объединение временных меток всех затронутых воспоминаний** (дедупликация + сортировка).
   - Так сохраняется полная хронология эволюции рабочего факта, задачи или метода.

## Формат вывода

Строго JSON-массив, по одному элементу на каждое новое воспоминание. Ничего другого не выводи:

[
  {
    "record_id": "record_id нового воспоминания",
    "action": "store|update|skip|merge",
    "target_ids": ["record_id заменяемого старого воспоминания 1", "record_id 2"],
    "merged_content": "текст воспоминания после слияния/обновления (обязательно для merge/update)",
    "merged_type": "лучший type после слияния: work_fact|work_task|work_method|work_artifact (обязательно для merge/update)",
    "merged_priority": 85,
    "merged_timestamps": ["массив временных меток после слияния — объединение всех старых и новых (обязательно для merge/update)"]
  }
]

Пояснения к полям:
- target_ids: **массив** ID старых воспоминаний к замене/удалению (одно или несколько). При store/skip — пустой или отсутствует.
- merged_content: итоговый текст воспоминания при merge/update. При store/skip — отсутствует.
- merged_type: type, к которому должно относиться воспоминание после merge/update. Определяется по сути объединённого содержимого.
- merged_priority: новый приоритет после merge/update (целое 0-100, обязательно для merge/update). Объединённое воспоминание полнее и определённее — priority обычно следует **разумно повысить**. Ориентиры: 80-100 (ключевые факты/важные задачи/основные методы/важные артефакты), 60-79 (обычная рабочая информация), <60 (второстепенное).
- merged_timestamps: массив временных меток после слияния. Собери timestamps нового воспоминания и всех поглощённых старых, удали дубликаты, отсортируй.`;

export function getConflictDetectionSystemPrompt(mode: MemoryPromptMode = "chat"): string {
  return mode === "code" ? WORK_CONFLICT_DETECTION_SYSTEM_PROMPT : CONFLICT_DETECTION_SYSTEM_PROMPT;
}

// ============================
// Prompt Builder
// ============================

/**
 * Candidate search result for a single new memory.
 */
export interface CandidateMatch {
  newMemory: ExtractedMemory & { record_id: string };
  candidates: MemoryRecord[];
}

/**
 * Format the batch conflict detection prompt using a unified candidate pool.
 *
 * Format (aligned with prototype):
 * 1. Unified candidate pool: de-duplicated list of all existing candidates across all new memories
 * 2. Per new memory: content + list of related candidate IDs from the pool
 *
 * This approach lets the LLM see the global picture and handle cross-memory dedup in one pass.
 *
 * @param matches - Array of new memories with their candidate matches
 */
export function formatBatchConflictPrompt(matches: CandidateMatch[]): string {
  // Step 1: Build unified candidate pool (de-duplicate across all new memories)
  const unifiedPool = new Map<string, MemoryRecord>();
  const perMemoryCandidateIds = new Map<string, string[]>();

  for (const m of matches) {
    const candidateIds: string[] = [];
    for (const c of m.candidates) {
      if (!unifiedPool.has(c.id)) {
        unifiedPool.set(c.id, c);
      }
      candidateIds.push(c.id);
    }
    perMemoryCandidateIds.set(m.newMemory.record_id, candidateIds);
  }

  // Step 2: Format unified pool as JSON
  const poolList = Array.from(unifiedPool.values()).map((c) => ({
    record_id: c.id,
    content: c.content,
    type: c.type,
    priority: c.priority,
    scene_name: c.scene_name,
    timestamps: c.timestamps,
  }));

  let poolSection: string;
  if (poolList.length === 0) {
    poolSection = "## Единый пул кандидатов\n\n(пусто: существующих воспоминаний нет — все новые сохраняются с action=store)";
  } else {
    const poolStr = JSON.stringify(poolList, null, 2);
    poolSection = `## Единый пул кандидатов (всего ${poolList.length} существующих воспоминаний)\n\n${poolStr}`;
  }

  // Step 3: Format each new memory with its related candidate IDs
  const memoryParts = matches.map((m, idx) => {
    const relatedIds = perMemoryCandidateIds.get(m.newMemory.record_id) ?? [];
    const relatedNote =
      relatedIds.length > 0
        ? JSON.stringify(relatedIds)
        : "[] (похожих кандидатов нет — сразу store)";

    const memStr = JSON.stringify(
      {
        record_id: m.newMemory.record_id,
        content: m.newMemory.content,
        type: m.newMemory.type,
        priority: m.newMemory.priority,
        scene_name: m.newMemory.scene_name,
      },
      null,
      2,
    );

    return `### Новое воспоминание № ${idx + 1} (record_id: ${m.newMemory.record_id})\n${memStr}\n\n【Связанные ID кандидатов】${relatedNote}`;
  });

  const newMemoriesText = memoryParts.join(
    "\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n",
  );

  // Step 4: Assemble final prompt
  return `**Язык вывода**: \`merged_content\` пиши на языке уже имеющихся воспоминаний из пула кандидатов.

${poolSection}

${"═".repeat(50)}

## Новые воспоминания к решению (всего ${matches.length})

${newMemoriesText}

Разбери каждое по очереди и выведи JSON-массив решений. Если у нового воспоминания список кандидатов пуст — сразу выводи action=store.`;
}
