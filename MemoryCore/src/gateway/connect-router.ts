/**
 * connect-router — онбординг-эндпоинт подключения агентов к памяти (pilot-patch).
 *
 * Замысел: doc/модули/онбординг-эндпоинт/01-замысел.md (кубики К1–К3).
 * Человек даёт агенту один URL «подключись к памяти»; агент сам получает
 * инструкцию/манифест, скачивает мост, настраивает свой MCP-клиент и
 * верифицируется вызовом memory_search.
 *
 * Границы: НЕ маршрутизация трафика (REST-протокол памяти один для всех,
 * путь ничего не переключает — этим отличается от LLM-прокси с его
 * wire-протоколами). Публичен на полигоне; user_key-гейт (К5) — при выносе
 * на сервер. Откат: удалить вызов из server.ts dispatch + этот файл.
 *
 * Маршруты:
 *   GET /connect/agents                     — список известных агентов
 *   GET /connect/{agent}/{instance}         — инструкция (markdown)
 *   GET /connect/{agent}/{instance}?format=json — манифест
 *   GET /connect/{agent}/rules              — правила дисциплины
 *   GET /connect/bridge                     — тело tdai-mcp.mjs
 */

import http from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_PATH = path.join(HERE, "connect-content", "tdai-mcp.mjs");

// Целостность моста считаем один раз на старте шлюза (не на каждый запрос).
const BRIDGE_SHA256 = (() => {
  try {
    return createHash("sha256").update(readFileSync(BRIDGE_PATH)).digest("hex");
  } catch {
    return null; // файл не найден — /connect/bridge отдаст 500 с объяснением
  }
})();
const STARTED_AT = new Date().toISOString();

/**
 * Реестр агентов. Тип агента НЕ детектируется — он декларируется человеком
 * в URL и проходит сквозь весь цикл: URL → config_block (env TDAI_AGENT) →
 * session_key моста → метка в памяти. Блок конфига dsh — дословно тот,
 * что опробован на пилоте 06.11.
 */
const AGENTS: Record<
  string,
  { display: string; mcpClient: string; configBlock: (gw: string) => string; manualSteps: string[] }
> = {
  dsh: {
    display: "DeepSeek Harness (dsh)",
    mcpClient: "@deepseek-ai/dsh-mcp-client (transport: stdio)",
    configBlock: (gw) => `- id: mcp-tdam
  name: "@deepseek-ai/dsh-mcp-client"
  config:
    serverName: tdam
    transport: stdio
    command: "C:/Program Files/nodejs/node.exe"
    args: ["C:/TDAM/tdai-mcp.mjs"]
    env:
      TDAI_GATEWAY_URL: "${gw}"
      TDAI_AGENT: "dsh"`,
    manualSteps: ["перезапустить DSH (агент не может перезапустить себя сам)"],
  },
  zcode: {
    display: "ZCode",
    mcpClient: "плагин sius-memory-tdai (stdio)",
    configBlock: (gw) => `// ~/.zcode/tdai-memory.json (общий конфиг моста; env TDAI_* перекрывает)
{
  "gatewayUrl": "${gw}",
  "userId": "<имя пользователя>",
  "agent": "zcode"
}`,
    manualSteps: [],
  },
};

function baseUrlOf(req: http.IncomingMessage): string {
  const host = req.headers.host || "127.0.0.1:8420";
  return `http://${host}`;
}

function manifestOf(agent: string, instance: string, gw: string) {
  const a = AGENTS[agent];
  return {
    version: STARTED_AT.slice(0, 10),
    agent,
    instance,
    gateway_url: gw,
    transport: {
      kind: "mcp-stdio-bridge",
      bridge_url: `${gw}/connect/bridge`,
      bridge_sha256: BRIDGE_SHA256,
      client_mcp: a.mcpClient,
      config_block: a.configBlock(gw),
    },
    tools: [
      "memory_search",
      "memory_capture",
      "memory_recall",
      "conversation_search",
      "memory_session_end",
    ],
    rules_url: `${gw}/connect/${agent}/rules`,
    verify: {
      steps: [
        "применить config_block к своему MCP-клиенту",
        "перезапуститься (если требуется — см. manual_steps)",
        "вызвать memory_search с запросом «тест подключения»",
      ],
      success: "memory_search вернул непустой ответ",
    },
    manual_steps: a.manualSteps,
  };
}

