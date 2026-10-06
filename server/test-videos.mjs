/* «Привязать видео» (контракт — server/VIDEO-SPEC.md, п. 8).

   Блогер привязывает ролик со своего подтверждённого TikTok, сервер сам
   берёт цифры у площадки, рекламодатель проверяет интеграцию, владелец
   решает спорное, в конце окна сервер платит из заморозки кампании.

   Настоящий TikTok не нужен: поднимаем поддельный (8111) и подставляем его
   в TT_API_BASE / TT_AUTH_BASE / TT_WEB_BASE. Он, как и настоящий, по
   video/query отдаёт ТОЛЬКО ролики владельца токена — на этом держится
   проверка «ролик ваш». id роликов — 19 цифр и уходят из подделки ЧИСЛОМ:
   так проверяем, что сервер не округляет их до соседнего ролика.

   Канал блогеру подтверждаем тем же путём, что и в жизни: start →
   возврат с площадки → confirm по пропуску (как в test-return.mjs).

   Окно подсчёта VID_WINDOW_DAYS=0: зачёт сразу закрывает окно, и
   следующий круг делает финальный замер и платит.

   TRUST_PROXY=1 и свой X-Forwarded-For на каждый запрос — иначе запросы
   с петли не ограничиваются вовсе, и лимит 429 не проверить.

   Запуск: node test-videos.mjs (свой сервер поднимает сам). */

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = 8110;
const FAKE = 8111;
const BASE = 'http://127.0.0.1:' + PORT;
const TT = 'http://127.0.0.1:' + FAKE;
const KEY = 'video-test-admin-key';   /* в заголовке — только латиница */

let passed = 0, failed = 0;
function ok(c, name, extra) {
  if (c) { passed++; console.log('  ok  ' + name); }
  else { failed++; console.log('  FAIL ' + name + (extra !== undefined ? '  ← ' + JSON.stringify(extra).slice(0, 300) : '')); }
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
  /* D — для проверок после аудита (условия, резерв, накрутка, гонка). */
  'code-D': { open_id: 'chan-D', username: 'blogerd', name: 'Блогер Д', followers: 1000, access: 'tok-D', refresh: 'ref-D', expires: 86400 },
  /* E — у него доступ к TikTok потом умрёт (поздний путь выплаты). */
  'code-E': { open_id: 'chan-E', username: 'blogere', name: 'Блогер Е', followers: 1000, access: 'tok-E', refresh: 'ref-E', expires: 86400 },
};
const TOKENS = { 'tok-A1': 'chan-A', 'tok-A2': 'chan-A', 'tok-B': 'chan-B', 'tok-S': 'chan-S', 'tok-X': 'chan-X',
  'tok-D': 'chan-D', 'tok-E': 'chan-E' };
const REFRESH = { 'ref-A': { access_token: 'tok-A2', refresh_token: 'ref-A', expires_in: 86400 } };
const accByOpen = (o) => Object.values(ACC).find((a) => a.open_id === o);

