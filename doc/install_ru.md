# Установка системы командной памяти на чистую машину (из репозитория SIUSTDAM)

> Полная инструкция «с нуля до работающей системы» для агента на чистой
> Windows-машине. Источник — репозиторий `github.com/dsv180/SIUSTDAM`
> (ветка `pilot-patches`), в котором содержится весь код, промпты, локаль,
> деплой-скрипты и конфиг шлюза. Смежные документы в этой папке:
> `ОБНОВЛЕНИЕ-НА-ВТОРОЙ-МАШИНЕ.md` (регламент синхронизации уже развёрнутой),
> `ИНСТРУКЦИЯ-АГЕНТУ-ОБНОВЛЕНИЕ-РЕПОЗИТОРИЯ.md` (правила работы с гитом).
>
> ⚠️ Репозиторий ПУБЛИЧНЫЙ. Ключи и секреты через git не передаются никогда
> (правило владельца) — без явного подтверждения на конкретную передачу.

## 0. Предпосылки

| Что | Требование |
|---|---|
| Windows 10/11 | обычная учётная запись, без админа |
| Node.js | ≥ 22.16, системный (`node --version`) |
| Git | любой свежий |
| GitHub-доступ | см. §1 о пользователях Windows |
| Ключ LLM | OpenAI-совместимый (AITUNNEL), выдаёт владелец |

**Важно про учётку Windows**: авторизация GitHub привязана к профилю
конкретного Windows-пользователя. Если агент работает под другим юзером —
git-операции с сетью выполняйте от имени владельца
(`runas /user:<github-юзер> cmd`) или просите владельца выполнить pull/push.

**Важно про пути**: стык обязан быть `C:\TDAM` (короткий ASCII-путь без
пробелов — Windows-стек сервисов на кириллицу/пробелы в путях падает).

## 1. Клонирование

```cmd
mkdir <локальный-клон> 2>nul
git clone https://github.com/dsv180/SIUSTDAM.git <локальный-клон>\TencentDB-Agent-Memory
cd /d <локальный-клон>\TencentDB-Agent-Memory
git checkout pilot-patches
```

Ремоуты называть как в регламенте: `origin` — вендорский Tencent (push на нём
отключается: `git remote set-url --push origin NO_PUSH_TO_VENDOR`),
`sync` — SIUSTDAM (уже добавлен клоном как `origin` — переименовать:
`git remote rename origin sync`).

## 2. Стык C:\TDAM

```cmd
mkdir C:\TDAM
mklink /J C:\TDAM\agent-memory <локальный-клон>\TencentDB-Agent-Memory
deploy\sync-to-tdam.cmd
```

`sync-to-tdam.cmd` скопирует в корень стыка все скрипты: CLI `memory.mjs`,
3 хука, MCP-сервер, вьюер, 4 лаунчера, `package.json` стыка. Перезапись
локальных версий скриптов — это цель.

Конфиг шлюза (`gateway-config.yaml`) копируется **только если его ещё нет**
в `C:\TDAM` — то есть при первичной установке на чистой машине. Если конфиг
уже есть, скрипт его не трогает: на машине может лежать намеренно свой
вариант (например, машина может хранить Ollama bge-m3 1024d, тогда как репо-вариант
— text-embedding-3-small 1536d; подмена сломала бы поиск по накопленным
векторам). Перезаписать конфиг принудительно:
`deploy\sync-to-tdam.cmd --force-config`.

## 3. Node-двойки и сборка панели

```cmd
cd /d C:\TDAM\agent-memory\MemoryCore && npm install
cd /d C:\TDAM && npm install
cd /d C:\TDAM\agent-memory\MemoryPanel\web && npm install && npm run build
```

Три установки: ядро (включая `snowball-stemmers`), зависимости MCP-сервера
стыка (`@modelcontextprotocol/sdk`, `zod`), фронтенд панели + **сборка `dist`**
— бэкенд панели раздаёт именно его; без сборки панель не поднимется.

## 4. Секреты (только с подтверждения владельца!)

Создайте `C:\TDAM\gateway.env` на основе `gateway.env.example` из репо.
Значения ключей владелец передаёт отдельно (правило: ключи не уезжают без
его особого подтверждения). Файл обязан быть с форматом «KEY=значение»,
**комментарии — только на отдельных строках** (хвостовой комментарий делает
значение мёртвым). Минимальный состав:

```
TDAI_LLM_API_KEY=<ключ AITUNNEL>
TDAI_LLM_REASONING=none
TDAI_SKILL_ENABLED=true
TDAI_TOOL_CAPTURE_SUCCESS=0
TDAI_GATEWAY_API_KEY=<случайная строка — ключ доступа к шлюзу>
TDAI_ADMIN_USER_KEY=<заполнится после init-admin, §6>
```

## 5. Запуск сервисов

```cmd
powershell -NoProfile -ExecutionPolicy Bypass -File C:\TDAM\gateway-service.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File C:\TDAM\mcp-http-service.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File C:\TDAM\memory-web-service.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File C:\TDAM\panel-service.ps1
```

(идемпотентны: живой сервис не перезапускают; логи — `C:\TDAM\*-service.log`)

## 6. Администратор панели

```cmd
curl -X POST "http://127.0.0.1:8420/v3/internal/meta/user/init-admin" ^
     -H "Content-Type: application/json" -H "x-tdai-service-id: default" ^
     -d "{\"username\":\"admin\"}"
```

`user_key` из ответа (показывается один раз) — в `gateway.env`
(`TDAI_ADMIN_USER_KEY`) и рестарт шлюза. Это ключ входа в панель
`http://127.0.0.1:8123`.

## 7. Автозапуск при входе в Windows

Startup-ярлыки (папка `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup`)
на каждый лаунчер: `powershell -NoProfile -ExecutionPolicy Bypass
-WindowStyle Hidden -File C:\TDAM\<лаунчер>.ps1` — ярлыки `tdam-*.lnk`.
Лаунчеры идемпотентны.

## 8. Приёмка (чек-лист работающей системы)

1. `curl http://127.0.0.1:8420/health` → `status: ok`, `ftsAvailable: true`,
   `embeddingService: true`.
2. `node C:/TDAM/memory.mjs capture "проверка" "работает"` → `записано`.
3. `node C:/TDAM/memory.mjs search "проверка"` → находит.
4. Панель `http://127.0.0.1:8123` → вход по admin user_key → интерфейс
   полностью русский.
5. `curl -X POST http://127.0.0.1:8900/mcp -H "Content-Type: application/json"
   -H "Accept: application/json, text/event-stream" -d "{\"jsonrpc\":\"2.0\",
   \"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":
   \"2025-03-26\",\"capabilities\":{},\"clientInfo\":{\"name\":\"probe\",
   \"version\":\"0\"}}}"` → JSON с serverInfo.
6. Иероглифов нигде нет (панель, память, конфиги).

## 9. Известные ловушки (полный список — `НАХОДКИ` и документы пакета)

- `npm ci` без правки локов падает на зеркалах Tencent (ловушка §3.7) —
  использовать `npm install`.
- Хвостовые комментарии в `gateway.env` делают ключ мёртвым (§3.12).
- Смешивать bash-утилиты и PowerShell при запуске .ps1 нельзя (MSYS искажает
  аргументы); кириллица в .ps1 — только UTF-8 с BOM.
- Vite dev :5173 может не работать — живой вход через :8123 (прод-сборка
  из `web/dist`); после правок UI — `npm run build`.
- Push может требовать авторизацию владельца (§0) и висеть до подтверждения.
