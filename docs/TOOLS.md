# Инструменты

25 инструментов поверх API Авито Рекламы (`https://api.avito.ru/ads/`, в песочнице —
`/ads-sandbox/`).

Правила, общие для всех инструментов:

- **Аккаунт зафиксирован.** Каждый путь имеет вид `v1/account/{accountID}/...`, id берётся из
  `AVITO_ADS_ACCOUNT_ID`. Ни один инструмент не принимает id аккаунта (`transfer_funds` /
  `transfer_bonus` принимают только *получателя*).
- **Любой результат — `{data, apiPointBalance}`**, сериализованный компактным JSON.
  `apiPointBalance` — это заголовок `Api-Point-Balance`: остаток недельных баллов, которые
  пополняются по понедельникам в 00:00 UTC, или `null`, если API его не прислал. Ошибки приходят
  как `isError: true` с текстом сообщения; при ошибке API добавляются ещё `Retry-After` (как его
  прислал сервер, без ограничения сверху) и остаток баллов, с которым вызов не прошёл, — благодаря
  этому на 429 можно осмысленно отреагировать.
- **Списочные инструменты** — это POST-эндпоинты с телом `{filter, limit, page}`; `limit` — от 1
  до 100 (по умолчанию 20), `page` нумеруется с 1 (по умолчанию 1). Возвращают
  `{total, items, page, limit, hasNextPage}`.
- **Инструменты статистики** принимают пару `dateFrom`/`dateTo` в формате `YYYY-MM-DD`,
  включительно, с интервалом не больше **100 дней**. Диапазон проверяется до запроса, поэтому
  неверный не стоит баллов.
- Деньги — в рублях. Минимум для `budget`, `price` и `amount` при переводе — 1.

## Аккаунт

### `get_account`

Юридические реквизиты настроенного рекламного аккаунта. **Параметры:** нет.
**Ответ:** запись аккаунта — `inn`, `kpp`, `ogrn`, `shortName`, `longName`, `legalAddress`,
`actualAddress` и блоки контакта и менеджера. Денежных сумм нет (см. `get_balance`).
`GET v1/account/{accountID}`.

### `get_balance`

Текущий баланс настроенного аккаунта — срез на момент вызова, а не история.
**Параметры:** нет. **Ответ:** `{balance, bonusBalance}` — настоящие рубли и бонусные, которые
можно потратить только на рекламу. `GET v1/account/{accountID}/balance`.

### `create_sandbox_account`

**Только в песочнице** — создаёт тестовый аккаунт рекламодателя. Сервер отклоняет вызов, если
`AVITO_ADS_ENVIRONMENT` не равен `sandbox`, и отказ не стоит ни одного балла API; эндпоинт
обращается к пути *настроенного* аккаунта, так что пробовать его на продакшене не стоит.
Запущенный сервер продолжает работать с `AVITO_ADS_ACCOUNT_ID`: новый id не подхватывается.

**Попытка одна.** Второй вызов отвечает `403 нельзя создать второй аккаунт в песочнице` —
песочница разрешает ровно один аккаунт на ключ. Тестовые кампании, группы и креативы, ради которых
песочница и нужна, создаются *в момент создания аккаунта* и только если у аккаунта уже есть
действующий договор; иначе аккаунт всё равно создаётся, но с предупреждением `не удалось создать
тестовые кампании, группы и креативы: актуальный договор аккаунта не найден`, и регистрация
договора задним числом их не добавит.

Форматы полей проверяются на стороне API, и отказы строгие: у `inn` и `ogrn` сверяется контрольная
сумма, адрес должен выглядеть как `127015, г. Москва, ул. Лесная, д. 7`, а телефон внутри
`contact` — как `+71234567890`.

