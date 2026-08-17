# <img src="./assets/a1-logo.svg" alt="A1" width="40"> Авито Реклама MCP

[![npm](https://img.shields.io/npm/v/mcp-avito-ads)](https://www.npmjs.com/package/mcp-avito-ads)
[![CI](https://github.com/A1-x-Tech/mcp-avito-ads/actions/workflows/ci.yml/badge.svg)](https://github.com/A1-x-Tech/mcp-avito-ads/actions/workflows/ci.yml)
[![Glama](https://glama.ai/mcp/servers/A1-x-Tech/mcp-avito-ads/badges/score.svg)](https://glama.ai/mcp/servers/A1-x-Tech/mcp-avito-ads)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

**A1 Авито Реклама MCP** подключает AI-приложение к рекламному кабинету Авито Рекламы. Он помогает проверить кампании и статистику, управлять бюджетом и ставкой группы, работать с балансами агентства, доступами и документами ОРД — на естественном языке.

Это не API продавца Авито: сервер не работает с товарами, перепиской, заказами или продвижением объявлений продавца. Он работает только с медийными и performance-кампаниями рекламного кабинета Авито Рекламы.

- **25 инструментов.** Кампании, группы, креативы, статистика, баланс, дочерние аккаунты, пользователи и документы ОРД.
- **Узкие изменения кампаний.** API позволяет менять только бюджет и ставку группы; создавать, редактировать, ставить на паузу или удалять кампании, группы и креативы нельзя.
- **Необратимые операции видны.** Перевод денег или бонусов, удаление пользователя и технический запрос API помечены как destructive.
- **Недельный бюджет API.** Каждый вызов тратит баллы; остаток `apiPointBalance` сервер возвращает с результатом.

Начните с запроса, который только читает данные:

> Покажи кампании моего аккаунта Авито и расход за прошлую неделю по группам объявлений.

[Подключить сервер](#быстрый-старт) · [Посмотреть сценарии](#что-можно-поручить) · [Открыть техническую документацию](#техническая-документация)

---

## Увидеть работу за минуту

> **Вы:** Покажи кампании моего аккаунта Авито и расход за прошлую неделю по группам объявлений.
>
> **Ассистент:** Показывает кампании, группы, расход, клики и показы. Ничего не меняется.
>
> **Вы:** Подготовь изменение ставки группы 101 до 350 рублей.
>
> **Ассистент:** Показывает аккаунт, группу, текущую и новую ставку, затем запрашивает подтверждение.
>
> **Вы:** Подтверждаю.
>
> **Ассистент:** Меняет ставку только этой группы. Кампания, креативы и другие группы не меняются.

## Содержание

- [Быстрый старт](#быстрый-старт)
- [Что можно поручить](#что-можно-поручить)
- [Что может измениться](#что-может-измениться)
- [Получение доступа](#получение-доступа)
- [Настройка](#настройка)
- [Данные, лимиты и работа в фоне](#данные-лимиты-и-работа-в-фоне)
- [Техническая документация](#техническая-документация)
- [Поддержка](#поддержка)

## Быстрый старт

Нужны Node.js 20+, Client Key, Client Secret и ID рекламного аккаунта Авито Рекламы. Для выдачи доступов нужна роль администратора аккаунта.

1. [Получите доступ](#получение-доступа).
2. Добавьте сервер в AI-приложение.
3. Отправьте безопасный первый запрос выше.

<details open><summary><strong>Codex</strong></summary>

<br>

В **Settings → Plugins → MCP servers** нажмите **Add server**, затем добавьте `npx -y mcp-avito-ads@latest` с `AVITO_ADS_CLIENT_ID`, `AVITO_ADS_CLIENT_SECRET` и `AVITO_ADS_ACCOUNT_ID`.

```bash
codex mcp add avito-ads \
  --env AVITO_ADS_CLIENT_ID=your_client_key \
  --env AVITO_ADS_CLIENT_SECRET=your_client_secret \
  --env AVITO_ADS_ACCOUNT_ID=your_account_id \
  -- npx -y mcp-avito-ads@latest
codex mcp list
```

[Документация Codex MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)

</details>

<details><summary><strong>Claude Code</strong></summary>

<br>

```bash
claude mcp add \
  --env AVITO_ADS_CLIENT_ID=your_client_key \
  --env AVITO_ADS_CLIENT_SECRET=your_client_secret \
  --env AVITO_ADS_ACCOUNT_ID=your_account_id \
  --transport stdio --scope user avito-ads \
  -- npx -y mcp-avito-ads@latest
claude mcp list
```

[Документация Claude Code MCP](https://code.claude.com/docs/en/mcp)

</details>

<details><summary><strong>Claude Desktop</strong></summary>

<br>

Откройте **Settings → Developer → Edit Config** и добавьте:

```json
{"mcpServers":{"avito-ads":{"command":"npx","args":["-y","mcp-avito-ads@latest"],"env":{"AVITO_ADS_CLIENT_ID":"your_client_key","AVITO_ADS_CLIENT_SECRET":"your_client_secret","AVITO_ADS_ACCOUNT_ID":"your_account_id"}}}}
```

Если **Edit Config** недоступна, отредактируйте `~/Library/Application Support/Claude/claude_desktop_config.json` на macOS или `%APPDATA%\Claude\claude_desktop_config.json` на Windows. [Документация Claude Desktop MCP](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop)

</details>

<details><summary><strong>Cursor</strong></summary>

<br>

Добавьте `{"mcpServers":{"avito-ads":{"type":"stdio","command":"npx","args":["-y","mcp-avito-ads@latest"],"env":{"AVITO_ADS_CLIENT_ID":"your_client_key","AVITO_ADS_CLIENT_SECRET":"your_client_secret","AVITO_ADS_ACCOUNT_ID":"your_account_id"}}}}` в `~/.cursor/mcp.json` на macOS/Linux или `%USERPROFILE%\.cursor\mcp.json` на Windows. [Документация Cursor MCP](https://cursor.com/docs/mcp)

</details>

<details><summary><strong>VS Code</strong></summary>

<br>

Запустите **MCP: Open User Configuration** и добавьте:

```json
{"servers":{"avito-ads":{"type":"stdio","command":"npx","args":["-y","mcp-avito-ads@latest"],"env":{"AVITO_ADS_CLIENT_ID":"${input:avito_client_id}","AVITO_ADS_CLIENT_SECRET":"${input:avito_client_secret}","AVITO_ADS_ACCOUNT_ID":"${input:avito_account_id}"}}},"inputs":[{"type":"promptString","id":"avito_client_id","description":"Avito Ads Client Key"},{"type":"promptString","id":"avito_client_secret","description":"Avito Ads Client Secret","password":true},{"type":"promptString","id":"avito_account_id","description":"ID рекламного аккаунта"}]}
```

Проверьте сервер командой **MCP: List Servers**. [Документация VS Code MCP](https://code.visualstudio.com/docs/agent-customization/mcp-servers)

</details>

## Что можно поручить

- Покажи кампании, группы, креативы, статусы и статистику за период.
- Сравни расход, CTR, CPM, CPC или VTR по группам и креативам.
- Проверь баланс и дочерние аккаунты агентства.
- Подготовь изменение бюджета или ставки одной группы.
- Создай рекламодателя и договор ОРД, сначала показав передаваемые реквизиты.
- Добавь пользователя, измени его роль или отзови доступ после подтверждения.

## Что может измениться

| Операция | Что происходит | Граница подтверждения |
|---|---|---|
| Кампании, группы, креативы, статистика, баланс, пользователи и ОРД | Читает данные аккаунта | Ничего не меняет |
| Бюджет или ставка группы | Меняет одно из двух доступных API-полей группы | Меняет рекламную группу |
| Пользователь и роль | Выдаёт доступ или меняет роль | Меняет доступы аккаунта |
| Рекламодатель, договор, дочерний или sandbox-аккаунт | Создаёт новую запись | Необратимо создаёт объект |
| Перевод денег или бонусов, удаление пользователя | Меняет баланс или удаляет доступ | Разрушительно и необратимо |
| Raw API request | Может менять данные при `confirmWrite: true` | Потенциально разрушительно |

Кампании, группы и креативы нельзя создавать, редактировать, ставить на паузу, архивировать или удалять через этот API. Креативы и таргетинги тоже недоступны для записи.

## Получение доступа

1. Откройте кабинет Авито Рекламы пользователем с ролью администратора.
2. Создайте API-приложение и скопируйте **Client Key** и **Client Secret**.
3. Скопируйте ID рекламного аккаунта.
4. Передайте их как `AVITO_ADS_CLIENT_ID`, `AVITO_ADS_CLIENT_SECRET`, `AVITO_ADS_ACCOUNT_ID`.

Сервер получает Bearer token через OAuth2 `client_credentials`. Храните Client Secret как пароль. ID аккаунта задан конфигурацией: инструменты не смогут случайно перейти в другой аккаунт.

Для репетиции записей можно задать `AVITO_ADS_ENVIRONMENT=sandbox`. Песочница не является полной копией production: например, баланс там недоступен.

## Настройка

| Переменная | Обязательна | Описание |
|---|---|---|
| `AVITO_ADS_CLIENT_ID` | Да | Client Key API-приложения. |
| `AVITO_ADS_CLIENT_SECRET` | Да | Client Secret API-приложения. |
| `AVITO_ADS_ACCOUNT_ID` | Да | ID рекламного аккаунта. |
| `AVITO_ADS_ENVIRONMENT` | Нет | `production` или `sandbox`; по умолчанию `production`. |
| `AVITO_ADS_TIMEOUT_MS` | Нет | Тайм-аут запроса; по умолчанию `30000` мс. |
| `AVITO_ADS_MAX_RETRIES` | Нет | Повторы 429; по умолчанию `4`. |

## Данные, лимиты и работа в фоне

- **Недельный бюджет баллов.** Баллы пополняются в понедельник в 00:00 UTC. Один длинный отчёт до 100 дней обычно экономнее серии коротких; сервер показывает `apiPointBalance` с каждым результатом.
- **Временные ошибки.** При 429 в ошибке возвращаются `Retry-After` и остаток баллов. Записи не повторяются после сетевой или 5xx ошибки, чтобы не перевести деньги дважды.
- **Постоянного наблюдения нет.** Сервер работает только при вызове. Если AI-приложение поддерживает задания по расписанию, оно может периодически собирать статистику и остаток баллов.
- **Анонимная телеметрия.** В неё не попадают секреты, данные аккаунта, аргументы и промпты; отключение: `ASKADS_TELEMETRY=0`.

## Техническая документация

- [Каталог MCP-возможностей](./docs/capabilities/index.md) — страницы по пользовательским задачам для каждого инструмента.
- [Все инструменты и параметры](./docs/TOOLS.md)
- [Документация по разработке](./docs/DEVELOPMENT.md)
- [Документация по публикации](./docs/PUBLISHING.md)
- [Официальный Avito Ads SDK](https://github.com/avito-tech/avito-ads-sdk-typescript)

## Поддержка

Нашли ошибку или не хватает сценария? [Создайте issue](https://github.com/A1-x-Tech/mcp-avito-ads/issues) или напишите в [Telegram](https://t.me/a1_mcp).

<br>

<p align="center">
  <img src="https://github.com/ztemerbekov/a1-yandex-kit-skills/raw/main/assets/images/mona-hifive-yandex-kit-warm.gif" alt="Две Моны дают пять" width="256">
</p>

<p align="center">
  Вы дочитали до конца!
</p>
