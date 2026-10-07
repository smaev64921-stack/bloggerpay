/* «Загрузить видео» — механика v2 (контракт — server/VIDEO-SPEC.md, раздел 10).

   Блогер загружает ролик со своего подтверждённого TikTok или YouTube,
   сервер сам берёт цифры у площадки и резервирует под ролик оценку из
   бюджета; рекламодатель проверяет интеграцию, и засчитанный ролик
   оплачивается СРАЗУ — по свежему замеру, один раз. Владелец решает
   спорное. Лидерборд и участники задания — /api/tasks/board.

   Настоящие площадки не нужны: поднимаем поддельный TikTok (8111) и
   поддельный Google (8112) и подставляем их в TT_* и YT_API_BASE /
   YT_OAUTH_BASE. TikTok, как и настоящий, по video/query отдаёт ТОЛЬКО
   ролики владельца токена; id роликов — 19 цифр и уходят из подделки
   ЧИСЛОМ: так проверяем, что сервер не округляет их до соседнего ролика.
   Google отдаёт ролик по ключу или по доступу канала, закрытый — только
   владельцу.

   Основной сервер (8110) — без YT_API_KEY: YouTube спрашивается доступом
   канала и обновляет его по refresh. Второй сервер (8113) — с ключом.

   Каналы подтверждаем тем же путём, что и в жизни: start → возврат с
   площадки → confirm по пропуску (как в test-return.mjs).

   TRUST_PROXY=1 и свой X-Forwarded-For на каждый запрос — иначе запросы
   с петли не ограничиваются вовсе, и лимит 429 не проверить.

   Запуск: node test-videos.mjs (свои серверы поднимает сам). */

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = 8110;
const FAKE = 8111;
const FAKEG = 8112;
const PORTK = 8113;
const BASE = 'http://127.0.0.1:' + PORT;
const BASEK = 'http://127.0.0.1:' + PORTK;
const TT = 'http://127.0.0.1:' + FAKE;
const GG = 'http://127.0.0.1:' + FAKEG;
const KEY = 'video-test-admin-key';   /* в заголовке — только латиница */
const YT_KEY = 'yt-test-key';

let passed = 0, failed = 0;
function ok(c, name, extra) {
  if (c) { passed++; console.log('  ok  ' + name); }
  else { failed++; console.log('  FAIL ' + name + (extra !== undefined ? '  ← ' + JSON.stringify(extra).slice(0, 400) : '')); }
}

/* ── Поддельный TikTok ─────────────────────────────────────────────── */
const nowS = () => Math.floor(Date.now() / 1000);
const ACC = {
  /* У A первый токен живёт секунду: сервер обязан обменять его по refresh. */
  'code-A': { open_id: 'chan-A', username: 'blogera', name: 'Блогер А', followers: 5000, access: 'tok-A1', refresh: 'ref-A', expires: 1 },
  'code-B': { open_id: 'chan-B', username: 'blogerb', name: 'Блогер Б', followers: 1000, access: 'tok-B', refresh: 'ref-B', expires: 86400 },
  /* S: доступ есть, но права на ролики не дали. */
  'code-S': { open_id: 'chan-S', username: 'blogers', name: 'Блогер С', followers: 100, access: 'tok-S', refresh: 'ref-S', expires: 86400, scopeless: true },
  /* X: доступ протух, и обменять его не на что. */
  'code-X': { open_id: 'chan-X', username: 'blogerx', name: 'Блогер Икс', followers: 100, access: 'tok-X', refresh: 'ref-X', expires: 1 },
  /* D — условия, резерв, накрутка, гонка. */
  'code-D': { open_id: 'chan-D', username: 'blogerd', name: 'Блогер Д', followers: 1000, access: 'tok-D', refresh: 'ref-D', expires: 86400 },
  /* E — у него доступ к TikTok потом умрёт (замер при зачёте не удастся). */
  'code-E': { open_id: 'chan-E', username: 'blogere', name: 'Блогер Е', followers: 1000, access: 'tok-E', refresh: 'ref-E', expires: 86400 },
  /* F — два TikTok-аккаунта у одного человека (выбор аккаунта). */
  'code-F1': { open_id: 'chan-F1', username: 'blogerf1', name: 'Блогер Ф один', followers: 1000, access: 'tok-F1', refresh: 'ref-F1', expires: 86400 },
  'code-F2': { open_id: 'chan-F2', username: 'blogerf2', name: 'Блогер Ф два', followers: 1000, access: 'tok-F2', refresh: 'ref-F2', expires: 86400 },
  /* G, H — лидерборд и участники. */
  'code-G': { open_id: 'chan-G', username: 'blogerg', name: 'Блогер Г', followers: 1000, access: 'tok-G', refresh: 'ref-G', expires: 86400 },
  'code-H': { open_id: 'chan-H', username: 'blogerh', name: 'Блогер Аш', followers: 1000, access: 'tok-H', refresh: 'ref-H', expires: 86400 },
  /* Y — у него и YouTube, и TikTok. */
  'code-Y': { open_id: 'chan-Y', username: 'blogery', name: 'Блогер Игрек', followers: 1000, access: 'tok-Y', refresh: 'ref-Y', expires: 86400 },
  /* U — отвяжет канал, пока сервер ждёт площадку. P — оплаченный ролик и умерший доступ. */
  'code-U': { open_id: 'chan-U', username: 'bloggeru', name: 'Блогер У', followers: 1000, access: 'tok-U', refresh: 'ref-U', expires: 86400 },
  'code-P': { open_id: 'chan-P', username: 'bloggerp', name: 'Блогер П', followers: 1000, access: 'tok-P', refresh: 'ref-P', expires: 86400 },
};
const TOKENS = { 'tok-A1': 'chan-A', 'tok-A2': 'chan-A', 'tok-B': 'chan-B', 'tok-S': 'chan-S', 'tok-X': 'chan-X',
  'tok-D': 'chan-D', 'tok-E': 'chan-E', 'tok-F1': 'chan-F1', 'tok-F2': 'chan-F2', 'tok-G': 'chan-G', 'tok-H': 'chan-H',
  'tok-Y': 'chan-Y', 'tok-U': 'chan-U', 'tok-P': 'chan-P' };
const REFRESH = { 'ref-A': { access_token: 'tok-A2', refresh_token: 'ref-A', expires_in: 86400 } };
const accByOpen = (o) => Object.values(ACC).find((a) => a.open_id === o);

const ID = {
  A1: '7412345678901234561', A2: '7412345678901234562', A3: '7412345678901234563',
  A4: '7412345678901234564', A5: '7412345678901234565', AOLD: '7412345678901234566',
  ASHORT: '7412345678901234567',
  B1: '7412345678901234571', B2: '7412345678901234572', B3: '7412345678901234573', B4: '7412345678901234574',
  BOOM: '7999999999999999999', NONE: '7400000000000000999',
  A6: '7412345678901234568',
  A7: '7412345678901234601', A8: '7412345678901234602', A9: '7412345678901234603', A10: '7412345678901234604',
  A11: '7412345678901234605', A12: '7412345678901234606', A13: '7412345678901234607', A14: '7412345678901234608',
  D1: '7412345678901234581', D2: '7412345678901234582', D3: '7412345678901234583', D4: '7412345678901234584',
  D5: '7412345678901234585', D6: '7412345678901234586', D7: '7412345678901234587',
  E1: '7412345678901234591', E2: '7412345678901234592', E3: '7412345678901234593', E4: '7412345678901234594',
  F1a: '7412345678901234611', F1b: '7412345678901234612', F2a: '7412345678901234613', F2b: '7412345678901234614',
  G1: '7412345678901234621', H1: '7412345678901234631',
  E5: '7412345678901234595', E6: '7412345678901234596', E7: '7412345678901234597',
  D8: '7412345678901234588', D9: '7412345678901234589',
  A15: '7412345678901234609', A16: '7412345678901234610',
  U1: '7412345678901234671', P1: '7412345678901234681',
};
const V = new Map();
function vid(id, owner, o) {
  V.set(id, Object.assign({ owner, create_time: nowS() - 60, duration: 40, views: 1000, likes: 100,
    comments: 5, shares: 3, title: 'Ролик ' + id.slice(-3) }, o || {}));
}
vid(ID.A1, 'chan-A', { views: 1500, likes: 150, comments: 10, shares: 5 });
vid(ID.A2, 'chan-A');
vid(ID.A3, 'chan-A');
vid(ID.A4, 'chan-A');
vid(ID.A5, 'chan-A', { views: 4000, likes: 400 });
vid(ID.AOLD, 'chan-A', { create_time: nowS() - 30 * 86400 });
vid(ID.ASHORT, 'chan-A', { duration: 10 });
vid(ID.BOOM, 'chan-A');
vid(ID.B1, 'chan-B', { views: 3000, likes: 300 });
/* Плохой ролик: сто тысяч просмотров, сотня лайков, тишина — у канала,
   где обычно смотрят пятьсот человек. */
vid(ID.B2, 'chan-B', { views: 100000, likes: 100, comments: 0, shares: 0 });
vid(ID.B3, 'chan-B', { views: 2000, likes: 200 });
vid(ID.B4, 'chan-B');
/* Обычные старые ролики Б и Д — из них сервер считает базу канала. */
for (let i = 0; i < 6; i++) {
  vid('74000000000000001' + i + '0', 'chan-B', { create_time: nowS() - (40 + i) * 86400, views: 450 + i * 20, likes: 45, comments: 3, shares: 1 });
  vid('74000000000000002' + i + '0', 'chan-D', { create_time: nowS() - (40 + i) * 86400, views: 450 + i * 20, likes: 45, comments: 3, shares: 1 });
}
vid(ID.A6, 'chan-A');
vid(ID.A7, 'chan-A');
vid(ID.A8, 'chan-A');
vid(ID.A9, 'chan-A');
vid(ID.A10, 'chan-A');                                         /* вышел минуту назад — после срока «late» */
vid(ID.A11, 'chan-A', { create_time: nowS() - 50 * 60 });       /* вышел до срока «late» */
vid(ID.A12, 'chan-A');
vid(ID.A13, 'chan-A', { views: 3000, likes: 300 });
vid(ID.A14, 'chan-A', { views: 3000, likes: 300 });
vid(ID.D1, 'chan-D', { views: 5000, likes: 500 });
vid(ID.D2, 'chan-D', { views: 3000, likes: 300 });
vid(ID.D3, 'chan-D', { views: 100000, likes: 100, comments: 0, shares: 0 });
vid(ID.D4, 'chan-D');
vid(ID.D5, 'chan-D', { views: 5000, likes: 500 });
vid(ID.D6, 'chan-D');
vid(ID.D7, 'chan-D');
vid(ID.E1, 'chan-E');
vid(ID.E2, 'chan-E');
vid(ID.E3, 'chan-E');
vid(ID.E4, 'chan-E');
vid(ID.F1a, 'chan-F1', { views: 2000, likes: 200 });
vid(ID.F1b, 'chan-F1', { views: 2000, likes: 200 });
vid(ID.F2a, 'chan-F2', { views: 3000, likes: 300 });
vid(ID.F2b, 'chan-F2', { views: 3000, likes: 300 });
vid(ID.G1, 'chan-G', { views: 2000, likes: 200 });
vid(ID.H1, 'chan-H', { views: 5000, likes: 500 });
vid(ID.E5, 'chan-E');
vid(ID.E6, 'chan-E');
vid(ID.E7, 'chan-E');
vid(ID.D8, 'chan-D', { views: 4000, likes: 400 });
vid(ID.D9, 'chan-D', { views: 3000, likes: 300 });
vid(ID.A15, 'chan-A');
vid(ID.A16, 'chan-A');
vid(ID.U1, 'chan-U');
vid(ID.P1, 'chan-P', { views: 2000, likes: 200 });
/* Ролики, на которых площадка «задумывается» — для проверки гонки. */
const SLOW = new Set();
/* Ролики, на которых площадка падает (500) — сбой площадки, а не доступа. */
const DOWN = new Set();

/* Ответ с id ЧИСЛОМ, как может прислать площадка: 19 цифр не влезают в double. */
function sendVideos(res, list, extra) {
  const txt = JSON.stringify(Object.assign({ data: Object.assign({ videos: list }, extra || {}), error: { code: 'ok', message: '' } }))
    .replace(/"id":"(\d+)"/g, '"id":$1');
  res.end(txt);
}
const asTT = (id, v) => ({
  id, create_time: v.create_time, cover_image_url: TT + '/cover/' + id + '.jpg',
  share_url: TT + '/@' + accByOpen(v.owner).username + '/video/' + id + '?_r=1',
  title: v.title, video_description: v.title, duration: v.duration,
  like_count: v.likes, comment_count: v.comments, share_count: v.shares, view_count: v.views,
});
const fakeLog = [];
/* Личные сообщения бота (tgDM): та же подделка играет и Телеграм. */
const dms = [];
const dmsTo = (u, re) => dms.filter((m) => String(m.chat_id) === String(u.tg) && (!re || re.test(m.text)));

const fake = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const u = new URL(req.url, TT);
    /* Телеграм: бот в том же процессе опрашивает getUpdates — отвечаем
       пусто и не сразу, чтобы он не крутился вхолостую. */
    if (u.pathname.startsWith('/bot')) {
      const method = u.pathname.split('/').pop();
      let data = {};
      try { data = JSON.parse(raw || '{}'); } catch (e) { data = {}; }
      if (method === 'sendMessage') dms.push({ chat_id: data.chat_id, text: String(data.text || '') });
      const reply = () => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true, result: method === 'getUpdates' ? []
          : { id: 1, is_bot: true, first_name: 'Тест', username: 'bp_test_bot', message_id: dms.length } }));
      };
      if (method === 'getUpdates') setTimeout(reply, 1500); else reply();
      return;
    }
    fakeLog.push(req.method + ' ' + u.pathname);
    const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const owner = TOKENS[bearer];
    res.setHeader('Content-Type', 'application/json');

    if (u.pathname === '/v2/oauth/token/') {
      const f = new URLSearchParams(raw);
      if (f.get('grant_type') === 'refresh_token') {
        const r = REFRESH[f.get('refresh_token')];
        fakeLog.push('REFRESH ' + f.get('refresh_token'));
        res.end(JSON.stringify(r || { error: 'invalid_grant', error_description: 'refresh token is invalid' }));
        return;
      }
      const a = ACC[f.get('code')];
      if (!a) { res.end(JSON.stringify({ error: 'invalid_request' })); return; }
      res.end(JSON.stringify({ access_token: a.access, refresh_token: a.refresh, expires_in: a.expires,
        open_id: a.open_id, scope: 'user.info.basic,video.list' }));
      return;
    }
    if (u.pathname === '/v2/user/info/') {
      const a = owner && accByOpen(owner);
      if (!a) { res.statusCode = 401; res.end(JSON.stringify({ error: { code: 'access_token_invalid' } })); return; }
      res.end(JSON.stringify({ data: { user: { open_id: a.open_id, display_name: a.name, username: a.username,
        follower_count: a.followers } }, error: { code: 'ok' } }));
      return;
    }
    if (u.pathname === '/v2/video/list/' || u.pathname === '/v2/video/query/') {
      const a = owner && accByOpen(owner);
      if (!a) { res.statusCode = 401; res.end(JSON.stringify({ error: { code: 'access_token_invalid', message: 'bad token' } })); return; }
      if (a.scopeless) {
        res.statusCode = 401;
        res.end(JSON.stringify({ error: { code: 'scope_not_authorized', message: 'video.list not granted' } }));
        return;
      }
      if (u.pathname === '/v2/video/list/') {
        const list = [...V.entries()].filter(([, v]) => v.owner === owner).map(([id, v]) => asTT(id, v));
        sendVideos(res, list, { has_more: false, cursor: 0 });
        return;
      }
      let ids = [];
      try { ids = (JSON.parse(raw).filters || {}).video_ids || []; } catch (e) { ids = []; }
      fakeLog.push('Q ' + ids.join(','));
      if (ids.includes(ID.BOOM) || ids.some((id) => DOWN.has(id))) { res.statusCode = 500; res.setHeader('Content-Type', 'text/plain'); res.end('упали'); return; }
      const list = ids.filter((id) => V.has(id) && V.get(id).owner === owner).map((id) => asTT(id, V.get(id)));
      if (ids.some((id) => SLOW.has(id))) { setTimeout(() => sendVideos(res, list, { has_more: false, cursor: 0 }), 1500); return; }
      sendVideos(res, list, { has_more: false, cursor: 0 });
      return;
    }
    if (u.pathname === '/oembed') {
      const m = /\/video\/(\d{15,21})/.exec(String(u.searchParams.get('url') || ''));
      const v = m && V.get(m[1]);
      if (!v) { res.statusCode = 400; res.end(JSON.stringify({ code: 400, message: 'Something went wrong' })); return; }
      res.end(JSON.stringify({ title: v.title, author_unique_id: accByOpen(v.owner).username,
        thumbnail_url: TT + '/cover/' + m[1] + '.jpg' }));
      return;
    }
    /* Короткие ссылки */
    const SHORT = {
      '/t/okA1/': TT + '/@blogera/video/' + ID.A1 + '?_r=1&_t=xyz',
      '/t/home/': '/?_r=1',
      '/t/photo/': TT + '/@blogera/photo/7693945062417239316?_r=1',
      '/t/evil/': 'http://169.254.169.254/latest/meta-data/',
      '/t/hop1/': '/t/hop2/',
      '/t/hop2/': TT + '/@blogerb/video/' + ID.B1,
    };
    if (SHORT[u.pathname]) {
      res.statusCode = 301;
      res.setHeader('Location', SHORT[u.pathname]);
      res.end();
      return;
    }
    if (u.pathname === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<html>главная</html>'); return; }
    res.statusCode = 404;
    res.end('{}');
  });
});