const ID = {
  A1: '7412345678901234561', A2: '7412345678901234562', A3: '7412345678901234563',
  A4: '7412345678901234564', A5: '7412345678901234565', AOLD: '7412345678901234566',
  ASHORT: '7412345678901234567',
  B1: '7412345678901234571', B2: '7412345678901234572', B3: '7412345678901234573', B4: '7412345678901234574',
  BOOM: '7999999999999999999', NONE: '7400000000000000999',
  A6: '7412345678901234568',
  D1: '7412345678901234581', D2: '7412345678901234582', D3: '7412345678901234583', D4: '7412345678901234584',
  D6: '7412345678901234586', D7: '7412345678901234587',
  E1: '7412345678901234591', E2: '7412345678901234592', E3: '7412345678901234593',
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
/* Обычные старые ролики Б — из них сервер считает базу канала. */
for (let i = 0; i < 6; i++) {
  vid('74000000000000001' + i + '0', 'chan-B', { create_time: nowS() - (40 + i) * 86400, views: 450 + i * 20, likes: 45, comments: 3, shares: 1 });
  vid('74000000000000002' + i + '0', 'chan-D', { create_time: nowS() - (40 + i) * 86400, views: 450 + i * 20, likes: 45, comments: 3, shares: 1 });
}
vid(ID.A6, 'chan-A');
vid(ID.D1, 'chan-D', { views: 5000, likes: 500 });
vid(ID.D2, 'chan-D', { views: 3000, likes: 300 });
vid(ID.D3, 'chan-D', { views: 100000, likes: 100, comments: 0, shares: 0 });
vid(ID.D4, 'chan-D');
vid(ID.D6, 'chan-D');
vid(ID.D7, 'chan-D');
vid(ID.E1, 'chan-E');
vid(ID.E2, 'chan-E');
vid(ID.E3, 'chan-E');
/* Ролики, на которых площадка «задумывается» — для проверки гонки. */
const SLOW = new Set();

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
      if (ids.includes(ID.BOOM)) { res.statusCode = 500; res.setHeader('Content-Type', 'text/plain'); res.end('упали'); return; }
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

/* ── Наш сервер ────────────────────────────────────────────────────── */
const dir = mkdtempSync(path.join(tmpdir(), 'bp-vid-'));
const DBP = path.join(dir, 'db.sqlite');
const srv = spawn(process.execPath, ['server.js'], {
  cwd: fileURLToPath(new URL('.', import.meta.url)),
  env: {
    ...process.env,
    PORT: String(PORT), DB_PATH: DBP,
    ADMIN_KEY: KEY, ADMIN_EMAIL: '', PUBLIC_URL: BASE, APP_URL: 'http://127.0.0.1:9999/app',
    TT_CLIENT_KEY: 'ключ', TT_CLIENT_SECRET: 'секрет', TT_SCOPE: 'user.info.basic,video.list',
    TT_AUTH_BASE: TT, TT_API_BASE: TT, TT_WEB_BASE: TT,
    VID_WINDOW_DAYS: '0', TRUST_PROXY: '1',
    /* Бот есть (личные сообщения людям уходят в подделку), а тревоги
       владельцу выключены: у них часовой потолок, он сбил бы счёт. */
    BOT_TOKEN: '111:VIDTEST', TG_API_BASE: TT, ADMIN_CHAT_ID: '', RESEND_API_KEY: '', VID_AUTO_ACCEPT_H: '',
    TEST_TOPUP: '1', TEST_TOPUP_OPEN: '1', YOOKASSA_SHOP_ID: '', YOOKASSA_SECRET_KEY: '',
  },
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
  try { if (fake.closeAllConnections) fake.closeAllConnections(); fake.close(); } catch (e) { /* закрыт */ }
  try { if (dbw) dbw.close(); } catch (e) { /* закрыта */ }
}

let ipSeq = 1;
const freshIp = () => '10.' + ((ipSeq >> 16) & 255) + '.' + ((ipSeq >> 8) & 255) + '.' + (ipSeq++ & 255);
async function api(method, p, body, token, extra) {
  const headers = { 'Content-Type': 'application/json', 'X-Forwarded-For': (extra && extra.ip) || freshIp() };
  if (token) headers.Authorization = 'Bearer ' + token;
  if (extra && extra.admin) headers['X-Admin-Key'] = KEY;
  const r = await fetch(BASE + p, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const txt = await r.text();
  let j = {}; try { j = JSON.parse(txt); } catch (e) { j = { _text: txt.slice(0, 200) }; }
  return { status: r.status, body: j, headers: r.headers };
}
const adm = (method, p, body) => api(method, p, body, null, { admin: true });
async function waitUp() {
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(BASE + '/api/health'); await r.text(); if (r.ok) return true; } catch (e) { /* ещё нет */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tag = Date.now().toString(36);

let tgSeq = 7000;
async function reg(name, role) {
  const r = await api('POST', '/api/register', { email: name + '.' + tag + '@t.ru', name, role, password: 'пароль-подлиннее' });
  const u = { token: r.body.token, id: r.body.user && r.body.user.id, email: name + '.' + tag + '@t.ru', tg: String(++tgSeq) };
  /* Пришёл «из Телеграма»: бот может писать ему лично. */
  if (u.id) dbx().prepare('UPDATE users SET tg_id = ? WHERE id = ?').run(u.tg, u.id);
  return u;
}
/* Подтверждение TikTok — как в жизни: start → возврат площадки → confirm. */
async function linkTikTok(user, code) {
  const st = await api('GET', '/api/verify/start?platform=tiktok', null, user.token);
  const back = await fetch(BASE + '/api/verify/callback/tiktok?code=' + code + '&state=' + st.body.nonce, { redirect: 'manual' });
  await back.text();
  const claim = new URL(back.headers.get('location') || '/', BASE).searchParams.get('claim') || '';
  const c = await api('POST', '/api/verify/confirm', { nonce: st.body.nonce, claim }, user.token);
  return c.status === 200 && c.body.ok;
}
const camps = {};
async function camp(key, data, escrow, adv) {
  const rid = 'vc' + tag + key;
  camps[key] = rid;
  const put = await api('POST', '/api/sync/put', { kind: 'camp', rid, data: Object.assign({ id: rid }, data) }, adv.token);
  let held = true;
  if (escrow) {
    const h = await api('POST', '/api/deals/hold', { dealId: 'camp:' + rid, amount: escrow, opKey: 'hold-' + rid }, adv.token);
    held = h.status === 200;
  }
  return put.status === 200 && held;
}
const link = (handle, id) => 'https://www.tiktok.com/@' + handle + '/video/' + id;
const bind = (u, campKey, url, agree = true, extra) =>
  api('POST', '/api/tasks/video/bind', { campId: camps[campKey] || campKey, url, agree }, u.token, extra);
const getVid = (id, token, extra) => api('GET', '/api/tasks/video?id=' + id, null, token, extra);
const bal = async (u) => (await api('GET', '/api/balance', null, u.token)).body;
const sync = () => adm('POST', '/api/admin/task-videos/sync', { force: true });

try {
  await new Promise((r) => fake.listen(FAKE, '127.0.0.1', r));
  if (!await waitUp()) { console.log('сервер не поднялся'); stop(); process.exit(1); }
  console.log('\n«Привязать видео»: привязка, проверка, решение владельца, круг и выплата\n');

  /* ── Люди, каналы, оферы ── */
  const ADV = await reg('reklama', 'advertiser');
  const A = await reg('blogera', 'blogger');
  const B = await reg('blogerb', 'blogger');
  const C = await reg('blogerc', 'blogger');
  const S = await reg('blogers', 'blogger');
  const X = await reg('blogerx', 'blogger');
  ok([ADV, A, B, C, S, X].every((u) => u.token), 'шесть аккаунтов заведены');
  ok(await linkTikTok(A, 'code-A'), 'А подтвердил TikTok обычным путём');
  ok(await linkTikTok(B, 'code-B'), 'Б подтвердил TikTok');
  ok(await linkTikTok(S, 'code-S'), 'С подтвердил TikTok (без права на ролики)');
  ok(await linkTikTok(X, 'code-X'), 'Икс подтвердил TikTok (доступ протухнет)');
  const D = await reg('blogerd', 'blogger');
  const E = await reg('blogere', 'blogger');
  ok(await linkTikTok(D, 'code-D'), 'Д подтвердил TikTok');
  ok(await linkTikTok(E, 'code-E'), 'Е подтвердил TikTok');
  await sleep(600);          /* первый разбор канала идёт в стороне */

  const top = await api('POST', '/api/topup', { amount: 100000, opKey: 'topup-' + tag }, ADV.token);
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
  ok(await camp('terms', Object.assign({}, base, { name: 'Условия' }), 5000, ADV), 'оффер для снимка условий');
  ok(await camp('resv', Object.assign({}, base, { name: 'Резерв', maxPayout: 800 }), 1000, ADV), 'оффер для резерва бюджета');
  ok(await camp('nl1', Object.assign({}, base, { name: 'Списки 1', platforms: 'yt', platformsList: ['tiktok'] }), 100, ADV), 'оффер: TikTok только в platformsList');
  ok(await camp('nl2', Object.assign({}, base, { name: 'Списки 2', platforms: [], platformsList: { tt: true, yt: false } }), 100, ADV), 'оффер: platformsList объектом');
  ok(await camp('nl3', Object.assign({}, base, { name: 'Списки 3', platforms: '', platformsList: ['yt'] }), 100, ADV), 'оффер: в platformsList только YouTube');

  /* ── Ошибки привязки ── */
  console.log('\n— ошибки привязки');
  const e401 = await api('POST', '/api/tasks/video/bind', { campId: camps.main, url: link('blogera', ID.A1), agree: true });
  ok(e401.status === 401, '401 без входа', e401.body);
  const yt = await bind(A, 'main', 'https://youtube.com/watch?v=1');
  ok(yt.status === 400 && yt.body.code === 'bad_url' && yt.body.error === 'Это не ссылка на видео TikTok', 'bad_url: ссылка не на TikTok', yt.body);
  const prof = await bind(A, 'main', 'https://www.tiktok.com/@blogera');
  ok(prof.status === 400 && prof.body.code === 'bad_url', 'bad_url: ссылка на профиль, а не на ролик', prof.body);
  const plain = await bind(A, 'main', 'http://www.tiktok.com/@blogera/video/' + ID.A1);
  ok(plain.status === 400 && plain.body.code === 'bad_url', 'bad_url: только https', plain.body);
  const ag = await bind(A, 'main', link('blogera', ID.A1), false);
  ok(ag.status === 400 && ag.body.code === 'agree' && /реклама из задания/.test(ag.body.error), 'agree: без галочки нельзя', ag.body);
  const nc = await bind(A, 'нет-такого', link('blogera', ID.A1));
  ok(nc.status === 404 && nc.body.code === 'no_camp' && nc.body.error === 'Задание не найдено', 'no_camp', nc.body);
  const cl = await bind(A, 'paused', link('blogera', ID.A1));
  ok(cl.status === 409 && cl.body.code === 'camp_closed', 'camp_closed: оффер на паузе', cl.body);
  const ne = await bind(A, 'noesc', link('blogera', ID.A1));
  ok(ne.status === 409 && ne.body.code === 'camp_closed', 'camp_closed: у оффера нет заморозки — платить не из чего', ne.body);
  const own = await bind(ADV, 'main', link('blogera', ID.A1));
  ok(own.status === 409 && own.body.code === 'own_camp' && own.body.error === 'Это ваше задание', 'own_camp', own.body);
  const ntt = await bind(A, 'yt', link('blogera', ID.A1));
  ok(ntt.status === 409 && ntt.body.code === 'not_tiktok', 'not_tiktok', ntt.body);
  const nch = await bind(C, 'main', link('blogera', ID.A1));
  ok(nch.status === 409 && nch.body.code === 'no_channel' && /подтвердите свой TikTok/.test(nch.body.error), 'no_channel', nch.body);
  const tok = await bind(X, 'main', link('blogerx', ID.A1));
  ok(tok.status === 409 && tok.body.code === 'token' && /переподключите/.test(tok.body.error), 'token: доступ протух и не обновился', tok.body);
  const sc = await bind(S, 'main', link('blogers', ID.A1));
  ok(sc.status === 409 && sc.body.code === 'scope' && /разрешите доступ к роликам/.test(sc.body.error), 'scope: нет права на ролики', sc.body);
  const home = await bind(A, 'main', TT + '/t/home/');
  ok(home.status === 404 && home.body.code === 'not_found', 'not_found: короткая ссылка ведёт на главную', home.body);
  const evil = await bind(A, 'main', TT + '/t/evil/');
  ok(evil.status === 404 && evil.body.code === 'not_found', 'короткая ссылка наружу TikTok не раскрывается', evil.body);
  const none = await bind(A, 'main', link('blogera', ID.NONE));
  ok(none.status === 404 && none.body.code === 'not_found' && none.body.error === 'Видео не найдено — проверьте ссылку',
    'not_found: такого ролика нет (oEmbed 400)', none.body);
  const ny = await bind(A, 'main', link('blogerb', ID.B1));
  ok(ny.status === 409 && ny.body.code === 'not_yours', 'not_yours: чужой ролик', ny.body);
  const old = await bind(A, 'main', link('blogera', ID.AOLD));
  ok(old.status === 409 && old.body.code === 'too_old', 'too_old: снят раньше оффера', old.body);
  const sh = await bind(A, 'short', link('blogera', ID.ASHORT));
  ok(sh.status === 409 && sh.body.code === 'too_short' && sh.body.error === 'Видео короче 30 сек — так в условиях задания',
    'too_short: текст с числом секунд', sh.body);
  const boom = await bind(A, 'main', link('blogera', ID.BOOM));
  ok(boom.status === 502 && boom.body.code === 'tiktok', 'tiktok: площадка упала — 502', boom.body);
  const ip = '10.200.0.1';
  let last = null;
  for (let i = 0; i < 11; i++) last = await bind(C, 'main', 'не ссылка', true, { ip });
  ok(last.status === 429, '429: больше 10 попыток в минуту', last.body);

  /* ── Удачная привязка ── */
  console.log('\n— привязка');
  const okA1 = await bind(A, 'main', 'Смотри мой ролик! ' + TT + '/t/okA1/');
  const vA1 = okA1.body.video || {};
  ok(okA1.status === 200 && okA1.body.ok && vA1.status === 'review', 'короткая ссылка раскрыта, ролик привязан, ждёт проверки', okA1.body);
  ok(vA1.videoId === ID.A1, 'id ролика — строка, все 19 цифр целы', vA1.videoId);
  ok(vA1.views === 1500 && vA1.likes === 150 && vA1.comments === 10 && vA1.shares === 5, 'цифры взяты с площадки', vA1);
  ok(vA1.platform === 'tiktok' && vA1.player === 'https://www.tiktok.com/player/v1/' + ID.A1, 'платформа и плеер', vA1);
  ok(vA1.url === 'https://www.tiktok.com/@blogera/video/' + ID.A1 && vA1.handle === 'blogera', 'постоянная ссылка без меток', vA1.url);
  ok(vA1.campId === camps.main && vA1.bloggerId === A.id && vA1.ownerId === ADV.id, 'оффер, блогер и автор записаны', vA1);
  ok(vA1.windowEndsAt === null && vA1.earned === 0, 'окно ещё не началось', vA1);
  ok(vA1.risk === null && Array.isArray(vA1.riskWhy) && vA1.riskWhy.length === 0 && vA1.riskLevel === 'ok',
    'блогеру — только уровень оценки, без причин', vA1);
  ok(typeof vA1.cover === 'string' && vA1.cover.includes(ID.A1), 'обложка из ответа площадки', vA1.cover);
  ok(fakeLog.includes('REFRESH ref-A'), 'протухший доступ А обменян по refresh');
  const again = await bind(A, 'main', link('blogera', ID.A1) + '?is_from_webapp=1');
  ok(again.status === 409 && again.body.code === 'taken', 'taken: тот же ролик второй раз', again.body);
  const againOther = await bind(A, 'short', link('blogera', ID.A1));
  ok(againOther.status === 409 && againOther.body.code === 'taken', 'taken: тот же ролик в другое задание', againOther.body);
  const steal = await bind(B, 'main', link('blogera', ID.A1));
  ok(steal.status === 409 && steal.body.code === 'not_yours', 'чужой уже привязанный ролик — «не ваш»', steal.body);
  const okB1 = await bind(B, 'main', TT + '/t/hop1/');
  const vB1 = okB1.body.video || {};
  ok(okB1.status === 200 && vB1.videoId === ID.B1, 'короткая ссылка в два шага', okB1.body);

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
  ok(aAll.status === 200 && aAll.body.videos.length === 1 && aAll.body.videos[0].id === vA1.id, 'без campId — мои ролики', aAll.body);
  const advAll = await api('GET', '/api/tasks/videos', null, ADV.token);
  ok(advAll.body.videos && advAll.body.videos.length === 2, 'без campId автору — ролики по его офферам', advAll.body);
  const noAuth = await api('GET', '/api/tasks/videos');
  ok(noAuth.status === 401, 'список без входа закрыт');
  const one = await getVid(vA1.id, A.token);
  ok(one.status === 200 && Array.isArray(one.body.video.history) && one.body.video.history.length === 1
    && one.body.video.history[0].day === new Date().toISOString().slice(0, 10) && one.body.video.history[0].views === 1500,
    'снимок дня записан при привязке', one.body.video && one.body.video.history);
  const asAdmin = await api('GET', '/api/tasks/video?id=' + vA1.id, null, null, { admin: true });
  ok(asAdmin.status === 200 && asAdmin.body.video.riskWhy.length > 0, 'владелец площадки видит ролик по ключу', asAdmin.body);

  /* ── Проверка рекламодателем ── */
  console.log('\n— проверка интеграции');
  const selfRev = await api('POST', '/api/tasks/video/review', { id: vA1.id, ok: true }, A.token);
  ok(selfRev.status === 403, 'блогер сам себе не засчитывает', selfRev.body);
  const strRev = await api('POST', '/api/tasks/video/review', { id: vA1.id, ok: true }, B.token);
  ok(strRev.status === 404, 'посторонний не проверяет чужое', strRev.body);
  const rev = await api('POST', '/api/tasks/video/review', { id: vA1.id, ok: true }, ADV.token);
  const rv = rev.body.video || {};
  ok(rev.status === 200 && rv.status === 'active' && rv.approvedAt > 0, '«всё верно» → засчитано', rev.body);
  ok(rv.windowEndsAt === rv.approvedAt, 'окно = approvedAt + VID_WINDOW_DAYS (0 в проверке)', rv);
  ok(rv.earned === 150, 'сумма по ставке: 1500 × 100 / 1000 = 150', rv.earned);
  const rev2 = await api('POST', '/api/tasks/video/review', { id: vA1.id, ok: false, reason: 'передумал совсем' }, ADV.token);
  ok(rev2.status === 409, 'второй раз не проверить', rev2.body);
  const shortReason = await api('POST', '/api/tasks/video/review', { id: vB1.id, ok: false, reason: 'abc' }, ADV.token);
  ok(shortReason.status === 400 && shortReason.body.code === 'reason', 'причина короче 5 символов отклонена', shortReason.body);
  const noOk = await api('POST', '/api/tasks/video/review', { id: vB1.id }, ADV.token);
  ok(noOk.status === 400, 'без ok — 400', noOk.body);
  const rej = await api('POST', '/api/tasks/video/review', { id: vB1.id, ok: false, reason: 'В ролике нет упоминания бренда' }, ADV.token);
  ok(rej.status === 200 && rej.body.video.status === 'rejected' && rej.body.video.reviewNote === 'В ролике нет упоминания бренда',
    '«есть проблема» → rejected с причиной', rej.body);

  /* ── Отвязка ── */
  console.log('\n— отвязка');
  const b2 = await bind(A, 'main', link('blogera', ID.A2));
  const vA2 = b2.body.video || {};
  ok(b2.status === 200, 'А привязал второй ролик', b2.body);
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
  ok(ub4.status === 409, 'засчитанный ролик не отвязать', ub4.body);

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
  const b3 = await bind(A, 'main', link('blogera', ID.A3));
  await api('POST', '/api/tasks/video/review', { id: b3.body.video.id, ok: false, reason: 'Не та интеграция' }, ADV.token);
  const notAdm = await api('POST', '/api/admin/task-videos/decide', { id: b3.body.video.id, decision: 'decline' }, A.token);
  ok(notAdm.status === 403, 'решать может только владелец площадки', notAdm.body);
  const badDec = await adm('POST', '/api/admin/task-videos/decide', { id: b3.body.video.id, decision: 'maybe' });
  ok(badDec.status === 400, 'неизвестное решение — 400', badDec.body);
  const dec = await adm('POST', '/api/admin/task-videos/decide', { id: b3.body.video.id, decision: 'decline', note: 'Реклама не по ТЗ' });
  ok(dec.status === 200 && dec.body.video.status === 'declined' && dec.body.video.decision === 'decline'
    && dec.body.video.decisionNote === 'Реклама не по ТЗ' && dec.body.video.decidedAt > 0, '«не засчитывать» → declined', dec.body);
  const dec2 = await adm('POST', '/api/admin/task-videos/decide', { id: b3.body.video.id, decision: 'count' });
  ok(dec2.status === 409, 'по закрытому ролику решение не нужно', dec2.body);
  const cnt = await adm('POST', '/api/admin/task-videos/decide', { id: vB1.id, decision: 'count', note: 'Бренд есть на 0:12' });
  ok(cnt.status === 200 && cnt.body.video.status === 'active' && cnt.body.video.approvedAt > 0 && cnt.body.video.decision === 'count',
    '«засчитать» возвращённый → active', cnt.body);
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
  await api('POST', '/api/tasks/video/review', { id: vB2.id, ok: true }, ADV.token);

  /* Спор держит выплату так же, как и накрутка. Спор — по выплатам А из
     ДРУГОГО оффера: он держит все выплаты А по этой заморозке. */
  const b5 = await bind(A, 'short', link('blogera', ID.A5));
  const vA5 = b5.body.video || {};
  await api('POST', '/api/tasks/video/review', { id: vA5.id, ok: true }, ADV.token);
  const dsp = await api('POST', '/api/deals/dispute/open', { dealId: 'camp:' + camps.short, payeeId: A.id }, ADV.token);
  ok(dsp.status === 200, 'рекламодатель открыл спор по выплате А', dsp.body);

  /* Фикс-оффер с заморозкой меньше цены. */
  const bf = await bind(B, 'fix', link('blogerb', ID.B3));
  ok(bf.status === 200, 'Б привязал ролик к фикс-офферу', bf.body);
  await api('POST', '/api/tasks/video/review', { id: bf.body.video.id, ok: true }, ADV.token);

  /* Ролик, который исчезнет. */
  const b4 = await bind(A, 'main', link('blogera', ID.A4));
  const vA4 = b4.body.video || {};
  ok(b4.status === 200, 'А привязал ролик, который потом удалит', b4.body);

  /* ── Круг обновления и выплата ── */
  console.log('\n— круг и выплата');
  Object.assign(V.get(ID.A1), { views: 20000, likes: 2000, comments: 50, shares: 20 });
  Object.assign(V.get(ID.B1), { views: 5000, likes: 500 });
  V.delete(ID.A4);
  const a0 = await bal(A), b0 = await bal(B), adv0 = await bal(ADV);
  const noKeySync = await api('POST', '/api/admin/task-videos/sync', { force: true }, A.token);
  ok(noKeySync.status === 403, 'круг по кнопке — только владельцу');
  const r1 = await sync();
  ok(r1.status === 200 && r1.body.ok, 'круг прошёл', r1.body);
  const pA1 = (await getVid(vA1.id, A.token)).body.video;
  ok(pA1.views === 20000 && pA1.likes === 2000, 'цифры обновлены', pA1);
  ok(pA1.history.length === 1 && pA1.history[0].views === 20000, 'снимок дня перезаписан, а не задвоен', pA1.history);
  ok(pA1.status === 'paid' && pA1.paid === 2000 && pA1.earned === 2000 && pA1.paidAt > 0,
    'окно кончилось — выплачено по финальному замеру: 20 000 × 100 / 1000 = 2000', pA1);
  const pB1 = (await getVid(vB1.id, B.token)).body.video;
  ok(pB1.status === 'paid' && pB1.paid === 500, 'ролик, засчитанный владельцем, оплачен: 500', pB1);
  const pFix = (await getVid(bf.body.video.id, B.token)).body.video;
  ok(pFix.status === 'active' && pFix.paid === 500 && pFix.earned === 800 && pFix.payHold === true && pFix.holdReason === '',
    'A/B: заработано 800 ₽ (не срезано заморозкой), выплачено 500 ₽, остаток на паузе; блогеру без причины', pFix);
  const pFixAdv = (await getVid(bf.body.video.id, ADV.token)).body.video;
  ok(pFixAdv.holdReason === 'В заморозке кампании не хватило денег: недоплачено 300 ₽', 'B: рекламодателю — причина паузы', pFixAdv.holdReason);
  await sleep(300);
  const fixDm = dmsTo(B, /Выплата за видео/).map((m) => m.text).join('\n');
  ok(/заработано 800 ₽, начислено 500 ₽/.test(fixDm) && /Остальные 300 ₽ задерживается/.test(fixDm) && !/выплаты нет/.test(fixDm),
    'B: блогеру правда — сколько заработал, сколько начислено, что остаток задерживается', fixDm);
  const qFix = await adm('GET', '/api/admin/task-videos?status=queue');
  ok((qFix.body.videos || []).some((v) => v.id === bf.body.video.id && v.payHold && /недоплачено 300/.test(v.holdReason)),
    'B: недоплата — в очереди владельца', qFix.body.videos && qFix.body.videos.map((v) => v.id));
  const pB2 = (await getVid(vB2.id, B.token)).body.video;
  ok(pB2.status === 'active' && pB2.paid === 0 && pB2.riskHold === true, 'накрутка держит выплату', pB2);
  const pA5 = (await getVid(vA5.id, A.token)).body.video;
  ok(pA5.status === 'active' && pA5.paid === 0, 'спор держит выплату', pA5);
  ok(pA5.disputeHeld === true && vA1.disputeHeld === false, 'M: disputeHeld виден блогеру', pA5);
  const qDsp = await adm('GET', '/api/admin/task-videos?status=queue');
  ok((qDsp.body.videos || []).some((v) => v.id === vA5.id && v.disputeHeld === true), 'M: выплата, которую держит спор, — в очереди владельца');
  const ovD = await adm('GET', '/api/admin/overview');
  ok(ovD.body['видео_на_решении'] === (qDsp.body.videos || []).length, 'M: значок совпадает с очередью',
    { badge: ovD.body['видео_на_решении'], queue: (qDsp.body.videos || []).length });
  const pA4 = (await getVid(vA4.id, A.token)).body.video;
  ok(pA4.status === 'review', 'пропал один раз — ещё не удалён', pA4);
  const a1 = await bal(A), b1 = await bal(B), adv1 = await bal(ADV);
  ok(a1.available - a0.available === 2000, 'А получил 2000 на свободный баланс', { a0, a1 });
  ok(b1.available - b0.available === 1000, 'Б получил 500 + 500', { b0, b1 });
  ok(adv0.hold - adv1.hold === 3000 && adv1.available === adv0.available, 'у рекламодателя ушло 3000 из заморозки, свободные не тронуты', { adv0, adv1 });
  const ops = await api('GET', '/api/ops/mine', null, ADV.token);
  const vop = (ops.body.rows || []).find((r) => r.opKey === 'sys:vidpay:' + vA1.id);
  ok(vop && vop.paid === 2000 && vop.to === A.id && vop.dealId === 'camp:' + camps.main,
    'выплата видна рекламодателю как обычная выплата из кампании', ops.body.rows);
  const led = await api('GET', '/api/ledger', null, A.token);
  ok((led.body.rows || []).filter((r) => r.kind === 'payout' && r.ref === 'camp:' + camps.main).length === 1,
    'в журнале А одна выплата по кампании', led.body.rows);

  const qMark = fakeLog.length;
  const r2 = await sync();
  ok(r2.status === 200, 'второй круг прошёл', r2.body);
  ok(!fakeLog.slice(qMark).some((l) => l.startsWith('Q ') && l.includes(ID.A5)),
    'H: ролик с финальным замером (ждёт спор) больше не опрашивается', fakeLog.slice(qMark));
  const kA4 = (await getVid(vA4.id, A.token)).body.video;
  ok(kA4.status === 'review' && row(vA4.id).miss === 1, 'K: второй промах через полчаса не считается', kA4);
  setRow(vA4.id, { last_miss_at: Date.now() - 21 * 3600e3 });
  await sync();
  const gA4 = (await getVid(vA4.id, A.token)).body.video;
  ok(gA4.status === 'removed', 'пропал дважды с промежутком в сутки — removed', gA4);
  const a2 = await bal(A), b2b = await bal(B), adv2 = await bal(ADV);
  ok(a2.available === a1.available && b2b.available === b1.available && adv2.hold === adv1.hold,
    'повтор круга не платит второй раз', { a1, a2, b1, b2b });

  const forged = await api('POST', '/api/deals/release',
    { dealId: 'camp:' + camps.main, toUserId: A.id, amount: 1, opKey: 'sys:vidpay:999999' }, ADV.token);
  ok(forged.status === 400, 'ключ sys:vidpay:* из приложения не занять', forged.body);
  const rfMain = await api('POST', '/api/deals/refund', { dealId: 'camp:' + camps.main, opKey: 'refund-main-' + tag }, ADV.token);
  ok(rfMain.status === 409 && rfMain.body.code === 'videos_live'
    && rfMain.body.error === 'По офферу есть видео на проверке или в подсчёте — вернуть бюджет можно после выплат по ним',
  'B: бюджет оффера с живыми видео не вернуть', rfMain.body);

  /* Владелец снял подозрение — выплата сразу. */
  const free = await adm('POST', '/api/admin/task-videos/decide', { id: vB2.id, decision: 'count', note: 'Проверил вручную' });
  ok(free.status === 200 && free.body.video.riskHold === false, '«засчитать» снимает паузу', free.body);
  ok(free.body.settle === 'paid' && free.body.video.status === 'paid' && free.body.video.paid === 3000,
    'и платит сразу: 100 000 просмотров упёрлись в потолок 3000', free.body.video);
  const r3 = await sync();
  const b3b = await bal(B);
  ok(r3.status === 200 && b3b.available - b1.available === 3000, 'Б получил 3000 ровно один раз', { b1, b3b });
  const stillB2 = (await getVid(vB2.id, B.token)).body.video;
  ok(stillB2.riskHold === false && stillB2.status === 'paid', 'после решения ролик сам себя не замораживает', stillB2);

  /* Спор снят — следующий круг платит. */
  const cls = await api('POST', '/api/deals/dispute/close', { dealId: 'camp:' + camps.short, payeeId: A.id }, ADV.token);
  ok(cls.status === 200 && cls.body.closed === 1, 'спор снят', cls.body);
  await sync();
  const pA5b = (await getVid(vA5.id, A.token)).body.video;
  ok(pA5b.status === 'paid' && pA5b.paid === 400, 'после спора ролик оплачен: 4000 × 100 / 1000 = 400', pA5b);

  /* ── Отвязка канала ── */
  console.log('\n— отзыв канала');
  const bb4 = await bind(B, 'main', link('blogerb', ID.B4));
  ok(bb4.status === 200, 'Б привязал ещё ролик', bb4.body);
  const unl = await api('POST', '/api/verify/unlink', { platform: 'tiktok', externalId: 'chan-B' }, B.token);
  ok(unl.status === 200, 'Б отвязал свой TikTok', unl.body);
  const rB4 = (await getVid(bb4.body.video.id, B.token)).body.video;
  ok(rB4.status === 'revoked', 'ролик с отвязанного канала → revoked', rB4);
  const keepB1 = (await getVid(vB1.id, B.token)).body.video;
  ok(keepB1.status === 'paid', 'оплаченные ролики отзыв не трогает', keepB1);
  const keepFix = (await getVid(bf.body.video.id, B.token)).body.video;
  ok(keepFix.status === 'active' && keepFix.paid === 500, 'E: засчитанный ролик (active) отвязка канала не снимает', keepFix);
  await sleep(300);
  ok(dmsTo(B, /Видео снято с проверки/).some((m) => /вы отключили TikTok-канал/.test(m.text) && /выплаты по нему не будет/.test(m.text)),
    'E: блогеру честно — снято, потому что он отключил канал', dmsTo(B).map((m) => m.text));
  ok(dmsTo(ADV, /Видео снято с проверки/).length >= 1, 'E: рекламодателю — что проверять не нужно');
  /* Владелец всё же засчитал снятый ролик: active, цифры заморожены,
     окно 0 — выплата сразу по тем цифрам, что были. */
  const bBefore = await bal(B);
  const cRev = await adm('POST', '/api/admin/task-videos/decide', { id: bb4.body.video.id, decision: 'count', note: 'Проверил сам' });
  ok(cRev.status === 200 && cRev.body.video.approvedAt > 0 && cRev.body.settle === 'paid' && cRev.body.video.paid === 100,
    'E: «засчитать» снятый ролик → active и оплата по замороженным цифрам (1000 × 100 / 1000)', cRev.body);
  ok(row(bb4.body.video.id).frozen === 1, 'E: ролик помечен замороженным');
  ok((await bal(B)).available - bBefore.available === 100, 'E: Б получил 100');
  const after = await bind(B, 'main', link('blogerb', ID.B4));
  ok(after.status === 409 && after.body.code === 'no_channel', 'без канала новых привязок нет', after.body);
  const rfPaid = await api('POST', '/api/tasks/video/refresh', { id: vA1.id }, A.token);
  ok(rfPaid.status === 409, 'оплаченный ролик больше не обновляется', rfPaid.body);

  /* ── N: площадки оффера в platformsList ── */
  console.log('\n— площадки оффера');
  const n1 = await bind(C, 'nl1', link('blogera', ID.A6));
  ok(n1.status === 409 && n1.body.code === 'no_channel', 'N: TikTok только в platformsList — оффер принимает TikTok', n1.body);
  const n2 = await bind(C, 'nl2', link('blogera', ID.A6));
  ok(n2.status === 409 && n2.body.code === 'no_channel', 'N: platformsList объектом {tt:true}', n2.body);
  const n3 = await bind(C, 'nl3', link('blogera', ID.A6));
  ok(n3.status === 409 && n3.body.code === 'not_tiktok', 'N: в platformsList только YouTube — not_tiktok', n3.body);

  /* ── J: отвязка и повторная привязка ── */
  console.log('\n— отвязка и повтор');
  await sleep(300);
  const advNew0 = dmsTo(ADV, /Новое видео по заданию/).length;
  const j1 = await bind(A, 'main', link('blogera', ID.A6));
  ok(j1.status === 200, 'А привязал ролик', j1.body);
  await api('POST', '/api/tasks/video/unbind', { id: j1.body.video.id }, A.token);
  const j2 = await bind(A, 'main', link('blogera', ID.A6));
  ok(j2.status === 200, 'отвязал и привязал снова', j2.body);
  await sleep(300);
  ok(dmsTo(ADV, /Новое видео по заданию/).length - advNew0 === 1, 'J: рекламодателю о том же ролике — одно письмо в сутки',
    dmsTo(ADV, /Новое видео/).length - advNew0);
  const ipU = '10.201.0.1';
  let ubl = null;
  for (let i = 0; i < 6; i++) ubl = await api('POST', '/api/tasks/video/unbind', { id: 999999 }, C.token, { ip: ipU });
  ok(ubl.status === 429, 'J: больше 5 отвязок в час — 429', ubl.body);

  /* ── A: снимок условий ── */
  console.log('\n— снимок условий');
  const d1 = await bind(D, 'terms', link('blogerd', ID.D1));
  const vD1 = d1.body.video || {};
  const snap = JSON.parse(row(vD1.id).terms || 'null');
  ok(d1.status === 200 && snap && snap.rate === 100 && snap.cap === 3000 && snap.payMode === 'views',
    'A: условия сняты в момент привязки', snap);
  /* Строка «как до снимков»: условия возьмутся из конверта один раз. */
  setRow(vD1.id, { terms: null });
  const rvD1 = await api('POST', '/api/tasks/video/review', { id: vD1.id, ok: true }, ADV.token);
  ok(rvD1.status === 200 && rvD1.body.video.earned === 500, 'A: старая строка посчитана по конверту: 5000 × 100 / 1000 = 500', rvD1.body.video);
  ok(JSON.parse(row(vD1.id).terms || 'null').rate === 100, 'A: и снимок тут же записан');
  /* Рекламодатель переписал оффер после зачёта — на ролик это не влияет. */
  const rw = await api('POST', '/api/sync/put', { kind: 'camp', rid: camps.terms,
    data: Object.assign({ id: camps.terms }, base, { name: 'Условия', rate: 0, maxPayout: 1, minViews: 1e9 }) }, ADV.token);
  ok(rw.status === 200, 'рекламодатель переписал ставку в ноль');
  V.get(ID.D1).views = 6000;
  await sync();
  const pD1 = (await getVid(vD1.id, D.token)).body.video;
  ok(pD1.status === 'paid' && pD1.earned === 600 && pD1.paid === 600, 'A: выплата по снимку: 6000 × 100 / 1000 = 600', pD1);

  /* ── B: резерв бюджета под видео ── */
  console.log('\n— резерв бюджета');
  const d2 = await bind(D, 'resv', link('blogerd', ID.D2));
  const vD2 = d2.body.video || {};
  ok(d2.status === 200, 'Д привязал ролик к офферу с потолком 800 ₽', d2.body);
  const rl1 = await api('POST', '/api/deals/release', { dealId: 'camp:' + camps.resv, toUserId: C.id, amount: 300, opKey: 'rel1-' + tag }, ADV.token);
  ok(rl1.status === 409 && rl1.body.code === 'videos_reserved' && rl1.body.reserved === 800 && rl1.body.free === 200,
    'B: вручную нельзя выплатить зарезервированное под видео', rl1.body);
  const rl2 = await api('POST', '/api/deals/release', { dealId: 'camp:' + camps.resv, toUserId: C.id, amount: 200, opKey: 'rel2-' + tag }, ADV.token);
  ok(rl2.status === 200 && rl2.body.paid === 200, 'B: свободную часть — можно', rl2.body);
  const rfR = await api('POST', '/api/deals/refund', { dealId: 'camp:' + camps.resv, opKey: 'rfr-' + tag }, ADV.token);
  ok(rfR.status === 409 && rfR.body.code === 'videos_live', 'B: вернуть бюджет нельзя, пока видео на проверке', rfR.body);
  await api('POST', '/api/tasks/video/review', { id: vD2.id, ok: true }, ADV.token);
  /* Оператор всё же вернул бюджет — в заморозке пусто. */
  const rfAdm = await api('POST', '/api/deals/refund', { dealId: 'camp:' + camps.resv, opKey: 'rfa-' + tag }, ADV.token, { admin: true });
  ok(rfAdm.status === 200 && rfAdm.body.refunded === 800, 'оператор вернул остаток бюджета', rfAdm.body);
  const dBal0 = await bal(D);
  await sync();
  const pD2 = (await getVid(vD2.id, ADV.token)).body.video;
  ok(pD2.status === 'active' && pD2.paid === 0 && pD2.earned === 300 && pD2.payHold === true
    && pD2.holdReason === 'В заморозке кампании не хватило денег: недоплачено 300 ₽',
  'B: денег нет — ролик не закрыт нулём, а ждёт владельца', pD2);
  await sleep(300);
  const d2Dm = dmsTo(D, /задерживается/).map((m) => m.text);
  ok(d2Dm.length === 1 && /заработано 300 ₽/.test(d2Dm[0]) && !dmsTo(D, /выплаты нет/).length,
    'B: блогеру не «выплаты нет», а «заработано 300 ₽, задерживается»', dmsTo(D).map((m) => m.text));
  await sync();
  await sleep(300);
  ok(dmsTo(D, /задерживается/).length === 1 && (await bal(D)).available === dBal0.available,
    'F: ролик на паузе круг не перебирает и не пишет снова');

  /* ── C: решение владельца — только про те цифры, что он видел ── */
  console.log('\n— решение и новые цифры');
  const d3 = await bind(D, 'terms', link('blogerd', ID.D3));
  const vD3 = d3.body.video || {};
  ok(d3.status === 200 && vD3.riskHold === true, 'Д: подозрительный ролик на паузе', vD3);
  const cD3 = await adm('POST', '/api/admin/task-videos/decide', { id: vD3.id, decision: 'count', note: 'цифры честные' });
  ok(cD3.status === 200 && cD3.body.video.riskHold === false && row(vD3.id).decided_views === 100000, 'C: решение запомнило 100 000 просмотров', cD3.body);
  Object.assign(V.get(ID.D3), { views: 150000, likes: 150 });
  await sync();
  ok(row(vD3.id).risk_hold === 0 && row(vD3.id).risk_level === 'bad', 'C: до двукратного роста решение держит');
  Object.assign(V.get(ID.D3), { views: 250000, likes: 250 });
  await sync();
  ok(row(vD3.id).risk_hold === 1, 'C: выросло больше чем вдвое — снова пауза');
  const d4 = await bind(D, 'terms', link('blogerd', ID.D4));
  const vD4 = d4.body.video || {};
  await api('POST', '/api/tasks/video/review', { id: vD4.id, ok: false, reason: 'Нет ссылки в описании' }, ADV.token);
  const cD4 = await adm('POST', '/api/admin/task-videos/decide', { id: vD4.id, decision: 'count' });
  ok(cD4.status === 200 && cD4.body.video.status === 'active' && row(vD4.id).decided_views === null,
    'C: «засчитать» возвращённый ролик — не решение о накрутке', cD4.body);
  Object.assign(V.get(ID.D4), { views: 100000, likes: 100, comments: 0, shares: 0 });
  await sync();
  const pD4 = (await getVid(vD4.id, ADV.token)).body.video;
  ok(pD4.status === 'active' && pD4.riskHold === true && pD4.paid === 0, 'C: накрутка после такого решения снова держит выплату', pD4);

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
  ok(sr.status === 200 && sr.body.fresh === true && sr.body.video.status === 'declined', 'G: площадку спросили, но ответ пришёл уже к закрытой строке', sr.body);
  ok(row(vD6.id).status === 'declined' && row(vD6.id).views !== 77777, 'G: ответ площадки не оживил закрытую строку', row(vD6.id));

  /* ── L: рекламодатель молчит трое суток ── */
  console.log('\n— автозачёт');
  const d7 = await bind(D, 'terms', link('blogerd', ID.D7));
  const vD7 = d7.body.video || {};
  setRow(vD7.id, { created_at: Date.now() - 73 * 3600e3 });
  const rAuto = await sync();
  ok(rAuto.body.autoAccepted === 1, 'L: круг засчитал один ролик сам', rAuto.body);
  const pD7 = (await getVid(vD7.id, D.token)).body.video;
  ok(pD7.decision === 'auto' && pD7.approvedAt > 0 && ['active', 'paid'].includes(pD7.status), 'L: decision = auto', pD7);
  await sleep(300);
  const autoTxt = 'Рекламодатель не ответил за 3 дня — видео засчитано автоматически';
  ok(dmsTo(D).some((m) => m.text.includes(autoTxt)) && dmsTo(ADV).some((m) => m.text.includes(autoTxt)), 'L: обеим сторонам сказано');

  /* ── D/H/I: доступ к TikTok умер ── */
  console.log('\n— доступ к TikTok потерян');
  const e1 = await bind(E, 'main', link('blogere', ID.E1));
  const e2 = await bind(E, 'main', link('blogere', ID.E2));
  const e3 = await bind(E, 'main', link('blogere', ID.E3));
  ok(e1.status === 200 && e2.status === 200 && e3.status === 200, 'Е привязал три ролика');
  const vE1 = e1.body.video, vE2 = e2.body.video, vE3 = e3.body.video;
  await api('POST', '/api/tasks/video/review', { id: vE1.id, ok: true }, ADV.token);
  await api('POST', '/api/tasks/video/review', { id: vE2.id, ok: true }, ADV.token);
  delete TOKENS['tok-E'];
  const tTry = Date.now();
  await sync();
  const wE1 = (await getVid(vE1.id, E.token)).body.video;
  ok(wE1.status === 'active' && wE1.paid === 0 && !wE1.payHold, 'D: замера нет — ждём, сами по старым цифрам не платим', wE1);
  ok(row(vE1.id).last_try_at >= tTry, 'F: неудачная попытка тоже записана в last_try_at');
  await sync();
  await sleep(300);
  ok(dmsTo(E, /Переподключите TikTok/).length === 1, 'I: блогеру — просьба переподключить TikTok, один раз в сутки',
    dmsTo(E).map((m) => m.text));
  /* Прошло трое суток после окна, финального замера так и нет. */
  const longAgo = Date.now() - 73 * 3600e3;
  setRow(vE1.id, { approved_at: longAgo, stats_at: longAgo - 60e3 });
  setRow(vE2.id, { approved_at: longAgo, stats_at: longAgo - 60e3, miss: 1 });
  const eBal0 = await bal(E);
  await sync();
  const hE1 = (await getVid(vE1.id, ADV.token)).body.video;
  const hE2 = (await getVid(vE2.id, ADV.token)).body.video;
  ok(hE1.status === 'active' && hE1.payHold && hE1.holdReason === 'Нет финального замера: доступ к TikTok потерян' && hE1.paid === 0,
    'D: не платим сами — ролик ушёл владельцу', hE1);
  ok(hE2.status === 'active' && hE2.payHold && hE2.holdReason === 'Нет финального замера: ролик не вернулся из TikTok',
    'H: промах + мёртвый доступ не ждут вечно — тоже владельцу', hE2);
  const qE = await adm('GET', '/api/admin/task-videos?status=queue');
  ok([vE1.id, vE2.id].every((id) => (qE.body.videos || []).some((v) => v.id === id)), 'D: оба в очереди владельца');
  await sync();
  await sleep(300);
  ok(dmsTo(E, /задерживается/).length === 2 && (await bal(E)).available === eBal0.available,
    'D: пауза ставится один раз, денег не уходит', dmsTo(E).map((m) => m.text));
  const cE1 = await adm('POST', '/api/admin/task-videos/decide', { id: vE1.id, decision: 'count', note: 'платим по последнему' });
  ok(cE1.status === 200 && cE1.body.settle === 'paid' && cE1.body.video.paid === 100,
    'D: владелец засчитал — платим по последнему замеру, без новой паузы', cE1.body);
  ok((await bal(E)).available - eBal0.available === 100, 'D: Е получил 100');

  /* E: владелец отвязал канал — снят только ролик на проверке. */
  const aul = await adm('POST', '/api/admin/verify/unlink', { platform: 'tiktok', externalId: 'chan-E' });
  ok(aul.status === 200, 'владелец отвязал канал Е', aul.body);
  ok(row(vE3.id).status === 'revoked' && row(vE2.id).status === 'active', 'E: снят только ролик на проверке, засчитанный остался');
  await sleep(300);
  ok(dmsTo(E, /Видео снято с проверки/).some((m) => /администратор отключил TikTok-канал/.test(m.text)), 'E: блогеру сказано, кто отключил');
  await sync();
  ok(row(vE2.id).status === 'active', 'E: круг без канала засчитанный ролик не снимает');
} catch (e) {
  failed++;
  console.log('  FAIL неожиданная ошибка: ' + ((e && e.stack) || e));
} finally {
  stop();
}

console.log('\nИтого: ' + passed + ' ok, ' + failed + ' FAIL');
process.exit(failed ? 1 : 0);
