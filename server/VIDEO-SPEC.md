# «Привязать видео» — контракт (06.10.2026)

Владелец: вместо «Сдать работу» — «Привязать видео». Блогер вставляет ссылку на
ролик из своего ПОДТВЕРЖДЁННОГО TikTok; сайт сам берёт данные ролика (просмотры,
лайки, комментарии, репосты), пишет «Подключено». Данные обновляются каждый
день. Ролик проверяется на накрутку — подозрение уходит владельцу (админу).
Рекламодатель проверяет интеграцию: «всё верно» → видео засчитано и считает
просмотры; «есть проблема» + причина → сразу владельцу, решает он.

Источник правды — сервер. Просмотры НИКОГДА не приходят от клиента.

## 1. Правила

- Площадка: только TikTok (у оффера в `platforms` есть `tt`/`tiktok`, либо
  площадки не заданы). Для остальных площадок остаётся старая «Сдать работу».
- Ролик должен:
  1. принадлежать подтверждённому TikTok-каналу блогера — доказательство:
     `POST /v2/video/query/` с его токеном возвращает этот id (TikTok сам
     отдаёт только ролики владельца токена);
  2. быть опубликован ПОСЛЕ создания оффера (`create_time*1000 >= camp.createdAt − 10 мин`);
  3. для видеоформатов — не короче `camp.minDuration || camp.videoMinSec` (если задано);
  4. не быть привязан ни к какому другому заданию (уникален по video_id).
- Блогер подтверждает галочкой «В видео есть реклама из этого задания».
- Окно подсчёта: `VID_WINDOW_DAYS` (env, по умолчанию 7) суток с момента зачёта
  (`approved_at`). Пока окно открыто — данные обновляются раз в сутки, сумма
  растёт. В конце окна сервер делает финальный замер и ПЛАТИТ САМ.
- Сумма (`earned`):
  - `payMode === 'fixed'`: `fixedPrice`, если `minViews` не задан или
    `views >= minViews`; иначе 0;
  - иначе (за просмотры): `floor(views * rate / 1000)`, сверху `maxPayout || payMax`
    (если задан), снизу 0; если задан `minViews` и `views < minViews` → 0.
  - Не больше остатка заморозки `camp:<campId>` (`deals.amount − deals.paid`).
- Выплата — из заморозки бюджета `camp:<campId>` тем же движением, что
  `/api/deals/release`: `hold` рекламодателя −sum, `available` блогера +sum,
  `payDeal`. Ключ операции `sysKey('vidpay', rowId)` → повтор безопасен.
- Заморозка выплаты: если у ролика `risk_hold = 1` (накрутка) или открыт спор
  (`openDisputeFor(camp:<id>, blogger)`) — окно может закончиться, но выплата
  ждёт решения владельца.

## 2. Статусы строки `task_videos.status`

| статус     | значение | кто переводит |
|------------|----------|---------------|
| `review`   | привязано, ждёт проверки рекламодателем | bind |
| `active`   | засчитано, считаем просмотры в окне | рекламодатель «всё верно» / владелец «засчитать» |
| `rejected` | рекламодатель указал проблему, ждёт решения владельца | рекламодатель |
| `declined` | владелец решил не засчитывать (выплаты нет) | владелец |
| `paid`     | окно закрыто, выплачено `paid` ₽ (может быть 0) | сервер |
| `removed`  | ролик удалён/скрыт (дважды подряд не вернулся из query) | сервер |
| `revoked`  | блогер отозвал доступ TikTok / отвязал канал | сервер |

`unbind` — блогер сам удаляет привязку, только в `review` (ошибся ссылкой).

## 3. Таблицы (server.js, рядом с channels/channel_stats)

```sql
CREATE TABLE IF NOT EXISTS task_videos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  camp_id TEXT NOT NULL, owner_id INTEGER NOT NULL, blogger_id INTEGER NOT NULL,
  platform TEXT NOT NULL DEFAULT 'tiktok', external_id TEXT NOT NULL,   -- open_id канала
  video_id TEXT NOT NULL,                       -- СТРОКА: 19 цифр > 2^53
  url TEXT, handle TEXT, title TEXT, duration INTEGER, posted_at INTEGER,  -- posted_at мс
  views INTEGER DEFAULT 0, likes INTEGER DEFAULT 0, comments INTEGER DEFAULT 0, shares INTEGER DEFAULT 0,
  stats_at INTEGER, miss INTEGER DEFAULT 0,      -- miss: подряд не вернулся из query
  status TEXT NOT NULL DEFAULT 'review',
  review_note TEXT, reviewed_at INTEGER, approved_at INTEGER,
  decision TEXT, decision_note TEXT, decided_at INTEGER,
  risk INTEGER, risk_level TEXT, risk_why TEXT, risk_at INTEGER, risk_hold INTEGER DEFAULT 0,
  earned INTEGER DEFAULT 0, paid INTEGER DEFAULT 0, paid_at INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE(platform, video_id)
);
CREATE INDEX IF NOT EXISTS task_videos_camp ON task_videos(camp_id);
CREATE INDEX IF NOT EXISTS task_videos_blogger ON task_videos(blogger_id);
CREATE TABLE IF NOT EXISTS task_video_stats (
  video_row INTEGER NOT NULL, day TEXT NOT NULL,   -- 'YYYY-MM-DD' по UTC
  views INTEGER, likes INTEGER, comments INTEGER, shares INTEGER, at INTEGER,
  PRIMARY KEY(video_row, day)
);
```