| Параметр | Тип | Обяз. | Примечания |
|---|---|---|---|
| `inn` | string | да | 10 цифр для юрлица, 12 для ИП. |
| `shortName` | string | да | Краткое юридическое наименование. |
| `longName` | string | да | Полное юридическое наименование. |
| `ogrn` | string | да | ОГРН (юрлицо) / ОГРНИП (ИП). |
| `legalAddress` | string | да | Юридический адрес. |
| `actualAddress` | string | да | Фактический адрес; может повторять `legalAddress`. |
| `contact` | object | да | Непустой; ключи — `name` / `email` / `phone`, передаются как есть. Телефон внутри проверяет API. |
| `kpp` | string | нет | Только для юрлиц (`ul`). |
| `legalType` | `ul` \| `ip` | нет | Юрлицо или ИП. |

**Ответ:** созданный аккаунт вместе с его `accountID`. `POST v1/account/{accountID}`.

## Дочерние аккаунты и деньги

### `list_child_accounts`

Дочерние аккаунты (субаккаунты) настроенного агентского аккаунта. **Параметры:** нет — ни
постраничной выдачи, ни фильтров.
**Ответ:** массив `{account: {id, shortName}, contract}`. Балансов в нём нет.
`GET v1/account/{accountID}/children`.

### `list_child_accounts_with_balances`

Тот же список плюс `{balance, bonusBalance}` каждого дочернего аккаунта. **Параметры:** нет.
Годится, чтобы перед переводом увидеть, у кого кончились деньги, и чтобы убедиться, что перевод
дошёл.
`GET v1/account/{accountID}/children-with-balances`.

### `create_child_account`

Создаёт дочерний аккаунт-**неплательщик** под настроенным агентским аккаунтом. Неплательщик —
значит не может пополнить себя сам: деньги заводятся в него через `transfer_funds`.

| Параметр | Тип | Обяз. | Примечания |
|---|---|---|---|
| `shortName` | string | да | Отображаемое имя нового аккаунта. |
| `isSelfAdvertisingEnabled` | boolean | да | Может ли дочерний аккаунт рекламировать собственные товары и услуги. |

**Ответ:** `{accountID, clientKey, clientSecret}` — собственные доступы дочернего аккаунта к API,
выдаются **только здесь**; сохраните их сразу — повторно прочитать нельзя.
`POST v1/account/{accountID}/create-nonpayer-child-account`.

### `transfer_funds`

Переводит **настоящие деньги** с настроенного аккаунта на другой (обычно дочерний). Необратимо:
отменить и откатить нельзя, журнала переводов нет.

| Параметр | Тип | Обяз. | Примечания |
|---|---|---|---|
| `accountIdTo` | integer | да | Id аккаунта-получателя. Отправитель — всегда настроенный аккаунт. |
| `amount` | number | да | Рубли, минимум 1. |

**Ответ:** при успехе — пустой объект данных; любой ответ без ошибки означает, что перевод
выполнен, и повторять вызов нельзя. После сетевой ошибки или ошибки сервера результат неизвестен:
перед повтором проверьте `list_child_accounts_with_balances`.
`POST v1/account/{accountID}/funds-transfer`.

### `transfer_bonus`

То же, что `transfer_funds`, но переводит бонусные рубли (`bonusBalance` — промо-средства, которые
тратятся на рекламу и не выводятся деньгами). Параметры: `accountIdTo`, `amount` (минимум 1).
`POST v1/account/{accountID}/bonus-transfer`.

## ОРД: рекламодатели и договоры

Закон о маркировке рекламы требует, чтобы у каждой кампании были указаны зарегистрированный
рекламодатель и договор, по которому она идёт. Обе сущности здесь работают **только на
добавление** — ни изменения, ни удаления.

### `create_advertiser`

Регистрирует рекламодателя (контрагента ОРД).

| Параметр | Тип | Обяз. | Примечания |
|---|---|---|---|
| `inn` | string | да | 10 цифр для `ul`, 12 для `ip`. |
| `shortName` / `longName` | string | да | Юридические наименования. |
| `ogrn` | string | да | ОГРН (юрлицо) / ОГРНИП (ИП). |
| `legalAddress` / `actualAddress` | string | да | Юридический и фактический адреса. |
| `legalRole` | `rd` \| `ra` \| `rr` | да | Рекламодатель / рекламное агентство / рекламораспространитель. |
| `legalType` | `ul` \| `ip` | да | Юрлицо / ИП. |
| `kpp` | string | нет | Только для юрлиц (`ul`). |