/* ── Поддельный Google (YouTube) ───────────────────────────────────── */
/* Y: первый доступ живёт секунду — сервер обязан обменять его по refresh.
   W: доступ протухает, refresh Google не дал — переподключать.
   K: доступ мёртвый вовсе — на сервере с ключом он и не нужен. */
const YACC = {
  'ycode-Y': { ch: 'UC-Y', title: 'Канал Игрек', custom: '@ycanal', access: 'ytok-Y1', refresh: 'yref-Y', expires: 1 },
  'ycode-Z': { ch: 'UC-Z', title: 'Канал Зет', custom: '@zcanal', access: 'ytok-Z', refresh: 'yref-Z', expires: 3600 },
  'ycode-W': { ch: 'UC-W', title: 'Канал Дабл', custom: '', access: 'ytok-W', refresh: '', expires: 1 },
  'ycode-K': { ch: 'UC-K', title: 'Канал Ка', custom: '@kcanal', access: 'ytok-Kdead', refresh: 'yref-dead', expires: 1 },
  /* Q: доступ протух, а Google при обмене отвечает 503 — это сбой Google, а не «доступ истёк». */
  'ycode-Q': { ch: 'UC-Q', title: 'Канал Кью', custom: '@qcanal', access: 'ytok-Q1', refresh: 'yref-Q', expires: 1 },
};
const YTOK = { 'ytok-Y1': 'UC-Y', 'ytok-Y2': 'UC-Y', 'ytok-Z': 'UC-Z', 'ytok-W': 'UC-W' };
const YREF = { 'yref-Y': { access_token: 'ytok-Y2', expires_in: 3600, token_type: 'Bearer' } };
const YT = {
  Y1: 'Yy1_abcdefg', Y2: 'Yy2-abcdefg', Y3: 'Yy3abcdefgh', Y4: 'Yy4abcdefgh', Y5: 'Yy5abcdefgh',
  Y6: 'Yy6abcdefgh', Y7: 'Yy7abcdefgh', Y8: 'Yy8abcdefgh', Y9: 'Yy9abcdefgh',
  Z1: 'Zz1abcdefgh', K1: 'Kk1abcdefgh', K2: 'Kk2abcdefgh', K3: 'Kk3abcdefgh', Q1: 'Qq1abcdefgh',
  BOOM: 'BOOMBOOMBOO', NONE: 'zzzzzzzzzzz',
};
const YV = new Map();
function yvid(id, ch, o) {
  YV.set(id, Object.assign({ ch, at: Date.now() - 60e3, dur: 'PT1M5S', views: 3000, likes: 300, comments: 12,
    privacy: 'public', title: 'Ролик YouTube ' + id.slice(0, 3) }, o || {}));
}
yvid(YT.Y1, 'UC-Y');
yvid(YT.Y2, 'UC-Y');
yvid(YT.Y3, 'UC-Y');
yvid(YT.Y4, 'UC-Y');
yvid(YT.Y5, 'UC-Y', { views: 9000, likes: 900 });
yvid(YT.Y6, 'UC-Y', { privacy: 'unlisted' });
yvid(YT.Y7, 'UC-Y', { privacy: 'private' });
yvid(YT.Y8, 'UC-Y', { dur: 'PT20S' });
yvid(YT.Y9, 'UC-Y');
yvid(YT.Z1, 'UC-Z');
yvid(YT.K1, 'UC-K', { views: 4000, likes: 400 });
yvid(YT.K2, 'UC-K', { privacy: 'private' });
yvid(YT.K3, 'UC-K');
yvid(YT.Q1, 'UC-Q');
yvid(YT.BOOM, 'UC-Y');
const gLog = [];
const asYT = (id, v) => ({
  id, kind: 'youtube#video',
  snippet: { publishedAt: new Date(v.at).toISOString(), channelId: v.ch, title: v.title,
    channelTitle: Object.values(YACC).find((a) => a.ch === v.ch).title,
    thumbnails: { default: { url: 'https://i.ytimg.com/vi/' + id + '/default.jpg' },
      high: { url: 'https://i.ytimg.com/vi/' + id + '/hqdefault.jpg' } } },
  statistics: { viewCount: String(v.views), likeCount: String(v.likes), commentCount: String(v.comments) },
  contentDetails: { duration: v.dur },
  status: { privacyStatus: v.privacy },
});
const gfake = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const u = new URL(req.url, GG);
    const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    res.setHeader('Content-Type', 'application/json');
    if (u.pathname === '/token') {
      const f = new URLSearchParams(raw);
      if (f.get('grant_type') === 'refresh_token') {
        gLog.push('YREFRESH ' + f.get('refresh_token'));
        if (f.get('refresh_token') === 'yref-Q') {
          res.statusCode = 503; res.setHeader('Content-Type', 'text/html'); res.end('<html>Service Unavailable</html>'); return;
        }
        const r = YREF[f.get('refresh_token')];
        if (!r) res.statusCode = 400;
        res.end(JSON.stringify(r || { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }));
        return;
      }
      const a = YACC[f.get('code')];
      if (!a) { res.statusCode = 400; res.end(JSON.stringify({ error: 'invalid_grant' })); return; }
      const out = { access_token: a.access, expires_in: a.expires, token_type: 'Bearer', scope: 'https://www.googleapis.com/auth/youtube.readonly' };
      if (a.refresh) out.refresh_token = a.refresh;
      res.end(JSON.stringify(out));
      return;
    }
    if (u.pathname === '/youtube/v3/channels') {
      const a = Object.values(YACC).find((x) => x.access === bearer);
      if (!a) { res.statusCode = 401; res.end(JSON.stringify({ error: { code: 401, errors: [{ reason: 'authError' }] } })); return; }
      res.end(JSON.stringify({ items: [{ id: a.ch, snippet: { title: a.title, customUrl: a.custom,
        thumbnails: { medium: { url: 'https://yt3.ggpht.com/a/' + (a.custom || '@nobody').slice(1) + '.jpg' } } },
        statistics: { subscriberCount: '1200', videoCount: '10', viewCount: '50000' } }] }));
      return;
    }
    if (u.pathname === '/youtube/v3/videos') {
      const key = u.searchParams.get('key');
      const ids = String(u.searchParams.get('id') || '').split(',').filter(Boolean);
      let viewer = null;
      if (key) {
        if (key !== YT_KEY) { res.statusCode = 400; res.end(JSON.stringify({ error: { code: 400, errors: [{ reason: 'keyInvalid' }] } })); return; }
        gLog.push('VKEY ' + ids.join(','));
      } else {
        viewer = YTOK[bearer];
        if (!viewer) {
          res.statusCode = 401;
          res.end(JSON.stringify({ error: { code: 401, status: 'UNAUTHENTICATED', errors: [{ reason: 'authError' }] } }));
          return;
        }
        gLog.push('VTOK ' + bearer + ' ' + ids.join(','));
      }
      if (ids.includes(YT.BOOM)) { res.statusCode = 500; res.end(JSON.stringify({ error: { code: 500, errors: [{ reason: 'backendError' }] } })); return; }
      /* закрытый ролик видит только владелец */
      const items = ids.filter((id) => YV.has(id))
        .filter((id) => YV.get(id).privacy !== 'private' || (viewer && viewer === YV.get(id).ch))
        .map((id) => asYT(id, YV.get(id)));
      res.end(JSON.stringify({ kind: 'youtube#videoListResponse', items }));
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
});

/* ── Наши серверы ──────────────────────────────────────────────────── */
const here = fileURLToPath(new URL('.', import.meta.url));
const dir = mkdtempSync(path.join(tmpdir(), 'bp-vid-'));
const DBP = path.join(dir, 'db.sqlite');
const DBK = path.join(dir, 'dbk.sqlite');
const common = {
  ADMIN_KEY: KEY, ADMIN_EMAIL: '', APP_URL: 'http://127.0.0.1:9999/app',
  TT_CLIENT_KEY: 'ключ', TT_CLIENT_SECRET: 'секрет', TT_SCOPE: 'user.info.basic,video.list',
  TT_AUTH_BASE: TT, TT_API_BASE: TT, TT_WEB_BASE: TT,
  YT_CLIENT_ID: 'yt-client', YT_CLIENT_SECRET: 'yt-secret', YT_API_BASE: GG, YT_OAUTH_BASE: GG,
  TRUST_PROXY: '1', ADMIN_CHAT_ID: '', RESEND_API_KEY: '', VID_AUTO_ACCEPT_H: '', VID_TRACK_DAYS: '',
  TEST_TOPUP: '1', TEST_TOPUP_OPEN: '1', YOOKASSA_SHOP_ID: '', YOOKASSA_SECRET_KEY: '',
};
const srv = spawn(process.execPath, ['server.js'], {
  cwd: here,
  env: {
    ...process.env, ...common,
    PORT: String(PORT), DB_PATH: DBP, PUBLIC_URL: BASE, YT_API_KEY: '',
    /* Бот есть (личные сообщения людям уходят в подделку), а тревоги
       владельцу выключены: у них часовой потолок, он сбил бы счёт. */
    BOT_TOKEN: '111:VIDTEST', TG_API_BASE: TT,
  },
  stdio: process.env.BP_DEBUG ? 'inherit' : 'ignore',
});
/* Второй сервер — с ключом YouTube API: цифры роликов без доступа канала. */
const srvK = spawn(process.execPath, ['server.js'], {
  cwd: here,
  env: { ...process.env, ...common, PORT: String(PORTK), DB_PATH: DBK, PUBLIC_URL: BASEK, YT_API_KEY: YT_KEY, BOT_TOKEN: '' },
  stdio: process.env.BP_DEBUG ? 'inherit' : 'ignore',
});
/* Прямой доступ к базе — только чтобы «состарить» строку (сутки, трое
   суток): ждать их по-настоящему проверка не может. Деньги и статусы
   двигает только сервер. */
let dbw = null;
const dbx = () => { if (!dbw) { dbw = new DatabaseSync(DBP); dbw.exec('PRAGMA busy_timeout = 5000'); } return dbw; };
const row = (id) => dbx().prepare('SELECT * FROM task_videos WHERE id = ?').get(id);
const setRow = (id, sets) => {
  const keys = Object.keys(sets);
  dbx().prepare('UPDATE task_videos SET ' + keys.map((k) => k + ' = ?').join(', ') + ' WHERE id = ?')
    .run(...keys.map((k) => sets[k]), id);
};
function stop() {
  try { srv.kill(); } catch (e) { /* уже мёртв */ }
  try { srvK.kill(); } catch (e) { /* уже мёртв */ }
  for (const s of [fake, gfake]) {
    try { if (s.closeAllConnections) s.closeAllConnections(); s.close(); } catch (e) { /* закрыт */ }
  }
  try { if (dbw) dbw.close(); } catch (e) { /* закрыта */ }
}