function instructionOf(agent: string, instance: string, gw: string): string {
  const m = manifestOf(agent, instance, gw);
  const steps = [
    ...m.verify.steps.slice(0, 1),
    ...m.manual_steps.map((s) => `   ⚠️ ${s} — попроси человека, сам этого сделать нельзя.`),
  ].join("\n");
  return `# Подключение к командной памяти TDAM

Ты — агент **${m.agent}** (инстанс памяти: ${m.instance}).
Выполни шаги по порядку и доложи строкой видимости.

## 1. Скачай мост
curl -o C:/TDAM/tdai-mcp.mjs ${m.transport.bridge_url}
Целостность (sha256): \`${m.transport.bridge_sha256}\`

## 2. Зарегистрируй MCP-сервер у себя
Клиент: ${m.transport.client_mcp}
\`\`\`yaml
${m.transport.config_block}
\`\`\`

## 3. Перезапуск и проверка
${steps}

## 4. Верификация
Вызови \`mcp__tdam__memory_search\` с запросом «тест подключения».
Критерий успеха: ${m.verify.success}.

## 5. Дисциплина
Скачай правила и перенеси в свой файл правил:
curl ${m.rules_url}

## 6. Доклад
[память: подключено, поиск вернул N записей]  — или —
[память: подключение не удалось: <причина>]
`;
}

function rulesOf(agent: string): string {
  // Пока правила живут в адаптер-документах репозитория (doc/правила-памяти-*.md);
  // для рантайма шлюза держим копию рядом с контентом. Перенос в skill-хранилище —
  // отдельный шаг (03-границы).
  try {
    return readFileSync(path.join(HERE, "connect-content", `rules-${agent}.md`), "utf8");
  } catch {
    return `Правила для ${agent} не найдены. Эталон: doc/стандарт-работы-с-памятью.md.`;
  }
}

function sendText(res: http.ServerResponse, status: number, body: string, type: string): void {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(body);
}

/**
 * Возвращает true, если запрос обработан этим роутером (или отклонён с ответом).
 * Вызывается в server.ts dispatch ПОСЛЕ /health и ДО auth-гейта (публично на полигоне).
 */
export function handleConnectRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  method: string,
): boolean {
  if (pathname !== "/connect" && !pathname.startsWith("/connect/")) return false;

  if (method !== "GET") {
    sendText(res, 405, "Method Not Allowed: /connect/* поддерживает только GET", "text/plain; charset=utf-8");
    return true;
  }

  // GET /connect/agents
  if (pathname === "/connect" || pathname === "/connect/agents") {
    sendText(
      res,
      200,
      JSON.stringify(Object.keys(AGENTS), null, 2),
      "application/json; charset=utf-8",
    );
    return true;
  }

  // GET /connect/bridge
  if (pathname === "/connect/bridge") {
    if (!BRIDGE_SHA256) {
      sendText(res, 500, "bridge file missing on gateway", "text/plain; charset=utf-8");
      return true;
    }
    try {
      sendText(res, 200, readFileSync(BRIDGE_PATH, "utf8"), "text/javascript; charset=utf-8");
    } catch (e) {
      sendText(res, 500, `bridge read error: ${(e as Error).message}`, "text/plain; charset=utf-8");
    }
    return true;
  }

  const parts = pathname.split("/").filter(Boolean); // ["connect", agent, ...]
  const agent = parts[1];
  if (!agent || !AGENTS[agent]) {
    sendText(
      res,
      404,
      `Неизвестный агент: ${agent ?? "(пусто)"}.\nИзвестные агенты: ${Object.keys(AGENTS).join(", ")}.\nПример: /connect/dsh/default`,
      "text/plain; charset=utf-8",
    );
    return true;
  }

  // GET /connect/{agent}/rules
  if (parts[2] === "rules") {
    sendText(res, 200, rulesOf(agent), "text/markdown; charset=utf-8");
    return true;
  }

  const instance = parts[2] || "default";
  const gw = baseUrlOf(req);
  const wantsJson = new URL(req.url || "/", gw).searchParams.get("format") === "json";

  if (wantsJson) {
    sendText(res, 200, JSON.stringify(manifestOf(agent, instance, gw), null, 2), "application/json; charset=utf-8");
  } else {
    sendText(res, 200, instructionOf(agent, instance, gw), "text/markdown; charset=utf-8");
  }
  return true;
}