## 4. Ручки (JSON, вход через обычную сессию `auth(req)`)

Объект ролика наружу (`vidDTO`), одинаковый для всех ручек:
```
{ id, campId, bloggerId, ownerId, platform:'tiktok', videoId, url, handle, title,
  duration, postedAt, views, likes, comments, shares, statsAt,
  status, reviewNote, reviewedAt, approvedAt, decision, decisionNote, decidedAt,
  windowEndsAt,            // approved_at + VID_WINDOW_DAYS сут (или null)
  earned, paid, paidAt,
  risk, riskLevel, riskWhy: [строки], riskHold,   // riskWhy блогеру НЕ отдаём (только level)
  cover,                   // свежая обложка из последнего query/oembed или null (не хранить надолго)
  player: 'https://www.tiktok.com/player/v1/<videoId>',
  history: [{day, views, likes, comments, shares}]   // только в /api/tasks/video (одна строка)
}
```

- `POST /api/tasks/video/bind {campId, url, agree:true}` → `{ok, video:vidDTO}`
  Ошибки (`{error, code}`; текст — по-русски, готов для показа):
  - 401 нет входа; 429 часто (лимит `vbind` 10/мин);
  - 400 `bad_url` «Это не ссылка на видео TikTok»; 400 `agree` «Подтвердите, что в видео есть реклама из задания»;
  - 404 `no_camp` «Задание не найдено»; 409 `camp_closed` «Задание уже не принимает видео»;
  - 409 `own_camp` «Это ваше задание»; 409 `not_tiktok` «В этом задании нет TikTok»;
  - 409 `no_channel` «Сначала подтвердите свой TikTok в профиле» (нет строки channels/channel_tokens);
  - 409 `token` «Доступ к TikTok истёк — переподключите аккаунт»;
  - 409 `scope` «Переподключите TikTok и разрешите доступ к роликам» (scope_not_authorized / scope_permission_missed);
  - 404 `not_found` «Видео не найдено — проверьте ссылку» (короткая ссылка ведёт на главную, oEmbed 400);
  - 409 `not_yours` «Это видео не с вашего подтверждённого TikTok»;
  - 409 `too_old` «Видео опубликовано раньше, чем появилось задание»;
  - 409 `too_short` «Видео короче N сек — так в условиях задания»;
  - 409 `taken` «Это видео уже привязано к заданию»;
  - 502 `tiktok` «TikTok сейчас не отвечает — попробуйте через минуту».
  Владелец оффера: `q.syncGet.get('camp', campId).a_id`, данные оффера — `JSON.parse(row.data)`
  (поля как в клиенте: status, platforms, rate, payMode, fixedPrice, maxPayout|payMax,
  minViews, minDuration|videoMinSec, createdAt, deadline, name).
  После вставки: снимок дня, оценка накрутки (п. 6), уведомления (п. 7).
- `GET /api/tasks/videos?campId=` →
  - если я владелец оффера: все строки оффера;
  - иначе: мои строки (как блогер), по офферу или все.
  Без campId: мои как блогер + все по моим офферам. Ответ `{ok, videos:[vidDTO]}` (без history).
- `GET /api/tasks/video?id=` → одна строка с `history` (участник или админ).
- `POST /api/tasks/video/review {id, ok:true}` | `{id, ok:false, reason}` — только владелец
  оффера, только из `review`. ok → `active`, `approved_at=now`. Нет → `rejected`,
  `review_note` (5–500 символов), `tgAlert` владельцу (п. 7).
- `POST /api/tasks/video/unbind {id}` — блогер, только `review`.
- `POST /api/tasks/video/refresh {id}` — участник; не чаще раза в 10 минут на ролик
  (иначе `{ok:true, video, fresh:false}`), только для `review|active`.