let ipSeq = 1;
const freshIp = () => '10.' + ((ipSeq >> 16) & 255) + '.' + ((ipSeq >> 8) & 255) + '.' + (ipSeq++ & 255);
async function apiAt(base, method, p, body, token, extra) {
  const headers = { 'Content-Type': 'application/json', 'X-Forwarded-For': (extra && extra.ip) || freshIp() };
  if (token) headers.Authorization = 'Bearer ' + token;
  if (extra && extra.admin) headers['X-Admin-Key'] = KEY;
  const r = await fetch(base + p, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const txt = await r.text();
  let j = {}; try { j = JSON.parse(txt); } catch (e) { j = { _text: txt.slice(0, 200) }; }
  return { status: r.status, body: j, headers: r.headers, raw: txt };
}
const api = (method, p, body, token, extra) => apiAt(BASE, method, p, body, token, extra);
const adm = (method, p, body) => api(method, p, body, null, { admin: true });
async function waitUp(base) {
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(base + '/api/health'); await r.text(); if (r.ok) return true; } catch (e) { /* ещё нет */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tag = Date.now().toString(36);

let tgSeq = 7000;
async function regAt(base, name, role, opts) {
  const email = name + '.' + tag + '@t.ru';
  const r = await apiAt(base, 'POST', '/api/register', { email, name: (opts && opts.display) || name, role, password: 'пароль-подлиннее' });
  const u = { token: r.body.token, id: r.body.user && r.body.user.id, email, tg: String(++tgSeq), base };
  /* Пришёл «из Телеграма»: бот может писать ему лично. */
  if (u.id && base === BASE) dbx().prepare('UPDATE users SET tg_id = ? WHERE id = ?').run(u.tg, u.id);
  return u;
}
const reg = (name, role, opts) => regAt(BASE, name, role, opts);
/* Подтверждение канала — как в жизни: start → возврат площадки → confirm. */
async function linkAt(base, user, platform, code) {
  const st = await apiAt(base, 'GET', '/api/verify/start?platform=' + platform, null, user.token);
  if (!st.body.nonce) return false;
  const back = await fetch(base + '/api/verify/callback/' + platform + '?code=' + code + '&state=' + st.body.nonce, { redirect: 'manual' });
  await back.text();
  const claim = new URL(back.headers.get('location') || '/', base).searchParams.get('claim') || '';
  const c = await apiAt(base, 'POST', '/api/verify/confirm', { nonce: st.body.nonce, claim }, user.token);
  return c.status === 200 && c.body.ok;
}
const linkTikTok = (user, code) => linkAt(BASE, user, 'tiktok', code);
const linkYouTube = (user, code) => linkAt(BASE, user, 'youtube', code);
const camps = {};
async function campAt(base, key, data, escrow, adv) {
  const rid = 'vc' + tag + key;
  camps[key] = rid;
  const put = await apiAt(base, 'POST', '/api/sync/put', { kind: 'camp', rid, data: Object.assign({ id: rid }, data) }, adv.token);
  let held = true;
  if (escrow) {
    const h = await apiAt(base, 'POST', '/api/deals/hold', { dealId: 'camp:' + rid, amount: escrow, opKey: 'hold-' + rid }, adv.token);
    held = h.status === 200;
  }
  return put.status === 200 && held;
}
const camp = (key, data, escrow, adv) => campAt(BASE, key, data, escrow, adv);
const link = (handle, id) => 'https://www.tiktok.com/@' + handle + '/video/' + id;
const ylink = (id) => 'https://www.youtube.com/watch?v=' + id;
const bindAt = (base, u, campKey, url, extra, more) =>
  apiAt(base, 'POST', '/api/tasks/video/bind', Object.assign({ campId: camps[campKey] || campKey, url, agree: true }, more || {}), u.token, extra);
const bind = (u, campKey, url, agree = true, extra, more) =>
  api('POST', '/api/tasks/video/bind', Object.assign({ campId: camps[campKey] || campKey, url, agree }, more || {}), u.token, extra);
const bindAs = (u, campKey, url, more) => bind(u, campKey, url, true, undefined, more);
const review = (id, adv, okv, reason) => api('POST', '/api/tasks/video/review', okv ? { id, ok: true } : { id, ok: false, reason }, adv.token);
const getVid = (id, token, extra) => api('GET', '/api/tasks/video?id=' + id, null, token, extra);
const bal = async (u) => (await apiAt(u.base || BASE, 'GET', '/api/balance', null, u.token)).body;
const sync = () => adm('POST', '/api/admin/task-videos/sync', { force: true });
const board = (u, campKey, qs) => api('GET', '/api/tasks/board?campId=' + encodeURIComponent(camps[campKey] || campKey) + (qs || ''), null, u.token);

try {
  await new Promise((r) => fake.listen(FAKE, '127.0.0.1', r));
  await new Promise((r) => gfake.listen(FAKEG, '127.0.0.1', r));
  if (!await waitUp(BASE) || !await waitUp(BASEK)) { console.log('сервер не поднялся'); stop(); process.exit(1); }
  console.log('\n«Загрузить видео» v2: TikTok и YouTube, резерв, выплата в момент зачёта, лидерборд\n');

  /* ── Люди, каналы, офферы ── */
  const ADV = await reg('reklama', 'advertiser');
  const A = await reg('blogera', 'blogger');
  const B = await reg('blogerb', 'blogger');
  const C = await reg('blogerc', 'blogger');
  const S = await reg('blogers', 'blogger');
  const X = await reg('blogerx', 'blogger');
  ok([ADV, A, B, C, S, X].every((u) => u.token), 'шесть аккаунтов заведены');
  /* Всех заводим ДО подтверждения каналов: reg пишет tg_id прямо в базу,
     а первый разбор канала сервер делает в стороне. Запись из проверки
     посреди его записи — «database is locked», и база канала молча не
     ложится (так плавала оценка накрутки ролика Б2). */
  const D = await reg('blogerd', 'blogger');
  const E = await reg('blogere', 'blogger');
  const F = await reg('blogerf', 'blogger');
  const G = await reg('blogerg', 'blogger', { display: 'Галя Г' });
  const H = await reg('blogerh', 'blogger', { display: 'Хасан Аш' });
  const Y = await reg('blogery', 'blogger', { display: 'Яна Игрек' });
  const W = await reg('blogerw', 'blogger');
  const U = await reg('bloggeru', 'blogger');
  const PP = await reg('bloggerp', 'blogger');
  const Q = await reg('bloggerq', 'blogger');
  ok(await linkTikTok(A, 'code-A'), 'А подтвердил TikTok обычным путём');
  ok(await linkTikTok(B, 'code-B'), 'Б подтвердил TikTok');
  ok(await linkTikTok(S, 'code-S'), 'С подтвердил TikTok (без права на ролики)');
  ok(await linkTikTok(X, 'code-X'), 'Икс подтвердил TikTok (доступ протухнет)');
  ok(await linkTikTok(D, 'code-D'), 'Д подтвердил TikTok');
  ok(await linkTikTok(E, 'code-E'), 'Е подтвердил TikTok');
  ok(await linkTikTok(F, 'code-F1') && await linkTikTok(F, 'code-F2'), 'Ф подтвердил два TikTok-аккаунта');
  ok(await linkTikTok(G, 'code-G') && await linkTikTok(H, 'code-H'), 'Г и Аш подтвердили TikTok');
  ok(await linkYouTube(Y, 'ycode-Y'), 'Игрек подтвердил YouTube тем же путём, что в жизни');
  ok(await linkTikTok(Y, 'code-Y'), 'Игрек подтвердил и TikTok');
  ok(await linkYouTube(W, 'ycode-W'), 'Дабл подтвердил YouTube (refresh Google не дал)');
  ok(await linkTikTok(U, 'code-U') && await linkTikTok(PP, 'code-P'), 'У и П подтвердили TikTok');
  ok(await linkYouTube(Q, 'ycode-Q'), 'Кью подтвердил YouTube (Google потом не обменяет доступ)');
  await sleep(1100);          /* первый разбор канала идёт в стороне; короткие доступы протухают */

  const top = await api('POST', '/api/topup', { amount: 200000, opKey: 'topup-' + tag }, ADV.token);
  ok(top.status === 200, 'рекламодатель пополнил баланс', top.body);
  const future = new Date(Date.now() + 10 * 86400e3).toISOString();
  const hourAgo = new Date(Date.now() - 3600e3).toISOString();
  const base = { status: 'active', platforms: 'tt,tg', rate: 100, maxPayout: 3000, createdAt: hourAgo, deadline: future };
  ok(await camp('main', Object.assign({}, base, { name: 'Главный оффер' }), 20000, ADV), 'оффер с заморозкой 20 000 ₽');
  ok(await camp('paused', Object.assign({}, base, { name: 'На паузе', status: 'paused' }), 100, ADV), 'оффер на паузе');
  ok(await camp('noesc', Object.assign({}, base, { name: 'Без заморозки' }), 0, ADV), 'оффер без заморозки');
  ok(await camp('yt', Object.assign({}, base, { name: 'Только YouTube', platforms: 'yt' }), 100, ADV), 'оффер только для YouTube');
  ok(await camp('short', Object.assign({}, base, { name: 'Длинные ролики', videoMinSec: 30 }), 1000, ADV), 'оффер с минимальной длиной 30 сек');
  ok(await camp('fix', Object.assign({}, base, { name: 'Фикс', payMode: 'fixed', fixedPrice: 800, platforms: ['tiktok'] }), 500, ADV),
    'оффер с фиксированной ценой 800 ₽ и заморозкой 500 ₽');
  ok(await camp('terms', Object.assign({}, base, { name: 'Условия' }), 20000, ADV), 'оффер «Условия»');
  ok(await camp('termsX', Object.assign({}, base, { name: 'Переписанный' }), 5000, ADV), 'оффер, который перепишут после загрузки');
  ok(await camp('resv', Object.assign({}, base, { name: 'Резерв', maxPayout: 800 }), 1000, ADV), 'оффер для резерва бюджета');
  ok(await camp('nl1', Object.assign({}, base, { name: 'Списки 1', platforms: 'yt', platformsList: ['tiktok'] }), 100, ADV), 'оффер: TikTok только в platformsList');
  ok(await camp('nl2', Object.assign({}, base, { name: 'Списки 2', platforms: [], platformsList: { tt: true, yt: false } }), 100, ADV), 'оффер: platformsList объектом');
  ok(await camp('nl3', Object.assign({}, base, { name: 'Списки 3', platforms: '', platformsList: ['yt'] }), 100, ADV), 'оффер: в platformsList только YouTube');
  ok(await camp('ban', Object.assign({}, base, { name: 'Баннеры', format: 'banners', platforms: '', platformsList: [] }), 5000, ADV),
    'оффер «Баннеры» без площадок');
  ok(await camp('tgig', Object.assign({}, base, { name: 'Телеграм и Инстаграм', platforms: ['telegram', 'instagram'] }), 1000, ADV),
    'оффер только для Telegram и Instagram');
  ok(await camp('minv', Object.assign({}, base, { name: 'Минимум просмотров', minViews: 5000 }), 1000, ADV), 'оффер с минимумом 5 000 просмотров');
  ok(await camp('tiny', Object.assign({}, base, { name: 'Маленький бюджет', maxPayout: 0 }), 300, ADV), 'оффер с бюджетом 300 ₽');
  ok(await camp('late', Object.assign({}, base, { name: 'Срок вышел', createdAt: new Date(Date.now() - 2 * 3600e3).toISOString(),
    deadline: new Date(Date.now() - 30 * 60e3).toISOString() }), 1000, ADV), 'оффер, срок которого вышел полчаса назад');
  ok(await camp('rsv', Object.assign({}, base, { name: 'Резервы', platforms: 'tiktok' }), 5000, ADV), 'оффер для снятия резервов');
  ok(await camp('ytc', Object.assign({}, base, { name: 'YouTube-задание', platforms: 'yt', videoMinSec: 30 }), 5000, ADV),
    'YouTube-оффер с минимальной длиной 30 сек');
  ok(await camp('brd', Object.assign({}, base, { name: 'Лидерборд', platforms: '' }), 10000, ADV), 'оффер для лидерборда');
  ok(await camp('capc', Object.assign({}, base, { name: 'Остаток бюджета', maxPayout: 0 }), 300, ADV), 'оффер: 300 ₽ в заморозке, без потолка за ролик');
  /* Срок датой без времени — как пишет шторка «Условия задания» (<input type=date>). */
  const mskDay = (d) => new Date(Date.now() + 3 * 3600e3 + d * 864e5).toISOString().slice(0, 10);
  ok(await camp('dlt', Object.assign({}, base, { name: 'Срок сегодня', deadline: mskDay(0) }), 1000, ADV), 'оффер: срок — сегодняшняя дата без времени');
  ok(await camp('dly', Object.assign({}, base, { name: 'Срок вчера', createdAt: new Date(Date.now() - 3 * 864e5).toISOString(),
    deadline: mskDay(-1) }), 1000, ADV), 'оффер: срок — вчерашняя дата без времени');

  /* ── Ошибки загрузки ── */
  console.log('\n— ошибки загрузки');
  const e401 = await api('POST', '/api/tasks/video/bind', { campId: camps.main, url: link('blogera', ID.A1), agree: true });
  ok(e401.status === 401, '401 без входа', e401.body);
  const yt = await bind(A, 'main', 'https://youtube.com/watch?v=1');
  ok(yt.status === 400 && yt.body.code === 'bad_url' && yt.body.error === 'Это не ссылка на видео TikTok или YouTube', 'bad_url: YouTube без настоящего id', yt.body);
  const prof = await bind(A, 'main', 'https://www.tiktok.com/@blogera');
  ok(prof.status === 400 && prof.body.code === 'bad_url', 'bad_url: ссылка на профиль, а не на ролик', prof.body);
  const plain = await bind(A, 'main', 'http://www.tiktok.com/@blogera/video/' + ID.A1);
  ok(plain.status === 400 && plain.body.code === 'bad_url', 'bad_url: только https', plain.body);
  const vk = await bind(A, 'main', 'https://vk.com/video-1_2');
  ok(vk.status === 400 && vk.body.code === 'bad_url', 'bad_url: не TikTok и не YouTube', vk.body);
  const ag = await bind(A, 'нет-такого', link('blogera', ID.A1), false);
  ok(ag.status === 404 && ag.body.code === 'no_camp', 'галочки «есть реклама» больше нет — без неё сервер не отказывает', ag.body);
  const nc = await bind(A, 'нет-такого', link('blogera', ID.A1));
  ok(nc.status === 404 && nc.body.code === 'no_camp' && nc.body.error === 'Задание не найдено', 'no_camp', nc.body);
  const cl = await bind(A, 'paused', link('blogera', ID.A1));
  ok(cl.status === 409 && cl.body.code === 'camp_closed', 'camp_closed: оффер на паузе', cl.body);
  const ne = await bind(A, 'noesc', link('blogera', ID.A1));
  ok(ne.status === 409 && ne.body.code === 'camp_closed', 'camp_closed: у оффера нет заморозки — платить не из чего', ne.body);
  const own = await bind(ADV, 'main', link('blogera', ID.A1));
  ok(own.status === 409 && own.body.code === 'own_camp' && own.body.error === 'Это ваше задание — видео в своё задание загрузить нельзя', 'own_camp', own.body);
  const ntt = await bind(A, 'yt', link('blogera', ID.A1));
  ok(ntt.status === 409 && ntt.body.code === 'wrong_platform' && ntt.body.error === 'В этом задании принимаются видео только из: YouTube',
    'wrong_platform: TikTok в YouTube-задании (код not_tiktok больше не приходит)', ntt.body);
  const tgig = await bind(A, 'tgig', link('blogera', ID.A1));
  ok(tgig.status === 409 && tgig.body.code === 'wrong_platform' && tgig.body.error === 'В этом задании принимаются видео только из: Telegram, Instagram',
    'wrong_platform: площадки задания названы по-человечески', tgig.body);
  const ytInMain = await bind(Y, 'main', ylink(YT.Y1));
  ok(ytInMain.status === 409 && ytInMain.body.code === 'wrong_platform' && /только из: TikTok, Telegram$/.test(ytInMain.body.error),
    'wrong_platform: YouTube-ссылка в задании «TikTok, Telegram»', ytInMain.body);
  const wl1 = await bindAs(A, 'main', link('blogera', ID.A1), { platform: 'youtube' });
  ok(wl1.status === 400 && wl1.body.code === 'wrong_link'
    && wl1.body.error === 'Ссылка с TikTok, а выбран аккаунт YouTube — выберите TikTok-аккаунт или вставьте другую ссылку',
  'wrong_link: ссылка TikTok, выбран YouTube', wl1.body);
  const wl2 = await bindAs(Y, 'ytc', ylink(YT.Y1), { platform: 'tt' });
  ok(wl2.status === 400 && wl2.body.code === 'wrong_link'
    && wl2.body.error === 'Ссылка с YouTube, а выбран аккаунт TikTok — выберите YouTube-канал или вставьте другую ссылку',
  'wrong_link: ссылка YouTube, выбран TikTok (синоним tt понят)', wl2.body);
  const nch = await bind(C, 'main', link('blogera', ID.A1));
  ok(nch.status === 409 && nch.body.code === 'no_channel' && nch.body.error === 'Сначала подключите свой TikTok' && nch.body.platform === 'tiktok',
    'no_channel: TikTok', nch.body);
  const nchY = await bind(A, 'ytc', ylink(YT.Y1));
  ok(nchY.status === 409 && nchY.body.code === 'no_channel' && nchY.body.error === 'Сначала подключите свой YouTube', 'no_channel: YouTube', nchY.body);
  const nacc = await bindAs(A, 'main', link('blogera', ID.A1), { platform: 'tiktok', account: 'chan-B' });
  ok(nacc.status === 409 && nacc.body.code === 'no_account' && nacc.body.error === 'Этот аккаунт не подключён — подключите его заново',
    'no_account: чужой аккаунт не выбрать', nacc.body);
  const tok = await bind(X, 'main', link('blogerx', ID.A1));
  ok(tok.status === 409 && tok.body.code === 'token' && /переподключите/.test(tok.body.error), 'token: доступ протух и не обновился', tok.body);
  const sc = await bind(S, 'main', link('blogers', ID.A1));
  ok(sc.status === 409 && sc.body.code === 'scope' && /разрешите доступ к роликам/.test(sc.body.error), 'scope: нет права на ролики', sc.body);
  const home = await bind(A, 'main', TT + '/t/home/');
  ok(home.status === 404 && home.body.code === 'not_found', 'not_found: короткая ссылка ведёт на главную', home.body);
  const ph = await bind(A, 'main', TT + '/@blogera/photo/7693945062417239316');
  ok(ph.status === 409 && ph.body.code === 'not_video' && /фото-пост/.test(ph.body.error), 'фото-карусель по прямой ссылке — not_video, понятный текст', ph.body);
  const phs = await bind(A, 'main', TT + '/t/photo/');
  ok(phs.status === 409 && phs.body.code === 'not_video', 'короткая ссылка на фото-карусель — not_video, а не «не найдено»', phs.body);
  const evil = await bind(A, 'main', TT + '/t/evil/');
  ok(evil.status === 404 && evil.body.code === 'not_found', 'короткая ссылка наружу TikTok не раскрывается', evil.body);
  const none = await bind(A, 'main', link('blogera', ID.NONE));
  ok(none.status === 404 && none.body.code === 'not_found' && none.body.error === 'Видео не найдено — проверьте ссылку',
    'not_found: такого ролика нет (oEmbed 400)', none.body);
  const ny = await bind(A, 'main', link('blogerb', ID.B1));
  ok(ny.status === 409 && ny.body.code === 'not_yours' && ny.body.error === 'Это видео не с ваших подключённых аккаунтов TikTok',
    'not_yours: чужой ролик', ny.body);
  const nyA = await bindAs(A, 'main', link('blogerb', ID.B1), { platform: 'tiktok', account: 'chan-A' });
  ok(nyA.status === 409 && nyA.body.code === 'not_yours'
    && nyA.body.error === 'Этого видео нет на аккаунте @blogera — выберите другой аккаунт или проверьте ссылку',
  'not_yours: с выбранным аккаунтом — текст с его ником', nyA.body);
  const old = await bind(A, 'main', link('blogera', ID.AOLD));
  ok(old.status === 409 && old.body.code === 'too_old', 'too_old: снят раньше оффера', old.body);
  const sh = await bind(A, 'short', link('blogera', ID.ASHORT));
  ok(sh.status === 409 && sh.body.code === 'too_short' && sh.body.error === 'Видео короче 30 сек — так в условиях задания',
    'too_short: текст с числом секунд', sh.body);
  const late = await bind(A, 'late', link('blogera', ID.A10));
  ok(late.status === 409 && late.body.code === 'too_late', 'too_late: ролик вышел после срока задания', late.body);
  const lateOk = await bind(A, 'late', link('blogera', ID.A11));
  ok(lateOk.status === 200, 'срок вышел, но ролик вышел до срока — загрузить можно', lateOk.body);
  const dlt = await bind(A, 'dlt', link('blogera', ID.A15));
  ok(dlt.status === 200, 'срок «сегодня» датой без времени: ролик, вышедший сегодня, принят (конец дня по Москве)', dlt.body);
  const dly = await bind(A, 'dly', link('blogera', ID.A16));
  ok(dly.status === 409 && dly.body.code === 'too_late', 'срок «вчера» датой без времени: сегодняшний ролик — too_late', dly.body);
  const few = await bind(A, 'minv', link('blogera', ID.A12));
  ok(few.status === 409 && few.body.code === 'few_views' && few.body.views === 1000 && few.body.minViews === 5000
    && few.body.error === 'У видео 1 000 просмотров, а в задании минимум 5 000 — загрузите, когда наберёт',
  'few_views: числа с разрядами и поля views/minViews', few.body);
  const boom = await bind(A, 'main', link('blogera', ID.BOOM));
  ok(boom.status === 502 && boom.body.code === 'tiktok', 'tiktok: площадка упала — 502', boom.body);
  const ip = '10.200.0.1';
  let last = null;
  for (let i = 0; i < 11; i++) last = await bind(C, 'main', 'не ссылка', true, { ip });
  ok(last.status === 429, '429: больше 10 попыток в минуту', last.body);

  /* ── Бюджет и резерв при загрузке ── */
  console.log('\n— бюджет задания');
  const t13 = await bind(A, 'tiny', link('blogera', ID.A13));
  ok(t13.status === 200 && t13.body.video.reserved === 300, 'ролик зарезервировал 300 ₽ — весь бюджет', t13.body.video);
  const t14 = await bind(A, 'tiny', link('blogera', ID.A14));
  ok(t14.status === 409 && t14.body.code === 'budget' && t14.body.error === 'Бюджет задания закончился', 'budget: резерв съел бюджет', t14.body);
  await api('POST', '/api/tasks/video/unbind', { id: t13.body.video.id }, A.token);
  const t14b = await bind(A, 'tiny', link('blogera', ID.A14));
  ok(t14b.status === 200, 'отвязал первый ролик — резерв снялся, второй загрузился', t14b.body);

  /* Ролик стоит больше, чем свободно: принят, но резерв и выплата — не больше остатка. */
  const c8 = await bind(D, 'capc', link('blogerd', ID.D8));
  ok(c8.status === 200 && c8.body.video.reserved === 300 && c8.body.video.earned === 300 && c8.body.video.budgetCap === 300,
    'ролик на 400 ₽ при свободных 300 ₽: резерв и оценка — 300, budgetCap 300', c8.body.video);
  const cb = (await board(ADV, 'capc')).body;
  ok(cb.reserved === 300 && cb.left === 0 && cb.reserved <= cb.budget, '«В резерве» не больше бюджета, «Свободно» 0', cb);
  const c9 = await bind(D, 'capc', link('blogerd', ID.D9));
  ok(c9.status === 409 && c9.body.code === 'budget', 'следующий ролик — budget', c9.body);
  V.get(ID.D8).views = 5000;
  const rc8 = await review(c8.body.video.id, ADV, true);
  ok(rc8.body.settle === 'paid' && rc8.body.video.status === 'paid' && rc8.body.video.paid === 300 && !rc8.body.video.payHold,
    'при зачёте выплачено 300 ₽ целиком, без «недоплаты» владельцу', rc8.body.video);

  /* ── Удачная загрузка ── */
  console.log('\n— загрузка');
  const okA1 = await bind(A, 'main', 'Смотри мой ролик! ' + TT + '/t/okA1/');
  const vA1 = okA1.body.video || {};
  ok(okA1.status === 200 && okA1.body.ok && vA1.status === 'review', 'короткая ссылка раскрыта, ролик загружен, ждёт проверки', okA1.body);
  ok(vA1.videoId === ID.A1, 'id ролика — строка, все 19 цифр целы', vA1.videoId);
  ok(vA1.views === 1500 && vA1.likes === 150 && vA1.comments === 10 && vA1.shares === 5, 'цифры взяты с площадки', vA1);
  ok(vA1.platform === 'tiktok' && vA1.player === 'https://www.tiktok.com/player/v1/' + ID.A1, 'платформа и плеер', vA1);
  ok(vA1.url === 'https://www.tiktok.com/@blogera/video/' + ID.A1 && vA1.handle === 'blogera', 'постоянная ссылка без меток', vA1.url);
  ok(vA1.campId === camps.main && vA1.bloggerId === A.id && vA1.ownerId === ADV.id, 'оффер, блогер и автор записаны', vA1);
  ok(vA1.submitViews === 1500 && vA1.paidViews === null && vA1.earned === 150 && vA1.reserved === 150 && vA1.paid === 0,
    'v2: просмотры при загрузке, оценка 150 ₽ и резерв 150 ₽', vA1);
  ok(vA1.risk === null && Array.isArray(vA1.riskWhy) && vA1.riskWhy.length === 0 && vA1.riskLevel === 'ok',
    'блогеру — только уровень оценки, без причин', vA1);
  ok(typeof vA1.cover === 'string' && vA1.cover.includes(ID.A1), 'обложка из ответа площадки', vA1.cover);
  ok(fakeLog.includes('REFRESH ref-A'), 'протухший доступ А обменян по refresh');
  const again = await bind(A, 'main', link('blogera', ID.A1) + '?is_from_webapp=1');
  ok(again.status === 409 && again.body.code === 'taken', 'taken: тот же ролик второй раз', again.body);
  const againOther = await bind(A, 'short', link('blogera', ID.A1));
  ok(againOther.status === 409 && againOther.body.code === 'taken', 'taken: тот же ролик в другое задание', againOther.body);
  const steal = await bind(B, 'main', link('blogera', ID.A1));
  ok(steal.status === 409 && steal.body.code === 'not_yours', 'чужой уже загруженный ролик — «не ваш»', steal.body);
  const okB1 = await bind(B, 'main', TT + '/t/hop1/');
  const vB1 = okB1.body.video || {};
  ok(okB1.status === 200 && vB1.videoId === ID.B1, 'короткая ссылка в два шага', okB1.body);
  const ban = await bind(A, 'ban', link('blogera', ID.A9));
  ok(ban.status === 200, 'задание «Баннеры» без площадок принимает TikTok', ban.body);

  /* ── Кто что видит ── */
  console.log('\n— права');
  const peek = await getVid(vA1.id, B.token);
  ok(peek.status === 404, 'чужой блогер не видит ролик А', peek.body);
  const bList = await api('GET', '/api/tasks/videos?campId=' + camps.main, null, B.token);
  ok(bList.status === 200 && bList.body.videos.length === 1 && bList.body.videos[0].id === vB1.id,
    'блогер по офферу видит только свои ролики', bList.body);
  const advList = await api('GET', '/api/tasks/videos?campId=' + camps.main, null, ADV.token);
  ok(advList.status === 200 && advList.body.videos.length === 2, 'автор оффера видит все ролики оффера', advList.body);
  ok(advList.body.videos.every((v) => Array.isArray(v.riskWhy) && v.riskWhy.length > 0 && v.risk != null),
    'автору оффера — оценка с причинами', advList.body.videos.map((v) => v.riskWhy));
  ok(advList.body.videos.every((v) => v.history === undefined), 'в списке нет истории по дням');
  const aAll = await api('GET', '/api/tasks/videos', null, A.token);
  ok(aAll.status === 200 && aAll.body.videos.some((v) => v.id === vA1.id) && aAll.body.videos.every((v) => v.bloggerId === A.id),
    'без campId — мои ролики', aAll.body);
  const noAuth = await api('GET', '/api/tasks/videos');
  ok(noAuth.status === 401, 'список без входа закрыт');
  const one = await getVid(vA1.id, A.token);
  ok(one.status === 200 && Array.isArray(one.body.video.history) && one.body.video.history.length === 1
    && one.body.video.history[0].day === new Date().toISOString().slice(0, 10) && one.body.video.history[0].views === 1500,
  'снимок дня записан при загрузке', one.body.video && one.body.video.history);
  const asAdmin = await api('GET', '/api/tasks/video?id=' + vA1.id, null, null, { admin: true });
  ok(asAdmin.status === 200 && asAdmin.body.video.riskWhy.length > 0, 'владелец площадки видит ролик по ключу', asAdmin.body);

  /* ── Проверка рекламодателем: засчитано = оплачено сразу ── */
  console.log('\n— зачёт и выплата');
  const selfRev = await review(vA1.id, A, true);
  ok(selfRev.status === 403, 'блогер сам себе не засчитывает', selfRev.body);
  const strRev = await review(vA1.id, B, true);
  ok(strRev.status === 404, 'посторонний не проверяет чужое', strRev.body);
  Object.assign(V.get(ID.A1), { views: 20000, likes: 2000, comments: 50, shares: 20 });
  const a0 = await bal(A), adv0 = await bal(ADV);
  const qMark0 = fakeLog.length;
  const rev = await review(vA1.id, ADV, true);
  const rv = rev.body.video || {};
  ok(rev.status === 200 && rev.body.settle === 'paid' && rv.status === 'paid' && rv.approvedAt > 0,
    '«всё верно» → видео засчитано и сразу оплачено', rev.body);
  ok(fakeLog.slice(qMark0).some((l) => l === 'Q ' + ID.A1), 'в момент зачёта — свежий замер у площадки');
  ok(rv.paidViews === 20000 && rv.views === 20000 && rv.earned === 2000 && rv.paid === 2000 && rv.paidAt > 0 && rv.reserved === 0,
    'выплата по свежему замеру: 20 000 × 100 / 1000 = 2000, резерв снят', rv);
  const a1 = await bal(A), adv1 = await bal(ADV);
  ok(a1.available - a0.available === 2000, 'деньги сразу на балансе блогера', { a0, a1 });
  ok(adv0.hold - adv1.hold === 2000 && adv1.available === adv0.available, 'у рекламодателя ушло 2000 из заморозки, свободные не тронуты', { adv0, adv1 });
  await sleep(300);
  ok(dmsTo(A, /Видео засчитано — 2 000 ₽ на балансе/).length === 1, 'блогеру: «Видео засчитано — 2 000 ₽ на балансе»', dmsTo(A).map((m) => m.text));
  const rev2 = await review(vA1.id, ADV, false, 'передумал совсем');
  ok(rev2.status === 409, 'второй раз не проверить', rev2.body);
  const decPaid = await adm('POST', '/api/admin/task-videos/decide', { id: vA1.id, decision: 'count' });
  ok(decPaid.status === 409, 'по оплаченному ролику решение не нужно', decPaid.body);
  ok((await bal(A)).available === a1.available, 'повтор зачёта не платит второй раз');
  const ops = await api('GET', '/api/ops/mine', null, ADV.token);
  const vop = (ops.body.rows || []).find((r) => r.opKey === 'sys:vidpay:' + vA1.id);
  ok(vop && vop.paid === 2000 && vop.to === A.id && vop.dealId === 'camp:' + camps.main,
    'выплата видна рекламодателю как обычная выплата из кампании', ops.body.rows);
  const led = await api('GET', '/api/ledger', null, A.token);
  ok((led.body.rows || []).filter((r) => r.kind === 'payout' && r.ref === 'camp:' + camps.main).length === 1,
    'в журнале А одна выплата по кампании', led.body.rows);

  /* Просмотров стало меньше, чем при загрузке — платим по большему. */
  const b7 = await bind(A, 'main', link('blogera', ID.A7));
  V.get(ID.A7).views = 800;
  const r7 = await review(b7.body.video.id, ADV, true);
  ok(r7.body.video.status === 'paid' && r7.body.video.paidViews === 1000 && r7.body.video.paid === 100,
    'просмотров при зачёте 800, при загрузке 1000 — оплачено по 1000', r7.body.video);

  /* Ролик удалили до зачёта — removed, денег нет, резерв вернулся. */
  const b8 = await bind(A, 'main', link('blogera', ID.A8));
  const brd0 = await board(ADV, 'main');
  V.delete(ID.A8);
  const aB8 = (await bal(A)).available;
  const r8 = await review(b8.body.video.id, ADV, true);
  ok(r8.status === 200 && r8.body.settle === 'removed' && r8.body.video.status === 'removed' && r8.body.video.paid === 0,
    'ролика нет при свежем замере → removed без выплаты', r8.body);
  const brd1 = await board(ADV, 'main');
  ok((await bal(A)).available === aB8 && brd0.body.reserved - brd1.body.reserved === 100,
    'деньги не ушли, резерв 100 ₽ вернулся в бюджет', { before: brd0.body.reserved, after: brd1.body.reserved });

  /* Два «всё верно» одновременно — платится один раз. */
  const f1 = await bindAs(F, 'rsv', link('blogerf1', ID.F1b));
  const fBal0 = (await bal(F)).available;
  const [p1, p2] = await Promise.all([review(f1.body.video.id, ADV, true), review(f1.body.video.id, ADV, true)]);
  ok([p1.status, p2.status].sort().join() === '200,409', 'два зачёта разом: один прошёл, второй — 409', [p1.body, p2.body]);
  ok((await bal(F)).available - fBal0 === 200, 'и деньги пришли один раз: 200', (await bal(F)).available - fBal0);

  /* ── Возражение рекламодателя ── */
  const shortReason = await review(vB1.id, ADV, false, 'abc');
  ok(shortReason.status === 400 && shortReason.body.code === 'reason', 'причина короче 5 символов отклонена', shortReason.body);
  const noOk = await api('POST', '/api/tasks/video/review', { id: vB1.id }, ADV.token);
  ok(noOk.status === 400, 'без ok — 400', noOk.body);
  const rej = await review(vB1.id, ADV, false, 'В ролике нет упоминания бренда');
  ok(rej.status === 200 && rej.body.video.status === 'rejected' && rej.body.video.reviewNote === 'В ролике нет упоминания бренда'
    && rej.body.video.reserved === 300, '«есть проблема» → rejected с причиной, резерв держится', rej.body);

  /* ── Отвязка ── */
  console.log('\n— отвязка');
  const b2 = await bind(A, 'main', link('blogera', ID.A2));
  const vA2 = b2.body.video || {};
  ok(b2.status === 200, 'А загрузил второй ролик', b2.body);
  const ub1 = await api('POST', '/api/tasks/video/unbind', { id: vA2.id }, B.token);
  ok(ub1.status === 404, 'посторонний не отвязывает', ub1.body);
  const ub2 = await api('POST', '/api/tasks/video/unbind', { id: vA2.id }, ADV.token);
  ok(ub2.status === 403, 'рекламодатель не отвязывает за блогера', ub2.body);
  const ub3 = await api('POST', '/api/tasks/video/unbind', { id: vA2.id }, A.token);
  ok(ub3.status === 200 && ub3.body.ok, 'блогер отвязал ролик до проверки', ub3.body);
  ok((await getVid(vA2.id, A.token)).status === 404, 'отвязанного ролика больше нет');
  const re2 = await bind(A, 'main', link('blogera', ID.A2));
  ok(re2.status === 200, 'отвязанный ролик снова свободен', re2.body);
  const ub4 = await api('POST', '/api/tasks/video/unbind', { id: vA1.id }, A.token);
  ok(ub4.status === 409, 'оплаченный ролик не отвязать', ub4.body);

  /* ── Обновление по кнопке ── */
  const rf = await api('POST', '/api/tasks/video/refresh', { id: re2.body.video.id }, A.token);
  ok(rf.status === 200 && rf.body.fresh === false, 'обновление не чаще раза в 10 минут', rf.body);
  /* K: порог — по последней попытке, а не по удачному замеру. */
  const rid2 = re2.body.video.id;
  setRow(rid2, { stats_at: Date.now() - 3600e3, last_try_at: Date.now() - 60e3 });
  const rfTry = await api('POST', '/api/tasks/video/refresh', { id: rid2 }, A.token);
  ok(rfTry.status === 200 && rfTry.body.fresh === false, 'K: замер старый, но попытка была минуту назад — площадку не дёргаем', rfTry.body);
  setRow(rid2, { stats_at: Date.now() - 3600e3, last_try_at: Date.now() - 3600e3 });
  const t0 = Date.now();
  const rfOk = await api('POST', '/api/tasks/video/refresh', { id: rid2 }, A.token);
  ok(rfOk.status === 200 && rfOk.body.fresh === true && row(rid2).last_try_at >= t0, 'K/F: обновление прошло, попытка записана в last_try_at', rfOk.body);
  const rfStr = await api('POST', '/api/tasks/video/refresh', { id: re2.body.video.id }, B.token);
  ok(rfStr.status === 404, 'чужой ролик не обновить', rfStr.body);
  /* Оплаченный: цифры обновляются только для показа, деньги — нет. */
  Object.assign(V.get(ID.A1), { views: 26000, likes: 2600 });
  setRow(vA1.id, { stats_at: Date.now() - 3600e3, last_try_at: Date.now() - 3600e3 });
  const rfPaid = await api('POST', '/api/tasks/video/refresh', { id: vA1.id }, A.token);
  ok(rfPaid.status === 200 && rfPaid.body.fresh === true && rfPaid.body.video.views === 26000 && rfPaid.body.video.paid === 2000
    && rfPaid.body.video.paidViews === 20000 && rfPaid.body.video.status === 'paid',
  'оплаченный ролик: просмотры растут для показа, выплата не меняется', rfPaid.body.video);
  setRow(vA1.id, { posted_at: Date.now() - 31 * 864e5, stats_at: Date.now() - 3600e3, last_try_at: Date.now() - 3600e3 });
  const rfOld = await api('POST', '/api/tasks/video/refresh', { id: vA1.id }, A.token);
  ok(rfOld.status === 409, 'через 30 суток после публикации цифры больше не обновляются', rfOld.body);

  /* ── Владелец площадки ── */
  console.log('\n— решение владельца');
  const noKey = await api('GET', '/api/admin/task-videos?status=queue', null, A.token);
  ok(noKey.status === 403, 'очередь владельца без ключа закрыта', noKey.body);
  const queue = await adm('GET', '/api/admin/task-videos?status=queue');
  const qB1 = (queue.body.videos || []).find((v) => v.id === vB1.id);
  ok(queue.status === 200 && qB1, 'возвращённый ролик в очереди', queue.body);
  ok(qB1 && qB1.campName === 'Главный оффер' && qB1.ownerEmail === ADV.email && qB1.bloggerEmail === B.email
    && qB1.channelTitle === 'Блогер Б' && Array.isArray(qB1.history) && qB1.history.length === 1,
  'в очереди: оффер, стороны, канал и история', qB1);
  const ov = await adm('GET', '/api/admin/overview');
  ok(ov.status === 200 && ov.body['видео_на_решении'] >= 1, 'в сводке есть видео_на_решении', ov.body['видео_на_решении']);
  const tabs = await Promise.all(['review', 'paid', 'active'].map((s) => adm('GET', '/api/admin/task-videos?status=' + s)));
  ok(tabs.every((t) => t.status === 200) && (tabs[0].body.videos || []).every((v) => v.status === 'review')
    && (tabs[1].body.videos || []).some((v) => v.id === vA1.id), 'вкладки пульта: на проверке, выплачены, ждут выплаты');
  const b3 = await bind(A, 'main', link('blogera', ID.A3));
  await review(b3.body.video.id, ADV, false, 'Не та интеграция');
  const notAdm = await api('POST', '/api/admin/task-videos/decide', { id: b3.body.video.id, decision: 'decline' }, A.token);
  ok(notAdm.status === 403, 'решать может только владелец площадки', notAdm.body);
  const badDec = await adm('POST', '/api/admin/task-videos/decide', { id: b3.body.video.id, decision: 'maybe' });
  ok(badDec.status === 400, 'неизвестное решение — 400', badDec.body);
  const dec = await adm('POST', '/api/admin/task-videos/decide', { id: b3.body.video.id, decision: 'decline', note: 'Реклама не по ТЗ' });
  ok(dec.status === 200 && dec.body.video.status === 'declined' && dec.body.video.decision === 'decline'
    && dec.body.video.decisionNote === 'Реклама не по ТЗ' && dec.body.video.decidedAt > 0 && dec.body.video.reserved === 0,
  '«не засчитывать» → declined, резерв снят', dec.body);
  const dec2 = await adm('POST', '/api/admin/task-videos/decide', { id: b3.body.video.id, decision: 'count' });
  ok(dec2.status === 409, 'по закрытому ролику решение не нужно', dec2.body);
  V.get(ID.B1).views = 5000;
  const bB0 = (await bal(B)).available;
  await sleep(300);
  const bDm0 = dmsTo(B, /Видео засчитано/).length;
  const cnt = await adm('POST', '/api/admin/task-videos/decide', { id: vB1.id, decision: 'count', note: 'Бренд есть на 0:12' });
  ok(cnt.status === 200 && cnt.body.settle === 'paid' && cnt.body.video.status === 'paid' && cnt.body.video.paid === 500
    && cnt.body.video.paidViews === 5000 && cnt.body.video.decision === 'count',
  '«засчитать» возвращённый → оплачен сразу по свежему замеру: 500', cnt.body);
  ok((await bal(B)).available - bB0 === 500, 'Б получил 500');
  await sleep(300);
  const bDm = dmsTo(B, /Видео засчитано/).slice(bDm0).map((m) => m.text);
  ok(bDm.length === 1 && /500 ₽ на балансе/.test(bDm[0]) && /Администратор засчитал видео — Бренд есть на 0:12/.test(bDm[0]),
    'решение владельца: блогеру ОДНО уведомление — о выплате, с решением в том же тексте', bDm);
  const log = await adm('GET', '/api/admin/log');
  ok(JSON.stringify(log.body).includes('video-decline') && JSON.stringify(log.body).includes('video-count'), 'решения легли в журнал владельца');

  /* ── Накрутка ── */
  console.log('\n— накрутка');
  const bb2 = await bind(B, 'main', link('blogerb', ID.B2));
  const vB2 = bb2.body.video || {};
  ok(bb2.status === 200 && vB2.riskLevel === 'bad' && vB2.riskHold === true, 'подозрительный ролик: уровень bad, выплата на паузе', vB2);
  ok(vB2.risk === null && vB2.riskWhy.length === 0, 'блогеру причины не раскрыты', vB2);
  const advB2 = await getVid(vB2.id, ADV.token);
  ok(advB2.body.video.riskWhy.length >= 2 && advB2.body.video.risk >= 76, 'рекламодателю — причины и балл', advB2.body.video);
  const q2 = await adm('GET', '/api/admin/task-videos?status=queue');
  ok((q2.body.videos || []).some((v) => v.id === vB2.id), 'ролик с подозрением в очереди владельца');
  const rk = await adm('GET', '/api/admin/task-videos?status=risk');
  ok((rk.body.videos || []).some((v) => v.id === vB2.id), 'и в разделе «накрутка»');
  const rB2 = await review(vB2.id, ADV, true);
  ok(rB2.status === 200 && rB2.body.settle === 'held' && rB2.body.video.status === 'active' && rB2.body.video.paid === 0
    && rB2.body.video.riskHold === true, 'накрутка: засчитано, но выплата ждёт владельца', rB2.body);
  await sleep(300);
  ok(dmsTo(B, /проверит просмотры/).length === 1, 'блогеру: перед выплатой администратор проверит просмотры', dmsTo(B).map((m) => m.text));

  /* Спор держит выплату так же, как и накрутка. Спор — по выплатам А из
     ДРУГОГО оффера: он держит все выплаты А по этой заморозке. */
  const b5 = await bind(A, 'short', link('blogera', ID.A5));
  const vA5 = b5.body.video || {};
  const dsp = await api('POST', '/api/deals/dispute/open', { dealId: 'camp:' + camps.short, payeeId: A.id }, ADV.token);
  ok(dsp.status === 200, 'рекламодатель открыл спор по выплате А', dsp.body);
  const rA5 = await review(vA5.id, ADV, true);
  ok(rA5.body.settle === 'held' && rA5.body.video.status === 'active' && rA5.body.video.disputeHeld === true && rA5.body.video.paid === 0,
    'спор держит выплату засчитанного ролика', rA5.body);

  /* Фикс-оффер с заморозкой меньше цены: ролик принят, но резерв и выплата —
     не больше свободного остатка (500 из 800). */
  const bf = await bind(B, 'fix', link('blogerb', ID.B3));
  ok(bf.status === 200 && bf.body.video.reserved === 500 && bf.body.video.earned === 500 && bf.body.video.budgetCap === 500,
    'Б загрузил ролик к фикс-офферу за 800 ₽ при заморозке 500 ₽: резерв 500, предел 500', bf.body);
  /* Строка «до исправления» (без предела в снимке условий, резерв по полной
     цене) — по ней проверяем недоплату: заработано больше, чем есть. */
  setRow(bf.body.video.id, { terms: JSON.stringify({ payMode: 'fixed', rate: 100, fixedPrice: 800, cap: 3000, minViews: 0 }), reserved: 800 });
  const rF = await review(bf.body.video.id, ADV, true);
  const pFix = (await getVid(bf.body.video.id, B.token)).body.video;
  ok(rF.body.settle === 'held' && pFix.status === 'active' && pFix.paid === 500 && pFix.earned === 800 && pFix.payHold === true && pFix.holdReason === '',
    'старая строка: заработано 800 ₽ (не срезано заморозкой), выплачено 500 ₽, остаток на паузе; блогеру без причины', pFix);
  const pFixAdv = (await getVid(bf.body.video.id, ADV.token)).body.video;
  ok(pFixAdv.holdReason === 'В заморозке кампании не хватило денег: недоплачено 300 ₽', 'рекламодателю — причина паузы', pFixAdv.holdReason);
  await sleep(300);
  const fixDm = dmsTo(B, /Выплата за видео/).map((m) => m.text).join('\n');
  ok(/заработано 800 ₽, начислено 500 ₽/.test(fixDm) && /Остальные 300 ₽ задерживается/.test(fixDm) && !/выплаты нет/.test(fixDm),
    'блогеру правда — сколько заработал, сколько начислено, что остаток задерживается', fixDm);
  const qFix = await adm('GET', '/api/admin/task-videos?status=queue');
  ok((qFix.body.videos || []).some((v) => v.id === bf.body.video.id && v.payHold && /недоплачено 300/.test(v.holdReason)),
    'недоплата — в очереди владельца');

  /* Ролик, который исчезнет до проверки. */
  const b4 = await bind(A, 'main', link('blogera', ID.A4));
  const vA4 = b4.body.video || {};
  ok(b4.status === 200, 'А загрузил ролик, который потом удалит', b4.body);

  /* ── Круг обновления ── */
  console.log('\n— круг');
  V.delete(ID.A4);
  const noKeySync = await api('POST', '/api/admin/task-videos/sync', { force: true }, A.token);
  ok(noKeySync.status === 403, 'круг по кнопке — только владельцу');
  const aS0 = await bal(A), bS0 = await bal(B), advS0 = await bal(ADV);
  const r1 = await sync();
  ok(r1.status === 200 && r1.body.ok, 'круг прошёл', r1.body);
  const pB2 = (await getVid(vB2.id, B.token)).body.video;
  ok(pB2.status === 'active' && pB2.paid === 0 && pB2.riskHold === true, 'накрутка держит выплату и в круге', pB2);
  const pA5 = (await getVid(vA5.id, A.token)).body.video;
  ok(pA5.status === 'active' && pA5.paid === 0 && pA5.disputeHeld === true, 'спор держит выплату и в круге', pA5);
  const qDsp = await adm('GET', '/api/admin/task-videos?status=queue');
  ok((qDsp.body.videos || []).some((v) => v.id === vA5.id && v.disputeHeld === true), 'M: выплата, которую держит спор, — в очереди владельца');
  const ovD = await adm('GET', '/api/admin/overview');
  ok(ovD.body['видео_на_решении'] === (qDsp.body.videos || []).length, 'M: значок совпадает с очередью',
    { badge: ovD.body['видео_на_решении'], queue: (qDsp.body.videos || []).length });
  const pA4 = (await getVid(vA4.id, A.token)).body.video;
  ok(pA4.status === 'review', 'пропал один раз — ещё не удалён', pA4);
  const aS1 = await bal(A), bS1 = await bal(B), advS1 = await bal(ADV);
  ok(aS1.available === aS0.available && bS1.available === bS0.available && advS1.hold === advS0.hold,
    'круг без новых зачётов денег не двигает', { aS0, aS1 });

  const r2 = await sync();
  ok(r2.status === 200, 'второй круг прошёл', r2.body);
  const kA4 = (await getVid(vA4.id, A.token)).body.video;
  ok(kA4.status === 'review' && row(vA4.id).miss === 1, 'K: второй промах через полчаса не считается', kA4);
  setRow(vA4.id, { last_miss_at: Date.now() - 21 * 3600e3 });
  await sync();
  const gA4 = (await getVid(vA4.id, A.token)).body.video;
  ok(gA4.status === 'removed' && gA4.reserved === 0, 'пропал дважды с промежутком в сутки — removed, резерв снят', gA4);

  const forged = await api('POST', '/api/deals/release',
    { dealId: 'camp:' + camps.main, toUserId: A.id, amount: 1, opKey: 'sys:vidpay:999999' }, ADV.token);
  ok(forged.status === 400, 'ключ sys:vidpay:* из приложения не занять', forged.body);
  const rfMain = await api('POST', '/api/deals/refund', { dealId: 'camp:' + camps.main, opKey: 'refund-main-' + tag }, ADV.token);
  ok(rfMain.status === 409 && rfMain.body.code === 'videos_live'
    && rfMain.body.error === 'По заданию есть видео на проверке — вернуть бюджет можно после решения по ним',
  'бюджет задания с видео на проверке не вернуть (и не завершить)', rfMain.body);

  /* Владелец снял подозрение — выплата сразу, по цифрам на момент решения. */
  const bB2 = (await bal(B)).available;
  const free = await adm('POST', '/api/admin/task-videos/decide', { id: vB2.id, decision: 'count', note: 'Проверил вручную' });
  ok(free.status === 200 && free.body.video.riskHold === false, '«засчитать» снимает паузу', free.body);
  ok(free.body.settle === 'paid' && free.body.video.status === 'paid' && free.body.video.paid === 3000 && free.body.video.paidViews === 100000,
    'и платит сразу: 100 000 просмотров упёрлись в потолок 3000', free.body.video);
  await sync();
  ok((await bal(B)).available - bB2 === 3000, 'Б получил 3000 ровно один раз', (await bal(B)).available - bB2);
  const stillB2 = (await getVid(vB2.id, B.token)).body.video;
  ok(stillB2.riskHold === false && stillB2.status === 'paid', 'после решения ролик сам себя не замораживает', stillB2);

  /* Спор снят — следующий круг платит. */
  const cls = await api('POST', '/api/deals/dispute/close', { dealId: 'camp:' + camps.short, payeeId: A.id }, ADV.token);
  ok(cls.status === 200 && cls.body.closed === 1, 'спор снят', cls.body);
  await sync();
  const pA5b = (await getVid(vA5.id, A.token)).body.video;
  ok(pA5b.status === 'paid' && pA5b.paid === 400, 'после спора ролик оплачен кругом: 4000 × 100 / 1000 = 400', pA5b);

  /* ── Отвязка канала ── */
  console.log('\n— отзыв канала');
  const bb4 = await bind(B, 'main', link('blogerb', ID.B4));
  ok(bb4.status === 200, 'Б загрузил ещё ролик', bb4.body);
  const unl = await api('POST', '/api/verify/unlink', { platform: 'tiktok', externalId: 'chan-B' }, B.token);
  ok(unl.status === 200, 'Б отвязал свой TikTok', unl.body);
  const rB4 = (await getVid(bb4.body.video.id, B.token)).body.video;
  ok(rB4.status === 'revoked' && rB4.reserved === 0, 'ролик с отвязанного канала → revoked, резерв снят', rB4);
  const keepB1 = (await getVid(vB1.id, B.token)).body.video;
  ok(keepB1.status === 'paid', 'оплаченные ролики отзыв не трогает', keepB1);
  const keepFix = (await getVid(bf.body.video.id, B.token)).body.video;
  ok(keepFix.status === 'active' && keepFix.paid === 500, 'засчитанный ролик (active) отвязка канала не снимает', keepFix);
  await sleep(300);
  ok(dmsTo(B, /Видео снято с проверки/).some((m) => /вы отключили TikTok-канал/.test(m.text) && /выплаты по нему не будет/.test(m.text)),
    'блогеру честно — снято, потому что он отключил канал', dmsTo(B).map((m) => m.text));
  ok(dmsTo(ADV, /Видео снято с проверки/).length >= 1, 'рекламодателю — что проверять не нужно');
  const bBefore = await bal(B);
  const cRev = await adm('POST', '/api/admin/task-videos/decide', { id: bb4.body.video.id, decision: 'count', note: 'Проверил сам' });
  ok(cRev.status === 200 && cRev.body.settle === 'paid' && cRev.body.video.paid === 100,
    '«засчитать» снятый ролик → оплата по замороженным цифрам (1000 × 100 / 1000)', cRev.body);
  ok(row(bb4.body.video.id).frozen === 1, 'ролик помечен замороженным');
  ok((await bal(B)).available - bBefore.available === 100, 'Б получил 100');
  const after = await bind(B, 'main', link('blogerb', ID.B4));
  ok(after.status === 409 && after.body.code === 'no_channel', 'без канала новых загрузок нет', after.body);
  await sync();
  ok(row(bf.body.video.id).status === 'active', 'круг без канала засчитанный ролик не снимает');

  /* ── Площадки оффера ── */
  console.log('\n— площадки оффера');
  const n1 = await bind(C, 'nl1', link('blogera', ID.A6));
  ok(n1.status === 409 && n1.body.code === 'no_channel', 'TikTok только в platformsList — оффер принимает TikTok', n1.body);
  const n2 = await bind(C, 'nl2', link('blogera', ID.A6));
  ok(n2.status === 409 && n2.body.code === 'no_channel', 'platformsList объектом {tt:true}', n2.body);
  const n3 = await bind(C, 'nl3', link('blogera', ID.A6));
  ok(n3.status === 409 && n3.body.code === 'wrong_platform', 'в platformsList только YouTube — wrong_platform', n3.body);

  /* ── J: отвязка и повторная загрузка ── */
  console.log('\n— отвязка и повтор');
  await sleep(300);
  const advNew0 = dmsTo(ADV, /Новое видео по заданию/).length;
  const j1 = await bind(A, 'main', link('blogera', ID.A6));
  ok(j1.status === 200, 'А загрузил ролик', j1.body);
  await api('POST', '/api/tasks/video/unbind', { id: j1.body.video.id }, A.token);
  const j2 = await bind(A, 'main', link('blogera', ID.A6));
  ok(j2.status === 200, 'отвязал и загрузил снова', j2.body);
  await sleep(300);
  ok(dmsTo(ADV, /Новое видео по заданию/).length - advNew0 === 1, 'J: рекламодателю о том же ролике — одно письмо в сутки',
    dmsTo(ADV, /Новое видео/).length - advNew0);
  const ipU = '10.201.0.1';
  let ubl = null;
  for (let i = 0; i < 6; i++) ubl = await api('POST', '/api/tasks/video/unbind', { id: 999999 }, C.token, { ip: ipU });
  ok(ubl.status === 429, 'J: больше 5 отвязок в час — 429', ubl.body);

  /* ── Снимок условий ── */
  console.log('\n— снимок условий');
  const d1 = await bind(D, 'termsX', link('blogerd', ID.D1));
  const vD1 = d1.body.video || {};
  const snap = JSON.parse(row(vD1.id).terms || 'null');
  ok(d1.status === 200 && snap && snap.rate === 100 && snap.cap === 3000 && snap.payMode === 'views',
    'условия сняты в момент загрузки', snap);
  const rw = await api('POST', '/api/sync/put', { kind: 'camp', rid: camps.termsX,
    data: Object.assign({ id: camps.termsX }, base, { name: 'Переписанный', rate: 0, maxPayout: 1, minViews: 1e9 }) }, ADV.token);
  ok(rw.status === 200, 'рекламодатель переписал ставку в ноль после загрузки');
  V.get(ID.D1).views = 6000;
  const rD1 = await review(vD1.id, ADV, true);
  ok(rD1.body.video.status === 'paid' && rD1.body.video.earned === 600 && rD1.body.video.paid === 600,
    'выплата по снимку: 6000 × 100 / 1000 = 600', rD1.body.video);
  /* Строка «как до снимков»: условия возьмутся из конверта один раз. */
  const d5 = await bind(D, 'terms', link('blogerd', ID.D5));
  setRow(d5.body.video.id, { terms: null });
  const rD5 = await review(d5.body.video.id, ADV, true);
  ok(rD5.body.video.status === 'paid' && rD5.body.video.paid === 500, 'старая строка посчитана по конверту: 5000 × 100 / 1000 = 500', rD5.body.video);
  ok(JSON.parse(row(d5.body.video.id).terms || 'null').rate === 100, 'и снимок тут же записан');

  /* ── Резерв бюджета ── */
  console.log('\n— резерв бюджета');
  const d2 = await bind(D, 'resv', link('blogerd', ID.D2));
  const vD2 = d2.body.video || {};
  ok(d2.status === 200 && vD2.reserved === 300, 'Д загрузил ролик: резерв — оценка 300 ₽', d2.body);
  const rl1 = await api('POST', '/api/deals/release', { dealId: 'camp:' + camps.resv, toUserId: C.id, amount: 800, opKey: 'rel1-' + tag }, ADV.token);
  ok(rl1.status === 409 && rl1.body.code === 'videos_reserved' && rl1.body.reserved === 300 && rl1.body.free === 700,
    'вручную нельзя выплатить зарезервированное под видео', rl1.body);
  const rl2 = await api('POST', '/api/deals/release', { dealId: 'camp:' + camps.resv, toUserId: C.id, amount: 700, opKey: 'rel2-' + tag }, ADV.token);
  ok(rl2.status === 200 && rl2.body.paid === 700, 'свободную часть — можно', rl2.body);
  const rfR = await api('POST', '/api/deals/refund', { dealId: 'camp:' + camps.resv, opKey: 'rfr-' + tag }, ADV.token);
  ok(rfR.status === 409 && rfR.body.code === 'videos_live', 'вернуть бюджет нельзя, пока видео на проверке', rfR.body);
  /* Оператор всё же вернул бюджет — в заморозке пусто. */
  const rfAdm = await api('POST', '/api/deals/refund', { dealId: 'camp:' + camps.resv, opKey: 'rfa-' + tag }, ADV.token, { admin: true });
  ok(rfAdm.status === 200 && rfAdm.body.refunded === 300, 'оператор вернул остаток бюджета', rfAdm.body);
  const dBal0 = await bal(D);
  const rD2 = await review(vD2.id, ADV, true);
  const pD2 = (await getVid(vD2.id, ADV.token)).body.video;
  ok(rD2.body.settle === 'held' && pD2.status === 'active' && pD2.paid === 0 && pD2.earned === 300 && pD2.payHold === true
    && pD2.holdReason === 'В заморозке кампании не хватило денег: недоплачено 300 ₽',
  'денег нет — ролик не закрыт нулём, а ждёт владельца', pD2);
  await sleep(300);
  const d2Dm = dmsTo(D, /задерживается/).map((m) => m.text);
  ok(d2Dm.length === 1 && /заработано 300 ₽/.test(d2Dm[0]) && !dmsTo(D, /выплаты нет/).length,
    'блогеру не «выплаты нет», а «заработано 300 ₽, задерживается»', dmsTo(D).map((m) => m.text));
  await sync();
  await sleep(300);
  ok(dmsTo(D, /задерживается/).length === 1 && (await bal(D)).available === dBal0.available,
    'ролик на паузе круг не перебирает и не пишет снова');

  /* Резервы снимаются при отказе и отвязке. */
  const fa = await bindAs(F, 'rsv', link('blogerf1', ID.F1a), { platform: 'tiktok', account: 'chan-F1' });
  const fb = await bindAs(F, 'rsv', link('blogerf2', ID.F2a), { platform: 'tiktok', account: 'chan-F2' });
  ok(fa.status === 200 && fb.status === 200 && fa.body.video.reserved === 200 && fb.body.video.reserved === 300, 'два ролика: резервы 200 и 300 ₽');
  const rsv0 = (await board(ADV, 'rsv')).body;
  ok(rsv0.reserved === 500 && rsv0.left === rsv0.budget - rsv0.paid - 500, 'в бюджете задания «В резерве» 500 ₽', rsv0);
  await api('POST', '/api/tasks/video/unbind', { id: fa.body.video.id }, F.token);
  ok((await board(ADV, 'rsv')).body.reserved === 300, 'отвязал — резерв снят');
  await review(fb.body.video.id, ADV, false, 'Нет ссылки в описании');
  ok((await board(ADV, 'rsv')).body.reserved === 300, 'возражение рекламодателя резерв держит');
  await adm('POST', '/api/admin/task-videos/decide', { id: fb.body.video.id, decision: 'decline', note: 'не по ТЗ' });
  const rsv1 = (await board(ADV, 'rsv')).body;
  ok(rsv1.reserved === 0 && rsv1.left === rsv1.budget - rsv1.paid, '«не засчитывать» — резерв вернулся в «Свободно»', rsv1);

  /* ── Выбранный аккаунт ── */
  console.log('\n— выбор аккаунта');
  const fx = await bindAs(F, 'rsv', link('blogerf2', ID.F2b), { platform: 'tiktok', account: 'chan-F1' });
  ok(fx.status === 409 && fx.body.code === 'not_yours'
    && fx.body.error === 'Этого видео нет на аккаунте @blogerf1 — выберите другой аккаунт или проверьте ссылку',
  'видео со второго аккаунта, выбран первый — not_yours с ником', fx.body);
  const fy = await bindAs(F, 'rsv', link('blogerf2', ID.F2b), { platform: 'tiktok', account: 'chan-F2' });
  ok(fy.status === 200, 'выбран нужный аккаунт — принято', fy.body);

  /* ── Решение владельца — только про те цифры, что он видел ── */
  console.log('\n— решение и новые цифры');
  const d3 = await bind(D, 'terms', link('blogerd', ID.D3));
  const vD3 = d3.body.video || {};
  ok(d3.status === 200 && vD3.riskHold === true, 'Д: подозрительный ролик на паузе', vD3);
  const cD3 = await adm('POST', '/api/admin/task-videos/decide', { id: vD3.id, decision: 'count', note: 'цифры честные' });
  ok(cD3.status === 200 && cD3.body.video.riskHold === false && cD3.body.video.status === 'review' && row(vD3.id).decided_views === 100000,
    'решение запомнило 100 000 просмотров, ролик ждёт рекламодателя', cD3.body);
  Object.assign(V.get(ID.D3), { views: 150000, likes: 150 });
  await sync();
  ok(row(vD3.id).risk_hold === 0 && row(vD3.id).risk_level === 'bad', 'до двукратного роста решение держит');
  Object.assign(V.get(ID.D3), { views: 250000, likes: 250 });
  await sync();
  ok(row(vD3.id).risk_hold === 1, 'выросло больше чем вдвое — снова пауза');
  const d4 = await bind(D, 'terms', link('blogerd', ID.D4));
  const vD4 = d4.body.video || {};
  await review(vD4.id, ADV, false, 'Нет ссылки в описании');
  Object.assign(V.get(ID.D4), { views: 100000, likes: 100, comments: 0, shares: 0 });
  const cD4 = await adm('POST', '/api/admin/task-videos/decide', { id: vD4.id, decision: 'count' });
  ok(cD4.status === 200 && cD4.body.settle === 'held' && cD4.body.video.status === 'active' && cD4.body.video.riskHold === true
    && cD4.body.video.paid === 0 && row(vD4.id).decided_views === null,
  '«засчитать» возвращённый — не решение о накрутке: свежий замер плохой, выплата ждёт', cD4.body);

  /* ── G: строку закрыли, пока ждали площадку ── */
  console.log('\n— гонка с площадкой');
  const d6 = await bind(D, 'terms', link('blogerd', ID.D6));
  const vD6 = d6.body.video || {};
  setRow(vD6.id, { stats_at: Date.now() - 3600e3, last_try_at: Date.now() - 3600e3 });
  SLOW.add(ID.D6);
  V.get(ID.D6).views = 77777;
  const slowRf = api('POST', '/api/tasks/video/refresh', { id: vD6.id }, D.token);
  await sleep(400);
  const decG = await adm('POST', '/api/admin/task-videos/decide', { id: vD6.id, decision: 'decline', note: 'не по ТЗ' });
  ok(decG.status === 200 && decG.body.video.status === 'declined', 'владелец закрыл ролик, пока площадка думала', decG.body);
  const sr = await slowRf;
  SLOW.delete(ID.D6);
  ok(sr.status === 200 && sr.body.fresh === true && sr.body.video.status === 'declined', 'площадку спросили, но ответ пришёл уже к закрытой строке', sr.body);
  ok(row(vD6.id).status === 'declined' && row(vD6.id).views !== 77777, 'ответ площадки не оживил закрытую строку', row(vD6.id));

  /* ── L: рекламодатель молчит трое суток ── */
  console.log('\n— автозачёт');
  const d7 = await bind(D, 'terms', link('blogerd', ID.D7));
  const vD7 = d7.body.video || {};
  setRow(vD7.id, { created_at: Date.now() - 73 * 3600e3 });
  const dA0 = (await bal(D)).available;
  await sleep(300);
  const dDm0 = dmsTo(D, /Видео засчитано/).length;
  const rAuto = await sync();
  ok(rAuto.body.autoAccepted === 1, 'круг засчитал один ролик сам', rAuto.body);
  const pD7 = (await getVid(vD7.id, D.token)).body.video;
  ok(pD7.decision === 'auto' && pD7.approvedAt > 0 && pD7.status === 'paid' && pD7.paid === 100, 'автозачёт — и сразу выплата: 100', pD7);
  ok((await bal(D)).available - dA0 === 100, 'Д получил 100');
  await sleep(300);
  const autoTxt = 'Рекламодатель не ответил за 3 дня — видео засчитано автоматически';
  ok(dmsTo(D).some((m) => m.text.includes(autoTxt)) && dmsTo(ADV).some((m) => m.text.includes(autoTxt)), 'обеим сторонам сказано');
  const dDm = dmsTo(D, /Видео засчитано/).slice(dDm0).map((m) => m.text);
  ok(dDm.length === 1 && /100 ₽ на балансе/.test(dDm[0]) && dDm[0].includes(autoTxt),
    'автозачёт: блогеру ОДНО уведомление — «засчитано, 100 ₽ на балансе» с причиной автозачёта', dDm);

  /* ── Свежий замер не удался ── */
  console.log('\n— замер при зачёте не удался');
  const e1 = await bind(E, 'main', link('blogere', ID.E1));
  const e2 = await bind(E, 'main', link('blogere', ID.E2));
  const e3 = await bind(E, 'main', link('blogere', ID.E3));
  ok(e1.status === 200 && e2.status === 200 && e3.status === 200, 'Е загрузил три ролика');
  const vE1 = e1.body.video, vE2 = e2.body.video, vE3 = e3.body.video;
  /* Сбой ПЛОЩАДКИ (TikTok отвечает 500): по последним цифрам — можно. */
  DOWN.add(ID.E1); DOWN.add(ID.E2);
  const eBal0 = (await bal(E)).available;
  const rE1 = await review(vE1.id, ADV, true);
  ok(rE1.body.settle === 'paid' && rE1.body.video.paid === 100 && !rE1.body.video.payNote,
    'площадка упала, последнему замеру меньше суток — оплачено по нему', rE1.body.video);
  setRow(vE2.id, { stats_at: Date.now() - 25 * 3600e3 });
  const rE2 = await review(vE2.id, ADV, true);
  const hE2 = (await getVid(vE2.id, ADV.token)).body.video;
  ok(rE2.body.settle === 'held' && hE2.status === 'active' && hE2.payHold && hE2.paid === 0
    && hE2.holdReason === 'Нет свежего замера: TikTok не отдал цифры ролика — повторим через полчаса' && row(vE2.id).pay_tries === 1,
  'площадка упала, последнему больше суток — выплата ждёт повтора', hE2);
  ok((await getVid(vE2.id, E.token)).body.video.holdReason === '', 'блогеру без служебной причины');
  const qE = await adm('GET', '/api/admin/task-videos?status=queue');
  ok(!(qE.body.videos || []).some((v) => v.id === vE2.id), 'пауза «нет замера» владельцу не нужна — её повторит круг');
  const qm = fakeLog.length;
  await sync();
  ok(row(vE2.id).pay_tries === 1 && !fakeLog.slice(qm).some((l) => l.startsWith('Q ') && l.includes(ID.E2)),
    'повтор не чаще раза в 20 минут: круг сразу после — без запроса');
  setRow(vE2.id, { last_try_at: Date.now() - 30 * 60e3 });
  await sync();
  ok(row(vE2.id).pay_tries === 2 && row(vE2.id).status === 'active', 'вторая неудача — ещё ждём');
  setRow(vE2.id, { last_try_at: Date.now() - 30 * 60e3 });
  await sync();
  const pE2 = (await getVid(vE2.id, ADV.token)).body.video;
  ok(pE2.status === 'paid' && pE2.paid === 100 && /^Оплачено по последнему замеру/.test(pE2.payNote) && !pE2.payHold,
    'третья неудача площадки — оплачено по последнему замеру, с пометкой для владельца', pE2);
  ok((await getVid(vE2.id, E.token)).body.video.payNote === '', 'блогеру пометка не отдаётся');
  ok((await bal(E)).available - eBal0 === 200, 'Е получил 100 + 100');
  await sleep(300);
  ok(dmsTo(E, /Выплата за видео задерживается/).length === 1, 'о задержке блогеру — один раз', dmsTo(E).map((m) => m.text));
  DOWN.delete(ID.E1); DOWN.delete(ID.E2);
  /* Площадка снова отвечает — платим по свежему замеру. */
  setRow(vE3.id, { stats_at: Date.now() - 25 * 3600e3 });
  DOWN.add(ID.E3);
  await review(vE3.id, ADV, true);
  ok(row(vE3.id).pay_hold === 1 && row(vE3.id).hold_kind === 'measure', 'третий ролик ждёт замера');
  DOWN.delete(ID.E3);
  V.get(ID.E3).views = 3000;
  setRow(vE3.id, { last_try_at: Date.now() - 30 * 60e3 });
  await sync();
  const pE3 = (await getVid(vE3.id, ADV.token)).body.video;
  ok(pE3.status === 'paid' && pE3.paid === 300 && pE3.paidViews === 3000 && !pE3.payNote, 'площадка ожила — оплачено по свежему замеру: 300', pE3);

  /* Сбой ДОСТУПА (блогер отозвал доступ к TikTok и удалил ролик): ни сразу,
     ни после трёх кругов «по последним цифрам» не платим — пауза к владельцу. */
  const e5 = await bind(E, 'main', link('blogere', ID.E5));
  const e7 = await bind(E, 'main', link('blogere', ID.E7));
  ok(e5.status === 200 && e7.status === 200, 'Е загрузил ещё два ролика');
  const vE5 = e5.body.video, vE7 = e7.body.video;
  delete TOKENS['tok-E'];
  V.delete(ID.E5);
  const eBal1 = (await bal(E)).available;
  const rE5 = await review(vE5.id, ADV, true);
  const hE5 = (await getVid(vE5.id, ADV.token)).body.video;
  ok(rE5.body.settle === 'held' && hE5.status === 'active' && hE5.payHold === true && hE5.paid === 0
    && /^Нет доступа к TikTok блогера/.test(hE5.holdReason) && row(vE5.id).hold_kind === 'access',
  'доступ отозван, цифрам меньше суток — НЕ оплачено, пауза «нет доступа»', hE5);
  ok((await bal(E)).available === eBal1, 'деньги не ушли');
  const qA = await adm('GET', '/api/admin/task-videos?status=queue');
  ok((qA.body.videos || []).some((v) => v.id === vE5.id && v.payHold), 'пауза «нет доступа» — в очереди владельца');
  await sleep(300);
  ok(dmsTo(E, /Переподключите TikTok/).length === 1 && /выплата за засчитанные ждёт/.test(dmsTo(E, /Переподключите TikTok/)[0].text)
    && !/по последним цифрам/.test(dmsTo(E, /Переподключите TikTok/)[0].text),
  'блогеру — «переподключите», без обещания платить по последним цифрам', dmsTo(E).map((m) => m.text));
  for (let i = 0; i < 3; i++) { setRow(vE5.id, { last_try_at: Date.now() - 4 * 3600e3 }); await sync(); }
  ok(row(vE5.id).status === 'active' && row(vE5.id).paid === 0 && (await bal(E)).available === eBal1,
    'три круга подряд — всё ещё не оплачено (раньше платилось «по последнему замеру»)', row(vE5.id));
  /* Владелец сам решил «засчитать» — платим по цифрам на момент решения. */
  const rE7 = await review(vE7.id, ADV, true);
  ok(rE7.body.settle === 'held' && row(vE7.id).hold_kind === 'access', 'второй ролик тоже ждёт');
  const cE7 = await adm('POST', '/api/admin/task-videos/decide', { id: vE7.id, decision: 'count', note: 'Ролик на месте, проверил' });
  ok(cE7.status === 200 && cE7.body.settle === 'paid' && cE7.body.video.paid === 100, 'владелец засчитал — оплачено по цифрам на момент решения', cE7.body);
  /* Блогер вернул доступ — круг пробует снова (не чаще раза в 3 часа): удалённый ролик → removed. */
  TOKENS['tok-E'] = 'chan-E';
  setRow(vE5.id, { last_try_at: Date.now() - 30 * 60e3 });
  const qe5 = fakeLog.length;
  await sync();
  ok(!fakeLog.slice(qe5).some((l) => l.startsWith('Q ') && l.includes(ID.E5)) && row(vE5.id).status === 'active',
    'пауза «нет доступа» повторяется не чаще раза в 3 часа');
  setRow(vE5.id, { last_try_at: Date.now() - 4 * 3600e3 });
  await sync();
  ok(row(vE5.id).status === 'removed' && row(vE5.id).paid === 0 && (await bal(E)).available - eBal1 === 100,
    'доступ вернулся, а ролика нет — removed без выплаты (за Е7 пришли 100 по решению владельца)', row(vE5.id));

  /* Канал отвязан, пока засчитанный ролик ждал замера (площадка падала) — не платим. */
  const e6 = await bind(E, 'main', link('blogere', ID.E6));
  const vE6 = e6.body.video;
  DOWN.add(ID.E6);
  setRow(vE6.id, { stats_at: Date.now() - 25 * 3600e3 });
  await review(vE6.id, ADV, true);
  ok(row(vE6.id).hold_kind === 'measure', 'Е6 засчитан, ждёт замера (площадка падает)');
  /* Владелец отвязал канал — снят только ролик на проверке. */
  const e4 = await bind(E, 'main', link('blogere', ID.E4));
  const aul = await adm('POST', '/api/admin/verify/unlink', { platform: 'tiktok', externalId: 'chan-E' });
  ok(aul.status === 200, 'владелец отвязал канал Е', aul.body);
  ok(row(e4.body.video.id).status === 'revoked' && row(vE2.id).status === 'paid', 'снят только ролик на проверке, оплаченные остались');
  await sleep(300);
  ok(dmsTo(E, /Видео снято с проверки/).some((m) => /администратор отключил TikTok-канал/.test(m.text)), 'блогеру сказано, кто отключил');
  DOWN.delete(ID.E6);
  const eBal2 = (await bal(E)).available;
  for (let i = 0; i < 3; i++) { setRow(vE6.id, { last_try_at: Date.now() - 30 * 60e3 }); await sync(); }
  ok(row(vE6.id).status === 'active' && row(vE6.id).hold_kind === 'access' && (await bal(E)).available === eBal2
    && /TikTok-канал блогера отвязан/.test(row(vE6.id).pay_why),
  'канал отвязан — засчитанный ролик не оплачен «по последним цифрам», ждёт владельца', row(vE6.id));
  await sleep(300);
  ok(dmsTo(E, /Выплата за видео задерживается/).some((m) => /отключён/.test(m.text)), 'блогеру — что канал отключён и что делать');

  /* Отвязал канал, пока сервер ждал площадку: ролик на отвязанный канал не пишется. */
  SLOW.add(ID.U1);
  const uBind = bind(U, 'main', link('bloggeru', ID.U1));
  await sleep(400);
  const uUnl = await api('POST', '/api/verify/unlink', { platform: 'tiktok', externalId: 'chan-U' }, U.token);
  const uRes = await uBind;
  SLOW.delete(ID.U1);
  ok(uUnl.status === 200 && uRes.status === 409 && uRes.body.code === 'no_channel'
    && !dbx().prepare('SELECT id FROM task_videos WHERE video_id = ?').get(ID.U1),
  'канал отвязан, пока ждали TikTok, — no_channel, строка не записана', uRes.body);

  /* Оплаченный ролик, доступ умер: обновление «для показа» молчит. */
  const pp1 = await bind(PP, 'main', link('bloggerp', ID.P1));
  const rpp1 = await review(pp1.body.video.id, ADV, true);
  ok(rpp1.body.settle === 'paid', 'П: ролик оплачен');
  delete TOKENS['tok-P'];
  setRow(pp1.body.video.id, { stats_at: Date.now() - 25 * 3600e3, last_try_at: Date.now() - 25 * 3600e3 });
  await sync();
  await sleep(300);
  ok(row(pp1.body.video.id).last_try_at > Date.now() - 60e3 && !dmsTo(PP, /Переподключите/).length,
    'оплаченный ролик с мёртвым доступом: попытка записана, «переподключите … по последним цифрам» не шлём', dmsTo(PP).map((m) => m.text));

  /* ── YouTube: доступ канала, refresh, разбор ссылок ── */
  console.log('\n— YouTube (доступ канала)');
  const ys = await api('GET', '/api/verify/start?platform=youtube', null, Y.token);
  const ysu = new URL(ys.body.url || 'https://x/');
  ok(ysu.searchParams.get('access_type') === 'offline' && /consent/.test(ysu.searchParams.get('prompt') || ''),
    'подтверждение YouTube просит доступ offline (Google даёт refresh) и согласие', ys.body.url);
  const yBal0 = (await bal(Y)).available;
  const y1 = await bind(Y, 'ytc', 'Новый ролик! https://www.youtube.com/watch?v=' + YT.Y1 + '&t=10s — смотрите');
  const vY1 = y1.body.video || {};
  ok(y1.status === 200 && vY1.platform === 'youtube' && vY1.videoId === YT.Y1, 'ссылка watch?v= в тексте — ролик YouTube загружен', y1.body);
  ok(gLog.includes('YREFRESH yref-Y') && gLog.some((l) => l.startsWith('VTOK ytok-Y2 ')), 'доступ канала протух — обменян по refresh, ролик спрошен новым');
  ok(vY1.player === 'https://www.youtube.com/embed/' + YT.Y1 && vY1.url === 'https://www.youtube.com/watch?v=' + YT.Y1
    && vY1.cover === 'https://i.ytimg.com/vi/' + YT.Y1 + '/hqdefault.jpg', 'плеер, постоянная ссылка и обложка YouTube', vY1);
  ok(vY1.handle === 'ycanal' && vY1.duration === 65 && vY1.views === 3000 && vY1.likes === 300 && vY1.comments === 12 && vY1.shares === 0
    && vY1.reserved === 300, 'ник канала, длительность из ISO (PT1M5S = 65), цифры и резерв', vY1);
  const y2 = await bind(Y, 'ytc', 'youtu.be/' + YT.Y2);
  ok(y2.status === 200 && y2.body.video.videoId === YT.Y2, 'короткая youtu.be без https:// — принята', y2.body);
  const y3 = await bind(Y, 'ytc', 'https://m.youtube.com/shorts/' + YT.Y3 + '?feature=share');
  ok(y3.status === 200 && y3.body.video.url === 'https://www.youtube.com/shorts/' + YT.Y3, 'shorts с m. — постоянная ссылка на shorts', y3.body);
  const y4 = await bind(Y, 'ytc', 'https://youtube.com/live/' + YT.Y4 + '.');
  ok(y4.status === 200 && y4.body.video.videoId === YT.Y4, '/live/ID с точкой в конце фразы', y4.body);
  const gT0 = gLog.length;
  const yTaken = await bind(Y, 'ytc', 'https://www.youtube.com/embed/' + YT.Y1);
  ok(yTaken.status === 409 && yTaken.body.code === 'taken', '/embed/ID — тот же ролик второй раз: taken', yTaken.body);
  ok(gLog.length === gT0, 'свой уже загруженный ролик — ответ без запроса к Google (квота цела)', gLog.slice(gT0));
  for (const [u, what] of [
    ['https://youtube.com.evil.ru/watch?v=' + YT.Y5, 'youtube.com.evil.ru'],
    ['https://youtube.com@evil.ru/watch?v=' + YT.Y5, 'пароль-хост youtube.com@evil.ru'],
    ['http://www.youtube.com/watch?v=' + YT.Y5, 'http:// без s'],
    ['https://youtu.be/', 'youtu.be без id'],
    ['https://www.youtube.com/@ycanal', 'ссылка на канал'],
    ['https://www.youtube.com/watch?v=' + YT.Y5 + 'x', 'id длиннее 11'],
    ['https://www.youtube.com:8443/watch?v=' + YT.Y5, 'чужой порт'],
  ]) {
    const r = await bind(Y, 'ytc', u);
    ok(r.status === 400 && r.body.code === 'bad_url', 'bad_url: ' + what, r.body);
  }
  const yNone = await bind(Y, 'ytc', ylink(YT.NONE));
  ok(yNone.status === 404 && yNone.body.code === 'not_found', 'YouTube: такого ролика нет — not_found', yNone.body);
  const yNotYours = await bind(Y, 'ytc', ylink(YT.Z1));
  ok(yNotYours.status === 409 && yNotYours.body.code === 'not_yours' && yNotYours.body.error === 'Это видео не с ваших подключённых аккаунтов YouTube',
    'YouTube: чужой ролик — not_yours', yNotYours.body);
  const yNotYoursAcc = await bindAs(Y, 'ytc', ylink(YT.Z1), { platform: 'youtube', account: 'UC-Y' });
  ok(yNotYoursAcc.status === 409 && yNotYoursAcc.body.error === 'Этого видео нет на аккаунте @ycanal — выберите другой аккаунт или проверьте ссылку',
    'YouTube: с выбранным каналом — текст с его ником', yNotYoursAcc.body);
  const yNoAcc = await bindAs(Y, 'ytc', ylink(YT.Y5), { platform: 'youtube', account: 'UC-Z' });
  ok(yNoAcc.status === 409 && yNoAcc.body.code === 'no_account', 'YouTube: чужой канал не выбрать — no_account', yNoAcc.body);
  const yUnl = await bind(Y, 'ytc', ylink(YT.Y6));
  ok(yUnl.status === 409 && yUnl.body.code === 'not_public' && yUnl.body.error === 'Видео закрыто — откройте его для всех и попробуйте снова',
    'not_public: ролик «по ссылке»', yUnl.body);
  const yPriv = await bind(Y, 'ytc', ylink(YT.Y7));
  ok(yPriv.status === 409 && yPriv.body.code === 'not_public', 'not_public: закрытый ролик (его видит только доступ владельца)', yPriv.body);
  const yShort = await bind(Y, 'ytc', ylink(YT.Y8));
  ok(yShort.status === 409 && yShort.body.code === 'too_short' && yShort.body.error === 'Видео короче 30 сек — так в условиях задания',
    'too_short: длительность PT20S из ISO', yShort.body);
  const yBoom = await bind(Y, 'ytc', ylink(YT.BOOM));
  ok(yBoom.status === 502 && yBoom.body.code === 'youtube' && yBoom.body.error === 'YouTube сейчас не отвечает — попробуйте через минуту',
    'youtube: Google упал — 502', yBoom.body);
  const yW = await bind(W, 'ytc', ylink(YT.Y5));
  ok(yW.status === 409 && yW.body.code === 'token' && yW.body.error === 'Доступ к YouTube истёк — переподключите канал',
    'token: доступ YouTube протух, refresh нет', yW.body);
  const yQ = await bind(Q, 'ytc', ylink(YT.Q1));
  ok(yQ.status === 502 && yQ.body.code === 'youtube' && gLog.filter((l) => l === 'YREFRESH yref-Q').length === 2,
    'Google на обмене доступа ответил 503 — 502 youtube (не «переподключите»), с повтором', { body: yQ.body, n: gLog.filter((l) => l === 'YREFRESH yref-Q').length });
  const yBan = await bind(Y, 'ban', ylink(YT.Y9));
  ok(yBan.status === 200, 'задание «Баннеры» без площадок принимает и YouTube', yBan.body);
  YV.get(YT.Y1).views = 5000;
  const gq = gLog.length;
  const rY1 = await review(vY1.id, ADV, true);
  ok(rY1.body.settle === 'paid' && rY1.body.video.paid === 500 && rY1.body.video.paidViews === 5000
    && gLog.slice(gq).some((l) => l.startsWith('VTOK') && l.includes(YT.Y1)),
  'YouTube: зачёт — свежий замер доступом канала и выплата 500', rY1.body.video);
  ok((await bal(Y)).available - yBal0 === 500, 'Игрек получил 500');
  /* Ролик закрыли до зачёта — для задания его больше нет. */
  YV.get(YT.Y2).privacy = 'private';
  const rY2 = await review(y2.body.video.id, ADV, true);
  ok(rY2.body.settle === 'removed' && rY2.body.video.status === 'removed', 'YouTube: ролик закрыли до зачёта — removed без выплаты', rY2.body);

  /* ── Аккаунты для окна загрузки ── */
  console.log('\n— аккаунты');
  const accY = await api('GET', '/api/tasks/video/accounts', null, Y.token);
  const ay = (accY.body.accounts || []);
  const ayT = ay.find((a) => a.platform === 'tiktok'), ayY = ay.find((a) => a.platform === 'youtube');
  ok(accY.status === 200 && ay.length === 2 && ayT && ayY, 'оба канала Игрека: TikTok и YouTube', accY.body);
  ok(ayY && ayY.id === 'UC-Y' && ayY.handle === '@ycanal' && ayY.title === 'Канал Игрек' && ayY.avatar === 'https://yt3.ggpht.com/a/ycanal.jpg'
    && ayY.ready === true && ayY.why === '', 'YouTube: ник, название, аватар, готов', ayY);
  ok(ayT && ayT.id === 'chan-Y' && ayT.handle === '@blogery' && ayT.ready === true, 'TikTok: ник и готов', ayT);
  ok(!JSON.stringify(accY.body).includes('ytok') && !JSON.stringify(accY.body).includes('yref'), 'токенов в ответе нет');
  const accF = await api('GET', '/api/tasks/video/accounts', null, F.token);
  ok((accF.body.accounts || []).length === 2 && accF.body.accounts.every((a) => a.platform === 'tiktok' && /^chan-F/.test(a.id)),
    'у Ф — два своих TikTok, чужих нет', accF.body);
  const accW = await api('GET', '/api/tasks/video/accounts', null, W.token);
  ok((accW.body.accounts || []).length === 1 && accW.body.accounts[0].ready === false && accW.body.accounts[0].why === 'token',
    'у Дабла YouTube без refresh — ready:false, why:token', accW.body);
  const accC = await api('GET', '/api/tasks/video/accounts', null, C.token);
  ok(accC.status === 200 && Array.isArray(accC.body.accounts) && accC.body.accounts.length === 0, 'без каналов — пустой список');
  ok((await api('GET', '/api/tasks/video/accounts')).status === 401, 'без входа — 401');

  /* ── Участники и лидерборд ── */
  console.log('\n— участники и лидерборд');
  const jOwn = await api('POST', '/api/tasks/join', { campId: camps.brd }, ADV.token);
  ok(jOwn.status === 409 && jOwn.body.code === 'own_camp', 'в своё задание не вступить', jOwn.body);
  const jPaused = await api('POST', '/api/tasks/join', { campId: camps.paused }, G.token);
  ok(jPaused.status === 409 && jPaused.body.code === 'camp_closed', 'в задание на паузе не вступить', jPaused.body);
  const jNone = await api('POST', '/api/tasks/join', { campId: 'нет-такого' }, G.token);
  ok(jNone.status === 404 && jNone.body.code === 'no_camp', 'нет задания — 404', jNone.body);
  ok((await api('POST', '/api/tasks/join', { campId: camps.brd })).status === 401, 'без входа — 401');
  const cardG = await api('POST', '/api/cards', { id: 'card-g-' + tag, card: { name: 'Галя Г' } }, G.token);
  ok(cardG.status === 200, 'у Г есть открытая карточка в каталоге', cardG.body);
  const jG = await api('POST', '/api/tasks/join', { campId: camps.brd }, G.token);
  ok(jG.status === 200 && jG.body.ok && jG.body.already === false && jG.body.joinedAt > 0, 'Г вступил в задание', jG.body);
  const jG2 = await api('POST', '/api/tasks/join', { campId: camps.brd }, G.token);
  ok(jG2.status === 200 && jG2.body.already === true && jG2.body.joinedAt === jG.body.joinedAt, 'повтор — тихо ок', jG2.body);
  await sleep(5);
  const hb = await bind(H, 'brd', link('blogerh', ID.H1));
  ok(hb.status === 200, 'Аш загрузил видео без /join (старое приложение)', hb.body);
  await sleep(5);
  const yb = await bind(Y, 'brd', ylink(YT.Y5));
  ok(yb.status === 200, 'Игрек загрузил видео с YouTube', yb.body);
  const gb = await bind(G, 'brd', link('blogerg', ID.G1));
  await review(gb.body.video.id, ADV, true);
  const bG = await board(G, 'brd');
  const bb = bG.body;
  ok(bG.status === 200 && bb.members === 3 && bb.videos === 3 && bb.views === 16000, 'счётчики: 3 участника, 3 видео, 16 000 просмотров', bb);
  ok(bb.budget === 10000 && bb.paid === 200 && bb.reserved === 1400 && bb.left === 8400,
    'бюджет: выплачено 200, в резерве 1400 (900 + 500), свободно 8400', bb);
  /* Как у More Views (решение владельца): по умолчанию «по сумме выплаты»,
     «по просмотрам» — по переключателю. */
  const L = bb.leaders || [];
  ok(bb.sort === 'earned' && L.length === 3 && L.map((r) => r.name).join('|') === 'Галя Г|Яна Игрек|Хасан Аш'
    && L.map((r) => r.rank).join() === '1,2,3', 'лидерборд по умолчанию — по сумме выплаты: Г (200 ₽), затем по просмотрам Игрек, Аш', L);
  ok(L[1].views === 9000 && L[1].platform === 'youtube' && L[1].handle === '@ycanal' && L[1].avatar === 'https://yt3.ggpht.com/a/ycanal.jpg'
    && L[1].videos === 1 && L[1].earned === 0 && L[2].handle === '@blogerh' && L[2].platform === 'tiktok' && L[2].avatar === ''
    && L[0].earned === 200 && L[0].handle === '@blogerg', 'строки: ник, площадка, аватар, видео, просмотры, заработок', L);
  ok(bb.me && bb.me.rank === 1 && bb.me.videos === 1 && bb.me.views === 2000 && bb.me.earned === 200 && bb.me.joined === true && bb.me.owner === false,
    'моё место по выплате — первое', bb.me);
  ok(L[0].me === true && !L[1].me && !L[2].me, 'свою строку сервер отмечает сам (me), без номера аккаунта', L);
  const bE = (await board(G, 'brd', '&sort=views')).body;
  ok(bE.sort === 'views' && bE.leaders.map((r) => r.name).join('|') === 'Яна Игрек|Хасан Аш|Галя Г' && bE.me.rank === 3,
    '«по просмотрам»: Игрек, Аш, Г; моё место третье', bE.leaders);
  const P = bb.participants || [];
  ok(P.length === 3 && P.map((p) => p.name).join('|') === 'Галя Г|Хасан Аш|Яна Игрек'
    && P[0].joinedAt === jG.body.joinedAt && P.every((p) => p.videos === 1) && P[0].handle === '@blogerg'
    && P.map((p) => p.rank).join() === '1,2,3',
  'участники — больше видео выше, при равенстве кто раньше вступил; загрузка вписала в участники', P);
  ok(L.every((r) => r.uid === undefined) && P.every((p) => p.uid === undefined), 'номеров аккаунтов (uid) в строках нет', { L, P });
  ok(P[0].card === 'card-g-' + tag && L[0].card === 'card-g-' + tag && P[1].card === '' && P[2].card === '',
    'для «Профиль» и «Чат» — id открытой карточки из каталога (у кого она есть)', P);
  const rawB = bG.raw;
  ok(![G, H, Y, ADV].some((u) => rawB.includes(u.email)) && !/chan-|UC-[A-Z]/.test(rawB)
    && !/"(id|uid|userId|bloggerId|ownerId|email|external_id|externalId)"/.test(rawB)
    && ![G, H, Y].some((u) => new RegExp('[^0-9]' + u.id + '[,}]').test(rawB.replace(/"(views|videos|earned|rank|joinedAt|members|paid|reserved|budget|left|limit|offset)":\d+/g, ''))),
  'в ответе нет почты, номеров аккаунтов и внешних id каналов', rawB.slice(0, 300));
  const bO = (await board(ADV, 'brd')).body;
  ok(bO.leaders.every((r) => Number.isInteger(r.uid) && r.uid > 0) && bO.participants.map((p) => p.uid).join() === [G.id, H.id, Y.id].join(),
    'автору задания — номера участников (написать тем, у кого нет карточки)', bO.participants);
  const pg = await board(G, 'brd', '&offset=1&limit=1');
  ok(pg.body.participants.length === 1 && pg.body.participants[0].name === 'Хасан Аш' && pg.body.more === true, '«Показать ещё»: offset и limit', pg.body);
  const bA = await board(A, 'brd');
  ok(bA.status === 200 && bA.body.me.rank === null && bA.body.me.joined === false, 'посторонний видит лидерборд, своего места нет', bA.body.me);
  const bAdv = await board(ADV, 'brd');
  ok(bAdv.body.me.owner === true, 'автору задания — отметка owner');
  ok((await api('GET', '/api/tasks/board?campId=' + camps.brd)).status === 401, 'лидерборд без входа — 401');
  const rfBrd = await api('POST', '/api/deals/refund', { dealId: 'camp:' + camps.brd, opKey: 'rfb-' + tag }, ADV.token);
  ok(rfBrd.status === 409 && rfBrd.body.code === 'videos_live', 'завершить задание с видео на проверке нельзя', rfBrd.body);
  const lv = await api('POST', '/api/tasks/leave', { campId: camps.brd }, G.token);
  ok(lv.status === 200 && lv.body.left === true, 'Г вышел из задания', lv.body);
  const lv2 = await api('POST', '/api/tasks/leave', { campId: camps.brd }, G.token);
  ok(lv2.status === 200 && lv2.body.left === false, 'повторный выход — тихо ок', lv2.body);
  const bG2 = await board(G, 'brd');
  ok(bG2.body.members === 2 && bG2.body.me.joined === false && bG2.body.participants.every((p) => p.name !== 'Галя Г'),
    'после выхода: участников 2, меня в списке нет', bG2.body);
  const jG3 = await api('POST', '/api/tasks/join', { campId: camps.brd }, G.token);
  ok(jG3.status === 200 && jG3.body.already === false && (await board(G, 'brd')).body.members === 3, 'вернулся в задание тем же /join');

  /* ── Сервер с ключом YouTube API ── */
  console.log('\n— YouTube по ключу API');
  const ADVK = await regAt(BASEK, 'reklamak', 'advertiser');
  const K = await regAt(BASEK, 'blogerk', 'blogger');
  ok(await linkAt(BASEK, K, 'youtube', 'ycode-K'), 'Ка подтвердил YouTube (его доступ дальше не работает)');
  await apiAt(BASEK, 'POST', '/api/topup', { amount: 10000, opKey: 'topk-' + tag }, ADVK.token);
  ok(await campAt(BASEK, 'kc', Object.assign({}, base, { name: 'Ключ', platforms: 'youtube' }), 5000, ADVK), 'оффер на сервере с ключом');
  const accK = await apiAt(BASEK, 'GET', '/api/tasks/video/accounts', null, K.token);
  ok(accK.body.accounts && accK.body.accounts[0] && accK.body.accounts[0].ready === true, 'с ключом канал готов, даже если доступ протух', accK.body);
  const gk = gLog.length;
  const k1 = await bindAt(BASEK, K, 'kc', ylink(YT.K1), undefined, { platform: 'youtube', account: 'UC-K' });
  ok(k1.status === 200 && k1.body.video.views === 4000 && k1.body.video.reserved === 400, 'ролик загружен по ключу: 4000 просмотров, резерв 400', k1.body);
  ok(gLog.slice(gk).some((l) => l === 'VKEY ' + YT.K1) && !gLog.slice(gk).some((l) => l.startsWith('VTOK')), 'Google спрошен ключом, без доступа канала');
  const kNy = await bindAt(BASEK, K, 'kc', ylink(YT.Z1));
  ok(kNy.status === 409 && kNy.body.code === 'not_yours', 'по ключу чужой ролик — not_yours (channelId не совпал)', kNy.body);
  const kPriv = await bindAt(BASEK, K, 'kc', ylink(YT.K2));
  ok(kPriv.status === 404 && kPriv.body.code === 'not_found', 'закрытый ролик по ключу не виден — not_found', kPriv.body);
  YV.get(YT.K1).views = 6000;
  const kBal0 = (await bal(K)).available;
  const rk1 = await apiAt(BASEK, 'POST', '/api/tasks/video/review', { id: k1.body.video.id, ok: true }, ADVK.token);
  ok(rk1.body.settle === 'paid' && rk1.body.video.paid === 600 && (await bal(K)).available - kBal0 === 600,
    'зачёт по ключу: свежий замер 6000 → выплата 600', rk1.body);
  const gq0 = gLog.length;
  const many = [];
  for (let i = 0; i < 30; i++) many.push(await bindAt(BASEK, K, 'kc', ylink(YT.NONE)));
  const n404 = many.filter((r) => r.status === 404).length, n429 = many.filter((r) => r.status === 429).length;
  ok(n404 === 27 && n429 === 3 && many.slice(27).every((r) => r.body.code === 'often' && /за час/.test(r.body.error)),
    'YouTube: не больше 30 проверок в час на человека (с любого адреса)', { n404, n429, last: many[29].body });
  ok(gLog.slice(gq0).filter((l) => l === 'VKEY ' + YT.NONE).length === 1, 'одна и та же ссылка — один запрос к Google за 3 минуты (кэш)', gLog.slice(gq0));
} catch (e) {
  failed++;
  console.log('  FAIL неожиданная ошибка: ' + ((e && e.stack) || e));
} finally {
  stop();
}

console.log('\nИтого: ' + passed + ' ok, ' + failed + ' FAIL');
process.exit(failed ? 1 : 0);