**Ответ:** `{id}` — на него ссылаются кампании и договоры.
`POST v1/account/{accountID}/create-advertiser`.

### `list_advertisers`

Одна страница зарегистрированных рекламодателей. Полнотекстового поиска нет — сопоставлять по
названиям придётся самостоятельно.

| Параметр | Тип | Примечания |
|---|---|---|
| `filter.ids` | integer[] | Только эти id рекламодателей. |
| `filter.inns` | string[] | Только эти ИНН. |
| `filter.roles` | (`rd`\|`ra`\|`rr`)[] | Только эти роли ОРД. |
| `limit` / `page` | integer | 1..100 (по умолчанию 20) / нумерация с 1. |

Неизвестные ключи фильтра передаются как есть. **Ответ:** страница записей с полями `id`,
`shortName`, `longName`, `inn`, `ogrn`, `kpp`, `legalAddress`, `actualAddress`, `legalType`,
`legalRole`. `POST v1/account/{accountID}/advertisers`.

### `create_contract`

Регистрирует договор ОРД между аккаунтом и рекламодателем. Набор обязательных полей зависит от
`type`; правила проверяются до запроса, поэтому неверная комбинация не стоит баллов:

| `type` | Требует | Не допускает |
|---|---|---|
| `service` | `subject`, `isReportingRequired`, `date`, `number` | `cid` |
| `intermediary` | то же плюс `object`, `isFundsAllocationToPrincipal` | `cid` |
| `external` | `cid` | `parentId` |

| Параметр | Тип | Примечания |
|---|---|---|
| `advertiserId` | integer | Обязательный. Заказчик, из `list_advertisers`. |
| `type` | `service` \| `intermediary` \| `external` | Обязательный. |
| `counterpartyType` | `direct_with_advertiser` \| `advertiser_intermediary` | Обязательный. Уходит в поле API `description`. |
| `subject` | `org-distribution` \| `mediation` \| `distribution` \| `representation` \| `other` | По таблице выше. |
| `object` | `distribution` \| `conclude` \| `commercial` \| `other` | Действие по договору. |
| `cid` | string | Внешний id договора (на стороне ERID). |
| `date` | string | `YYYY-MM-DD`. |
| `number` | string | Номер договора. |
| `isReportingRequired` | boolean | Нужны акты / отчёты. |
| `isFundsAllocationToPrincipal` | boolean | Средства распределяются принципалу. |
| `parentId` | integer | Задаётся, чтобы зарегистрировать **дополнительное соглашение**; тогда `intermediary` указывать нельзя. |
| `intermediary` | object | Реквизиты исполнителя (`inn` обязателен; `shortName`, `longName`, `ogrn`, `kpp`, `legalAddress`, `actualAddress`, `legalType` и любые дополнительные ключи). Обязателен, если не задан `parentId`. |

**Ответ:** `{id}`. `POST v1/account/{accountID}/create-contract`.

### `list_contracts`

Одна страница зарегистрированных договоров.

| Параметр | Тип | Примечания |
|---|---|---|
| `filter.ids` | integer[] | Только эти id договоров. |
| `filter.numbers` | string[] | Только эти номера договоров. |
| `filter.clients` | integer[] | Только договоры, заказчик которых — один из этих рекламодателей (по id). |
| `filter.contractors` | integer[] | Только эти id исполнителей (посредников). |
| `limit` / `page` | integer | 1..100 (по умолчанию 20) / нумерация с 1. |

**Ответ:** страница записей с полями `id`, `type`, `number`, `date`, `subject`, `object`, `cid`,
`description` (тип контрагента), `parentId` у дополнительных соглашений и реквизитами заказчика и
исполнителя. `POST v1/account/{accountID}/contracts`.

## Кампании, группы, креативы

Только чтение плюс две записи на уровне группы объявлений. Кампании, группы и креативы нельзя
создавать, редактировать, ставить на паузу, возобновлять, архивировать и удалять, а таргетинги API
не отдаёт.

