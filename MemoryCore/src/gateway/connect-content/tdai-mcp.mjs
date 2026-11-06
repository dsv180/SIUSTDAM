// MCP-мост ZCode → TencentDB Agent Memory (MemoryCore Gateway).
// Транспорт: stdio, построчный JSON-RPC 2.0 (спецификация MCP stdio).
// Зависимостей нет — только Node >= 18.
//
// Настройка подключения (приоритет: переменные окружения → файл → значения по умолчанию):
//   Файл ~/.zcode/tdai-memory.json:
//   {
//     "gatewayUrl": "http://127.0.0.1:8420",   // адрес MemoryCore Gateway
//     "userId": "dsv",                          // кто за этой машиной
//     "gatewayApiKey": "",                      // Bearer-токен Gateway (если включена авторизация)
//     "serviceId": ""                           // x-tdai-service-id (пространство памяти; обычно не нужно)
//   }
//   Переменные окружения (перекрывают файл): TDAI_GATEWAY_URL, TDAI_USER_ID,
//   TDAI_GATEWAY_API_KEY, TDAI_SERVICE_ID, TDAI_SESSION_KEY.

import readline from "node:readline";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

function loadFileConfig() {
  try {
    return JSON.parse(readFileSync(path.join(homedir(), ".zcode", "tdai-memory.json"), "utf8"));
  } catch {
    return {};
  }
}
const FILE = loadFileConfig();

const GW = (
  process.env.TDAI_GATEWAY_URL ||
  FILE.gatewayUrl ||
  "http://127.0.0.1:8420"
).replace(/\/$/, "");
const USER_ID = process.env.TDAI_USER_ID || FILE.userId || process.env.USERNAME || process.env.COMPUTERNAME || "unknown-user";
// Тип агента — декларация, не детект: задаётся клиентом (env TDAI_AGENT в
// конфиг-блоке онбординга /connect или поле agent в tdai-memory.json).
// Нужен шлюзу для достоверной метки агента в session_key (аудит, статистика).
const AGENT = process.env.TDAI_AGENT || FILE.agent || "unknown";
const GATEWAY_API_KEY = process.env.TDAI_GATEWAY_API_KEY || FILE.gatewayApiKey || "";
const SERVICE_ID = process.env.TDAI_SERVICE_ID || FILE.serviceId || "";
const SESSION_KEY =
  process.env.TDAI_SESSION_KEY ||
  `${AGENT}-${USER_ID}-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`;

const log = (...a) => console.error("[tdai-mcp]", ...a);

function headers() {
  const h = { "Content-Type": "application/json; charset=utf-8" };
  if (GATEWAY_API_KEY) h.Authorization = `Bearer ${GATEWAY_API_KEY}`;
  if (SERVICE_ID) h["x-tdai-service-id"] = SERVICE_ID;
  return h;
}