Админ (`isAdmin`, `adminLog`):
- `GET /api/admin/task-videos?status=queue|rejected|risk|active|all` →
  `{ok, videos:[vidDTO + {campName, ownerEmail, ownerName, bloggerEmail, bloggerName, channelTitle, channelRiskLevel, history}]}`;
  `queue` = `rejected` ∪ (`risk_hold = 1`).
- `POST /api/admin/task-videos/decide {id, decision:'count'|'decline', note}` →
  `count`: снять `risk_hold`; из `rejected` → `active` с `approved_at=now`;
  `decline`: → `declined`. Записать decision/decision_note/decided_at, уведомить обе стороны.
- В `/api/admin/overview` добавить поле `видео_на_решении` (= queue count) для значка.

## 5. Фоновый круг `vidSyncRound` (раз в 30 мин, `.unref()`, защита `vidSyncBusy`)

- Берёт строки `status IN ('review','active')` с `stats_at < now − 20 ч`
  (или окно активной кончилось), группирует по (blogger_id, external_id),
  по 20 id на запрос `video/query` с токеном канала (`ttAccess`). Не больше
  ~200 роликов за круг.
- Обновляет цифры, пишет снимок дня (UPSERT по day), считает накрутку.
- Ролик не вернулся → `miss+1`; при `miss >= 2` → `removed` + уведомление обеим
  сторонам. Нет токена/scope → не трогать цифры, `tgAlert('vid:token:'+blogger)`.
- `active` с истёкшим окном → финальный замер (уже сделан выше) →
  `earned` → выплата (п. 1) → `paid`, `paid_at`; если `risk_hold`/спор — не платить,
  `tgAlert('vid:hold:'+id)` раз в сутки.
- Тот же круг можно вызвать в тестах: экспорт/ручка `POST /api/admin/task-videos/sync` (админ).

## 6. Накрутка — `quality.assessVideo(cur, prevDays, channel)` в quality.js

Вход: текущие цифры ролика, снимки предыдущих дней, база канала
(`channel_stats` последняя строка: med_views, followers, er_likes; `channels.risk_level`).
Выход как у `assess`: `{risk 0..100, level ok|watch|risk|bad, reasons[] по-русски}`.
Признаки (пороги в THRESHOLDS, дополнить):
- лайков на просмотры < `erLikesDead` при views ≥ 2000;
- нет комментариев и репостов при views ≥ 5000;
- просмотров > 25× медианы канала И > 10× подписчиков при низких лайках;
- суточный прирост просмотров > 5× прошлого прироста и > 20 000, а лайков прибавилось
  непропорционально мало (доля новых лайков < 0,3 от обычной);
- канал сам в `risk_level = bad` (+15).
`level >= risk` → `tgAlert('vid:risk:'+id+':'+level, …)` с причинами и ссылкой.
`level === 'bad'` → `risk_hold = 1` (выплата ждёт владельца).

## 7. Уведомления

- Рекламодателю при bind: `pushTo(owner,'Новое видео по заданию', '«<camp>»: проверьте интеграцию', '/?go=campaigns')`
  и, если у него есть `users.tg_id` и `BOT_TOKEN`, личное сообщение ботом (новая
  `tgDM(userId, text)` поверх `tgSendRaw`-подобного вызова с `chat_id=tg_id`).
- Блогеру: при review ok / rejected / decision / removed / paid — `pushTo` + `tgDM`.
- Владельцу (админу): `tgAlert` при rejected («Рекламодатель вернул видео: причина, оффер,
  блогер, ссылка, /admin»), при накрутке, при задержке выплаты. Полоса `server`.

## 7а. Адреса площадки