У всех трёх списочных инструментов одинаковая форма: именованные поля фильтра (объединяются по И,
каждое оставляет только перечисленные в нём значения), сырой `filter` для всего остального — он
подмешивается под них (именованные поля важнее), плюс `limit` и `page`. Списки id переименовываются
в то написание, которое ждёт API (`campaignIds` → `campaignIDs`, `groupIds` → `groupIDs`,
`contractIds` → `contractIDs`, `additionalAgreementIds` → `additionalAgreementIDs`).
Фильтры по датам — `{from, to}`, оба конца в формате `YYYY-MM-DD`.

### `list_campaigns`

| Параметр | Тип | Примечания |
|---|---|---|
| `ids` | integer[] | Оставить только эти id кампаний. |
| `statuses` | string[] | `draft`, `in_moderation`, `moderation_failed`, `partial_moderation`, `active`, `paused`, `stopped`, `finished`, `archived`. |
| `campaignTypes` | (`textImage`\|`HTML`\|`video`)[] | |
| `paymentModels` | (`CPM`\|`CPC`)[] | |
| `advertisers` / `managers` | integer[] | Id рекламодателей / менеджеров (пользователей аккаунта). |
| `contractIds` / `additionalAgreementIds` | integer[] | Id документов ОРД. |
| `createdAt` | `{from, to}` | Диапазон дат создания. |
| `timeFrame` | `{from, to}` | Диапазон сроков размещения. |
| `filter` | object | Дополнительные ключи фильтра в написании API. |
| `limit` / `page` | integer | 1..100 (по умолчанию 20) / нумерация с 1. |

**Ответ:** страница кампаний с полями `id`, `name`, `status`, `budget`, `paymentModel`,
`campaignType`, `startDate` / `endDate`, `advertiserId`, `contractId`, `managerID` и отметками
времени. `POST v1/account/{accountID}/campaigns`.

### `list_groups`

Группа объявлений — это уровень, на котором лежат деньги.

| Параметр | Тип | Примечания |
|---|---|---|
| `ids` | integer[] | Оставить только эти id групп объявлений. |
| `campaignIds` | integer[] | Группы этих кампаний. |
| `statuses` | string[] | `draft`, `in_moderation`, `moderation_failed`, `will_launch_soon`, `active`, `will_stop_soon`, `pausing`, `paused`, `unpausing`, `stopped`, `finished`, `archived`. |
| `paymentModels` | (`CPM`\|`CPC`)[] | |
| `paces` | string[] | Режимы распределения бюджета; произвольные строки — фиксированного словаря в SDK нет. |
| `advertisers` / `managers` | integer[] | |
| `timeFrame` | `{from, to}` | Диапазон сроков размещения. |
| `filter` | object | Дополнительные ключи фильтра. |
| `limit` / `page` | integer | |

**Ответ:** страница групп с полями `id`, `name`, `campaignID`, `status`, `budget` и `price`
(ставка) в рублях, `paymentModel`, `campaignType`, `advertiserID`, `haveCreative` и отметками
времени. `POST v1/account/{accountID}/groups`.

### `list_creatives`

| Параметр | Тип | Примечания |
|---|---|---|
| `ids` | integer[] | Оставить только эти id креативов. |
| `groupIds` / `campaignIds` | integer[] | Креативы этих групп / кампаний. |
| `statuses` | string[] | `draft`, `ready_for_moderation`, `in_moderation`, `moderation_failed`, `erir_registration`, `active`, `paused`, `stopped`, `finished`, `archived`. |
| `campaignTypes` | (`textImage`\|`HTML`\|`video`)[] | |
| `paymentModels` | (`CPM`\|`CPC`)[] | |
| `advertisers` / `managers` | integer[] | |
| `timeFrame` | `{from, to}` | Диапазон сроков размещения. |
| `filter` | object | Дополнительные ключи фильтра. |
| `limit` / `page` | integer | |

**Ответ:** страница креативов с полями `id`, `name`, `title`, `description`, `buttonText`, `link`,
`status`, `groupID`, `campaignID`, `advertiserID`, `paymentModel`, `campaignType` и `legalInfo`
(данные реестра рекламы / ERID). `POST v1/account/{accountID}/creatives`.