async function gw(pathName, body) {
  const res = await fetch(GW + pathName, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Gateway ${pathName} → HTTP ${res.status}: ${text.slice(0, 300)}`);
  return text;
}

const TOOLS = [
  {
    name: "memory_search",
    description:
      "Поиск по долговременной памяти команды (слой L1 — атомарные памятки: факты, правила, события, свойства участников). Запрос по-русски; морфология частично сводится. Ищет во ВСЕЙ общей памяти, не только своей сессии.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Поисковый запрос (по-русски)." },
        limit: { type: "number", description: "Сколько результатов (по умолчанию 5)." },
        type: { type: "string", description: "Фильтр типа: persona|episodic|instruction|work_fact|work_task|work_method|work_artifact." },
      },
      required: ["query"],
    },
    handler: async ({ query, limit = 5, type }) => {
      const body = { query, limit };
      if (type) body.type = type;
      const r = JSON.parse(await gw("/search/memories", body));
      return `strategy=${r.strategy} total=${r.total}\n${r.results}`;
    },
  },
  {
    name: "conversation_search",
    description:
      "Поиск по исходным диалогам (слой L0) — когда нужна дословная формулировка из прошлых разговоров. Ищет по всему общему пространству, если не задан session_key.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Поисковый запрос." },
        limit: { type: "number", description: "Сколько результатов (по умолчанию 5)." },
        session_key: { type: "string", description: "Ограничить одной сессией (необязательно)." },
      },
      required: ["query"],
    },
    handler: async ({ query, limit = 5, session_key }) => {
      const body = { query, limit };
      if (session_key) body.session_key = session_key;
      const r = JSON.parse(await gw("/search/conversations", body));
      return `total=${r.total}\n${r.results}`;
    },
  },
  {
    name: "memory_capture",
    description:
      "Записать реплику диалога в общую память команды (слой L0; фоновая экстракция превратит факты в памятки L1). Вызывай после содержательного обмена: user_content — что сказал пользователь, assistant_content — что ответил ассистент.",
    inputSchema: {
      type: "object",
      properties: {
        user_content: { type: "string", description: "Реплика пользователя." },
        assistant_content: { type: "string", description: "Ответ ассистента (если был)." },
      },
      required: ["user_content"],
    },
    handler: async ({ user_content, assistant_content }) => {
      const r = JSON.parse(
        await gw("/capture", {
          user_content,
          assistant_content: assistant_content || "(записано без ответа ассистента)",
          session_key: SESSION_KEY,
          user_id: USER_ID,
        }),
      );
      return `записано: l0_recorded=${r.l0_recorded}, сессия=${SESSION_KEY}`;
    },
  },
  {
    name: "memory_recall",
    description:
      "Собрать контекст памяти по запросу перед ответом (рекомендуется перед вопросами «как мы делали X?», «что решили про Y?»). Возвращает сводку: релевантные памятки и контекст сессии.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "О чём вспомнить." } },
      required: ["query"],
    },
    handler: async ({ query }) => {
      const r = JSON.parse(await gw("/recall", { query, session_key: SESSION_KEY }));
      return r.context || "(память пуста)";
    },
  },
  {
    name: "memory_session_end",
    description:
      "Завершить сессию памяти: форсирует обработку накопленных реплик (экстракция L1→L2). Вызывай в конце содержательной работы.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      const r = JSON.parse(await gw("/session/end", { session_key: SESSION_KEY }));
      return `flushed=${r.flushed}, сессия=${SESSION_KEY}`;
    },
  },
];

function result(text, isError = false) {
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

async function dispatch(name, args) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return result(`Неизвестный инструмент: ${name}`, true);
  try {
    return result(await tool.handler(args ?? {}));
  } catch (e) {
    log("tools/call", name, "ошибка:", e.message);
    return result(`Ошибка: ${e.message}`, true);
  }
}

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

// Хост-обёртка ZCode (__zcode-plugin-host) импортирует этот модуль и
// вызывает main(); при прямом запуске node-ом стартуем сами.
export function main() {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on("line", async (line) => {
    const s = line.trim();
    if (!s) return;
    let msg;
    try {
      msg = JSON.parse(s);
    } catch {
      return log("не-JSON строка отброшена");
    }
    const { id, method, params } = msg;
    try {
      if (method === "initialize") {
        send({
          id,
          result: {
            protocolVersion: params?.protocolVersion || "2025-06-18",
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "sius-memory-tdai", version: "0.1.0" },
          },
        });
      } else if (method === "ping") {
        send({ id, result: {} });
      } else if (method === "tools/list") {
        send({ id, result: { tools: TOOLS.map(({ name: n, description, inputSchema }) => ({ name: n, description, inputSchema })) } });
      } else if (method === "tools/call") {
        const r = await dispatch(params?.name, params?.arguments);
        send({ id, result: r });
      } else if (method?.startsWith("notifications/")) {
        // уведомления без ответа (initialized и пр.)
      } else if (id !== undefined) {
        send({ id, error: { code: -32601, message: `Метод не найден: ${method}` } });
      }
    } catch (e) {
      log("ошибка обработки", method, e.message);
      if (id !== undefined) send({ id, error: { code: -32603, message: e.message } });
    }
  });
  process.on("disconnect", () => process.exit(0));
  log(`старт; gateway=${GW}; user=${USER_ID}; agent=${AGENT}; auth=${GATEWAY_API_KEY ? "bearer" : "нет"}; session_key=${SESSION_KEY}`);
}

import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
// Запуск прямой: `node tdai-mcp.mjs`. Сравниваем argv с import.meta.url И по
// realpath — на машинах, где путь к файлу проходит через junction/symlink
// (здесь: C:\TDAM → папка темы проекта на D:), node резолвит import.meta.url
// в физический путь, и наивное сравнение строк молча не стартует сервер.
// Хост-обёртка ZCode импортирует модуль и вызывает main() сама — argv пуст,
// авто-старт не срабатывает, двойного readline не будет.
function isDirectInvocation() {
  if (!process.argv[1]) return false;
  const candidates = new Set();
  try {
    candidates.add(pathToFileURL(path.resolve(process.argv[1])).href);
  } catch {}
  try {
    candidates.add(pathToFileURL(realpathSync(process.argv[1])).href);
  } catch {}
  return candidates.has(import.meta.url);
}
if (isDirectInvocation()) main();