- `TT_API_BASE` (уже есть) — open.tiktokapis.com.
- Новая `TT_WEB_BASE` (по умолчанию https://www.tiktok.com) — для oEmbed
  (`/oembed?url=`) и раскрытия коротких ссылок. Короткие ссылки (vm./vt.tiktok.com,
  tiktok.com/t/…) раскрываются HEAD-запросами с redirect:'manual', не больше 5
  переходов, только https, только хосты www.tiktok.com, tiktok.com, m.tiktok.com,
  vm.tiktok.com, vt.tiktok.com (в тестах — ещё хост TT_WEB_BASE), таймаут 5 с.
  Переход на главную (`/?_r=1`, путь без /video/) = `not_found`.
- id ролика: `/(?:\/video\/|\/v\/|\/embed\/v2\/|\/player\/v1\/)(\d{15,21})/`.

## 8. Тесты — `server/test-videos.mjs` (в SUITES перед test-guard)

Свой сервер (порт 8110) + поддельный TikTok (8111) через `TT_API_BASE`: отдаёт
`/v2/oauth/token/` (refresh), `/v2/user/info/`, `/v2/video/list/`, `/v2/video/query/`
(возвращает только ролики «своего» токена), `/oembed`. Проверить: все коды ошибок
bind; уникальность; review ok/нет; unbind; права (чужой не видит); admin decide;
vidSyncRound: обновление, снимок дня, miss→removed, выплата в конце окна
(`VID_WINDOW_DAYS=0` в тесте), повтор не платит дважды, risk_hold держит выплату.

## 9. Разбор после аудита (06.10.2026)

Поверх п. 1–8; где расходится — действует этот раздел.

- **Снимок условий.** При привязке в `task_videos.terms` пишется JSON
  `{payMode, rate, fixedPrice, cap, minViews}`. `earned` считается только по
  снимку; у старых строк без снимка он один раз берётся из конверта оффера и
  сразу записывается. `earned` — заработок блогера, остатком заморозки НЕ
  срезается (п. 1 «не больше остатка» отменён).
- **Резерв бюджета.** `POST /api/deals/refund` по `camp:<id>` (не оператор) →
  409 `{code:'videos_live', error:'По офферу есть видео на проверке или в подсчёте — вернуть бюджет можно после выплат по ним'}`,
  пока у оффера есть строки `review|active|rejected`.
  `POST /api/deals/release` по `camp:<id>` → 409 `{code:'videos_reserved', reserved, free, error}`,
  если сумма больше `остаток − резерв`; резерв = Σ max(earned, потолок) − paid
  по живым строкам (потолок — `fixedPrice` или `cap`, если задан).
- **Нехватка денег при выплате.** Платим, что есть; строка остаётся `active`
  с `pay_hold = 1` и `pay_why` («В заморозке кампании не хватило денег:
  недоплачено N ₽»), `paid` может быть больше 0 при `status = active`.
  Блогеру — «заработано N ₽ … задерживается»; «по условиям задания выплаты
  нет» — только при `earned = 0`. Доплата после решения владельца — ключ
  `sys:vidpay:<id>-<paid>`.
- **Решение «засчитать» и накрутка.** `decided_views` — просмотры в момент
  решения о накрутке (если `risk_hold` был). Новая плохая оценка не ставит
  паузу, пока `views ≤ decided_views × 2`. «Засчитать» возвращённый
  рекламодателем ролик от накрутки не освобождает.
- **Нет финального замера.** Через 72 ч после окна без замера сервер НЕ
  платит сам: `pay_hold = 1`, `pay_why` «Нет финального замера: доступ к
  TikTok потерян» (или «…ролик не вернулся из TikTok», если был промах),
  очередь владельца, тревога один раз. «Засчитать» после этого — выплата по
  последнему замеру. Ролик с готовым финальным замером (`stats_at` позже конца
  окна) больше не опрашивается.
- **Отвязка канала** (сам, владелец, канал пропал) снимает в `revoked` только
  `review`; `active` остаются. Обе стороны получают уведомление. Владелец может
  решить по `revoked`: `count` → `active`, `approved_at = now`, `frozen = 1`
  (не опрашивается, платится по текущим цифрам).
- **Очередь круга.** `last_try_at` — каждая попытка освежить; `vidDue` и
  выплаты идут по нему. Строки на паузе (`risk_hold`/`pay_hold`) в выплаты не
  попадают. Промах считается не чаще раза в 20 ч (`last_miss_at`). Ручное
  «Обновить» — не чаще раза в 10 мин по `last_try_at`.
- **Тревога о доступе** (`vid:token`) — раз в сутки на блогера, вместе с
  письмом блогеру «Переподключите TikTok».
- **Повторы.** Отвязка — 5 в час. Письмо рекламодателю о том же ролике в том
  же задании — раз в сутки.
- **Автозачёт.** `review` старше `VID_AUTO_ACCEPT_H` (по умолчанию 72) →
  `active`, `decision = 'auto'`, обеим сторонам «Рекламодатель не ответил за
  3 дня — видео засчитано автоматически». В ответе круга — `autoAccepted`.
- **Видно в очереди.** `queue` и `видео_на_решении` включают `pay_hold = 1` и
  `active` с кончившимся окном и открытым спором.
- **Площадки.** TikTok — если `tt`/`tiktok` есть в `platforms` ИЛИ
  `platformsList` (список, строка или объект `{tt:true}`), либо оба пусты.
- **Новые поля `vidDTO`:** `payHold` (всем), `holdReason` (не блогеру; текст
  `pay_why`), `disputeHeld` (всем; `active` и открыт спор по заданию).
- **Новые колонки `task_videos`:** `terms`, `pay_hold`, `pay_why`,
  `decided_views`, `last_try_at`, `last_miss_at`, `frozen`.