### `change_group_budget`

Задаёт бюджет одной группы объявлений. Значение **заменяет** текущий бюджет, а не прибавляется к
нему, поэтому повторный вызов безопасен. Принимают его только группы с ручным управлением ставками.

| Параметр | Тип | Примечания |
|---|---|---|
| `groupId` | integer | Из `list_groups`. |
| `budget` | number | Рубли, не меньше 1. |

**Ответ:** подтверждение от API. `POST v1/account/{accountID}/group/{groupID}/change-budget`.

### `change_group_price`

Задаёт ставку одной группы объявлений (в API она называется `price`). Единица зависит от
`paymentModel` группы: рубли за 1000 показов при CPM, рубли за клик при CPC. Заменяет, а не
прибавляет. Только для групп с ручным управлением ставками.

| Параметр | Тип | Примечания |
|---|---|---|
| `groupId` | integer | Из `list_groups`. |
| `price` | number | Рубли, не меньше 1. |

**Ответ:** подтверждение от API. `POST v1/account/{accountID}/group/{groupID}/change-price`.

## Статистика

Метрики в каждой строке: `views` (показы), `clicks`, `ctr`, `spend`, `spendBonus`, `cpm`, `cpc`, а
для видеокампаний ещё `videoViews25/50/75/100`, `q25/q50/q75`, `vtr`. Деньги — в рублях;
коэффициенты передаются ровно так, как их отдаёт API. У каждой сущности есть `data[]` (по строке
на день, с отметкой `timestamp`) и `totalData` (итог за период). Разбивки мельче дня нет, как и
агрегации по нескольким кампаниям.

### `campaign_stats`

Статистика **одной** кампании вместе с разбивкой по группам и по креативам.

| Параметр | Тип | Примечания |
|---|---|---|
| `campaignId` | integer | Из `list_campaigns`. |
| `dateFrom` / `dateTo` | `YYYY-MM-DD` | Включительно; интервал не больше 100 дней. |

**Ответ:** `{campaign, groups[], creatives[]}`.
`POST v1/account/{accountID}/campaigns/{campaignID}/stats`.

### `group_stats`

Статистика по перечисленным группам одной кампании — плоский массив
`{id, name, paymentModel, campaignType, data[], totalData}`, без итогов по кампании. Инструмент
сужает выборку, а не перечисляет всё: разбивка по всем группам уже есть в `campaign_stats`. Список
id уходит в API как `groupIDs` и передаётся ровно в том виде, в каком задан, — в SDK этот аргумент
обязателен, а смысл пустого списка нигде не описан.

| Параметр | Тип | Примечания |
|---|---|---|
| `campaignId` | integer | Обязательный. |
| `dateFrom` / `dateTo` | `YYYY-MM-DD` | Обязательные, включительно, ≤ 100 дней. |
| `groupIds` | integer[] | Обязательный. Группы, по которым нужен отчёт; для всех сразу — `campaign_stats`. |

`POST v1/account/{accountID}/campaigns/{campaignID}/groups/stats`.

### `creative_stats`

Статистика по перечисленным креативам одной кампании — плоский массив
`{id, name, groupId, paymentModel, campaignType, data[], totalData}`. Правило то же, что у
`group_stats`: список id обязателен и уходит в API как `creativeIDs`; чтобы получить все креативы
кампании, нужен `campaign_stats`.

| Параметр | Тип | Примечания |
|---|---|---|
| `campaignId` | integer | Обязательный. |
| `dateFrom` / `dateTo` | `YYYY-MM-DD` | Обязательные, включительно, ≤ 100 дней. |
| `creativeIds` | integer[] | Обязательный. Креативы, по которым нужен отчёт; для всех сразу — `campaign_stats`. |

`POST v1/account/{accountID}/campaigns/{campaignID}/creatives/stats`.

## Пользователи

Работают только с настроенным аккаунтом — пользователями дочернего аккаунта эти инструменты не
управляют.

### `list_users`

**Параметры:** нет. **Ответ:** по одной записи `{id, role, hasLoggedIn}` на пользователя, где
`role` — `admin` или `viewer`, а `hasLoggedIn` показывает, заходил ли приглашённый хоть раз.
`GET v1/account/{accountID}/users`.

### `add_user`

Выдаёт доступ существующему пользователю Авито. Пригласить по email или телефону нельзя, создать
аккаунт Авито — тоже; если доступ у пользователя уже есть, нужен `set_user_role`.

| Параметр | Тип | Примечания |
|---|---|---|
| `userId` | integer | Числовой id пользователя Авито. |
| `role` | `admin` \| `viewer` | `admin` — полный доступ (пользователи, переводы, правки кампаний); `viewer` — только чтение. |

`POST v1/account/{accountID}/add-user`.

### `set_user_role`

Меняет роль пользователя, у которого уже есть доступ. Назначение той же роли, что и сейчас, ничего
не меняет. Доступ при этом не выдаётся и не отзывается. Параметры: `userId`, `role`.
`POST v1/account/{accountID}/set-user-role`.

### `delete_user`

Отзывает доступ пользователя. Операция разрушительная: вернуть доступ можно только через
`add_user` с явным указанием роли. Аккаунт Авито этого человека, его кампании и историю расходов
инструмент не удаляет. **Параметр:** `userId`. `DELETE v1/account/{accountID}/delete-user/{userID}`.

## Универсальный запрос

### `raw_request`

Вызывает напрямую любой путь API Авито Рекламы — для эндпоинтов, у которых нет отдельного
инструмента.

| Параметр | Тип | Примечания |
|---|---|---|
| `path` | string | Относительно корня API, например `v1/account/{accountID}/groups`. Подстановка `{accountID}` буквально заменяется на настроенный id аккаунта. |
| `method` | `GET` \| `POST` \| `DELETE` | По умолчанию `GET`. |
| `body` | object | Уходит как JSON. С `GET` не принимается — фильтруемые чтения этот API отдаёт по POST. |
| `confirmWrite` | boolean | Должен быть `true` для `POST` и `DELETE`, которыми этот API отдаёт ещё и списки со статистикой. |

Путь, который разрешается в чужой origin или вылезает за корень API (`../token`), отклоняется ещё
до отправки запроса — Bearer-токен не утечёт на другой хост. Так же отклоняется путь к другому
аккаунту (`v1/account/999/funds-transfer`): проверка идёт по уже разрешённому пути, поэтому `..`
её не обойдёт, и id аккаунта остаётся тем, что задан в `AVITO_ADS_ACCOUNT_ID`. Инструмент помечен
как **разрушительный** (destructive), потому что дотягивается до любого эндпоинта записи, включая
перевод средств и `delete_user`, и делает это без клиентских проверок, которые есть у
специализированных инструментов, — об этом сказано и в его описании, потому что только этот текст
читает модель.
**Ответ:** сырое тело ответа плюс `apiPointBalance`.

## Переменные окружения

| Переменная | Обяз. | По умолчанию | Описание |
|---|---|---|---|
| `AVITO_ADS_CLIENT_ID` | да | — | OAuth2 client id (Client Key). |
| `AVITO_ADS_CLIENT_SECRET` | да | — | OAuth2 client secret. Относитесь к нему как к паролю. |
| `AVITO_ADS_ACCOUNT_ID` | да | — | Id рекламного аккаунта, целое положительное число (только цифры). |
| `AVITO_ADS_ENVIRONMENT` | нет | `production` | `production` или `sandbox` (префикс `ads` / `ads-sandbox`). |
| `AVITO_ADS_TIMEOUT_MS` | нет | `30000` | Таймаут одного запроса, мс; включает чтение тела ответа. |
| `AVITO_ADS_MAX_RETRIES` | нет | `4` | Повторы при 429 (всегда) и при 5xx / сетевых ошибках — для чтений. |
| `AVITO_ADS_TOKEN_LEEWAY_SECONDS` | нет | `60` | За сколько секунд до истечения обновлять токен. |
| `AVITO_ADS_API_BASE` | нет | `https://api.avito.ru/ads/` | Переопределение корня API; заменяет префикс окружения. |
