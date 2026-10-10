/* «Снять все карты с витрины» (решение владельца 10.10.2026: задания как
   у More Views, карта блогера больше не услуга).
   Проверяем: снимает только владелец; публичный каталог пуст, а пульт
   видит карты снятыми; приложение не возвращает снятую карту ни правкой,
   ни повторной отправкой после удаления, ни новой картой, пока витрина
   закрыта; скрытые по одной остаются скрытыми и после «Вернуть все»;
   снятие переживает перезапуск сервера; всё ложится в журнал.
   Поднимает свой сервер на 8116 и гасит его в конце.
   Запуск: node test-cards-unpublish.mjs */

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = 8116;
const BASE = 'http://127.0.0.1:' + PORT;
const KEY = 'test-key-unpublish';
const HERE = fileURLToPath(new URL('.', import.meta.url));
let passed = 0, failed = 0;
function ok(c, name, extra) {
  if (c) { passed++; console.log('  ok  ' + name); }
  else { failed++; console.log('  FAIL ' + name + (extra ? '  ← ' + JSON.stringify(extra).slice(0, 300) : '')); }
}
let jar = '';
function remember(res) {
  const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const line of sc) {
    const kv = line.split(';')[0];
    if (kv.startsWith('bp_admin=')) jar = kv.endsWith('=') ? '' : kv;
  }
}
/* opt: token — вход человека; admin — кука пульта + X-Admin-Session;
   cookieOnly — кука без X-Admin-Session (так шлёт чужой сайт). */
async function api(method, p, body, opt) {
  const o = opt || {};
  const headers = { 'Content-Type': 'application/json' };
  if (o.token) headers.Authorization = 'Bearer ' + o.token;
  if (o.admin || o.cookieOnly) { if (jar) headers.Cookie = jar; }
  if (o.admin) headers['X-Admin-Session'] = '1';
  if (o.key) headers['X-Admin-Key'] = o.key;
  const r = await fetch(BASE + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  remember(r);
  const txt = await r.text();
  let j = {}; try { j = JSON.parse(txt); } catch (e) { j = { _raw: txt.slice(0, 160) }; }
  return { status: r.status, body: j };
}
const A = { admin: true };
const dir = mkdtempSync(path.join(tmpdir(), 'bp-unpub-'));
const DB = path.join(dir, 'db.sqlite');
let srv = null;
function start() {
  srv = spawn(process.execPath, ['server.js'], {
    cwd: HERE,
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, ADMIN_KEY: KEY, ADMIN_EMAIL: '',
      TEST_TOPUP: '1', YOOKASSA_SHOP_ID: '', YOOKASSA_SECRET_KEY: '', BOT_TOKEN: '', ADMIN_CHAT_ID: '',
      RL_DISABLE: '1' },
    stdio: 'ignore',
  });
}
async function stop() {
  if (!srv) return;
  const p = new Promise((r) => srv.once('exit', r));
  srv.kill();
  await p;
  srv = null;
}
async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) return true; } catch (e) {}
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}
async function reg(tag, role) {
  const r = await api('POST', '/api/register', { email: `un${tag}@t.ru`, name: 'Блогер ' + tag, role, password: 'парольТест12345' });
  return { token: r.body.token, id: r.body.user && r.body.user.id };
}
const card = (name, extra) => Object.assign({ name, initials: 'БЛ', platforms: ['youtube'],
  platData: { youtube: { url: 'https://youtube.com/@' + encodeURIComponent(name), subs: 54000, reach: 20000, er: 3.9 } },
  integrations: { youtube: [{ fmtId: 'yt_pre', price: 8000 }] }, topics: ['Еда'] }, extra || {});
const pubIds = async () => ((await api('GET', '/api/cards')).body.rows || []).map((r) => r.id).sort();
const adminRows = async () => {
  const r = await api('GET', '/api/admin/cards', null, A);
  const m = {};
  for (const c of (r.body.rows || [])) m[c.id] = c;
  return { status: r.status, stats: r.body.stats || {}, by: m };
};

try {
  console.log('\nСнять все карты с витрины');
  start();
  ok(await waitUp(), 'сервер поднялся');

  const t = Date.now();
  const a = await reg('a' + t, 'blogger');
  const b = await reg('b' + t, 'blogger');
  const c = await reg('c' + t, 'blogger');
  const adv = await reg('d' + t, 'advertiser');
  ok(a.token && b.token && c.token && adv.token, 'три блогера и рекламодатель заведены');

  const A1 = 'mycard_a1_' + t, A2 = 'mycard_a2_' + t, B1 = 'mycard_b1_' + t, B2 = 'mycard_b2_' + t, C1 = 'mycard_c1_' + t;
  for (const [id, who, name] of [[A1, a, 'Анна'], [A2, a, 'Анна · второй канал'], [B1, b, 'Борис'], [C1, c, 'Вера']]) {
    const r = await api('POST', '/api/cards', { id, card: card(name) }, { token: who.token });
    ok(r.status === 200, 'опубликована карта ' + name, r.body);
  }
  ok((await pubIds()).length === 4, 'на витрине четыре карты');

  /* ── посторонним закрыто ── */
  for (const p of ['/api/admin/cards/unpublish-all', '/api/admin/cards/restore-all']) {
    const anon = await api('POST', p, {});
    ok(anon.status === 401 || anon.status === 403, p + ': без входа — отказ', anon);
    const user = await api('POST', p, {}, { token: a.token });
    ok(user.status === 401 || user.status === 403, p + ': обычный блогер — отказ', user);
    const advr = await api('POST', p, {}, { token: adv.token });
    ok(advr.status === 401 || advr.status === 403, p + ': рекламодатель — отказ', advr);
    const wrong = await api('POST', p, {}, { key: 'wrong-key-0000' });
    ok(wrong.status === 401 || wrong.status === 403, p + ': чужой ключ — отказ', wrong);
  }
  ok((await pubIds()).length === 4, 'после отказов витрина не тронута');

  /* ── вход владельца ── */
  const enter = await api('POST', '/api/admin/session', { key: KEY }, { admin: true });
  ok(enter.status === 200 && !!jar, 'владелец вошёл в пульт ключом', enter.body);
  for (const p of ['/api/admin/cards/unpublish-all', '/api/admin/cards/restore-all']) {
    const forged = await api('POST', p, {}, { cookieOnly: true });
    ok(forged.status === 403, p + ': чужой сайт с одной кукой — отказ', forged);
  }
  ok((await pubIds()).length === 4, 'и после подделки витрина цела');

  /* Одна карта скрыта по одной ещё до общей кнопки — это отдельное решение. */
  const h1 = await api('POST', '/api/admin/cards/hide', { id: C1, hidden: true }, A);
  ok(h1.status === 200, 'карта Веры скрыта по одной', h1.body);

  const s0 = await adminRows();
  ok(s0.status === 200 && s0.stats.total === 4 && s0.stats.visible === 3 && s0.stats.listed === 3
    && s0.stats.hidden === 1 && s0.stats.unpublished === 0 && s0.stats.closed === false,
  'в пульте счётчики витрины: всего 4, на витрине 3, скрыта 1, витрина открыта', s0.stats);

  /* ── снять все ── */
  const off = await api('POST', '/api/admin/cards/unpublish-all', {}, A);
  ok(off.status === 200 && off.body.ok === true && off.body.unpublished === 3 && off.body.closed === true,
    'сняты три карты, витрина закрыта', off.body);
  ok(off.body.stats && off.body.stats.visible === 0 && off.body.stats.unpublished === 3 && off.body.stats.hidden === 1,
    'в ответе свежие счётчики', off.body.stats);

  ok((await pubIds()).length === 0, 'публичный каталог пуст (гость)');
  const asAdv = await api('GET', '/api/cards', null, { token: adv.token });
  ok(asAdv.status === 200 && asAdv.body.rows.length === 0, 'публичный каталог пуст (рекламодатель)', asAdv.body);

  const s1 = await adminRows();
  ok(Object.keys(s1.by).length === 4, 'в пульте все четыре карты на месте — не удалены', Object.keys(s1.by));
  ok(s1.by[A1].hidden === 2 && s1.by[A2].hidden === 2 && s1.by[B1].hidden === 2, 'снятые общей кнопкой отмечены hidden = 2',
    [s1.by[A1].hidden, s1.by[A2].hidden, s1.by[B1].hidden]);
  ok(s1.by[C1].hidden === 1, 'скрытая по одной осталась при своей отметке', s1.by[C1].hidden);
  ok(s1.stats.closed === true && !!s1.stats.closedAt, 'пульт знает, что витрина закрыта и когда', s1.stats);
  ok(s1.by[A1].card.name === 'Анна', 'данные карты целы', s1.by[A1].card);

  const ua = await api('GET', '/api/admin/user?id=' + a.id, null, A);
  ok(ua.status === 200 && ua.body.cards.length === 2 && ua.body.cards.every((x) => x.hidden === 2),
    'в карточке человека его карты — снятые', ua.body.cards);

  /* ── синхронизация из приложения не возвращает снятую карту ── */
  const sync1 = await api('POST', '/api/cards', { id: A1, card: card('Анна', { msg: 'Пишите' }) }, { token: a.token });
  ok(sync1.status === 200, 'приложение прислало правку снятой карты', sync1.body);
  const s2 = await adminRows();
  ok((await pubIds()).length === 0 && s2.by[A1].hidden === 2 && s2.by[A1].card.msg === 'Пишите',
    'правка принята, но карта осталась снятой', s2.by[A1]);

  const del = await api('POST', '/api/cards/delete', { id: A2 }, { token: a.token });
  ok(del.status === 200 && del.body.removed === 1, 'автор удалил снятую карту на одном телефоне', del.body);
  const back = await api('POST', '/api/cards', { id: A2, card: card('Анна · второй канал') }, { token: a.token });
  const s3 = await adminRows();
  ok(back.status === 200 && (await pubIds()).length === 0 && s3.by[A2] && s3.by[A2].hidden === 2,
    'второй телефон прислал её заново — легла снятой, а не на витрину', s3.by[A2]);

  const fresh = await api('POST', '/api/cards', { id: B2, card: card('Борис · новая') }, { token: b.token });
  const s4 = await adminRows();
  ok(fresh.status === 200 && (await pubIds()).length === 0 && s4.by[B2] && s4.by[B2].hidden === 2,
    'пока витрина закрыта, новая карта тоже ложится снятой', s4.by[B2]);

  const delC = await api('POST', '/api/cards/delete', { id: C1 }, { token: c.token });
  const backC = await api('POST', '/api/cards', { id: C1, card: card('Вера') }, { token: c.token });
  const s5 = await adminRows();
  ok(delC.status === 200 && backC.status === 200 && s5.by[C1] && s5.by[C1].hidden === 1,
    'скрытая по одной после удаления и повторной отправки — снова скрыта по одной', s5.by[C1]);

  const steal = await api('POST', '/api/cards', { id: B1, card: card('Подмена') }, { token: a.token });
  ok(steal.status === 403, 'чужую снятую карту перезаписать нельзя', steal.body);

  /* ── повтор безопасен ── */
  const off2 = await api('POST', '/api/admin/cards/unpublish-all', {}, A);
  ok(off2.status === 200 && off2.body.unpublished === 0 && off2.body.closed === true, 'повторное «Снять все» — снимать нечего', off2.body);

  /* ── «Вернуть» по одной работает и при закрытой витрине ── */
  const one = await api('POST', '/api/admin/cards/hide', { id: A1, hidden: false }, A);
  ok(one.status === 200 && JSON.stringify(await pubIds()) === JSON.stringify([A1]), 'одну карту вернули — на витрине только она', await pubIds());

  /* ── перезапуск сервера: снятие и закрытая витрина в базе ── */
  await stop();
  start();
  ok(await waitUp(), 'сервер перезапущен на той же базе');
  ok(JSON.stringify(await pubIds()) === JSON.stringify([A1]), 'после перезапуска витрина та же', await pubIds());
  const s6 = await adminRows();
  ok(s6.stats.closed === true && s6.stats.unpublished === 3, 'витрина всё ещё закрыта, снятых три', s6.stats);
  const B3 = 'mycard_b3_' + t;
  await api('POST', '/api/cards', { id: B3, card: card('Борис · третья') }, { token: b.token });
  ok(!(await pubIds()).includes(B3), 'и после перезапуска новая карта не попадает на витрину');

  /* ── вернуть все ── */
  const on = await api('POST', '/api/admin/cards/restore-all', {}, A);
  ok(on.status === 200 && on.body.ok === true && on.body.restored === 4 && on.body.closed === false,
    'вернуть все: вернулись четыре снятые карты, витрина открыта', on.body);
  const ids = await pubIds();
  ok(JSON.stringify(ids) === JSON.stringify([A1, A2, B1, B2, B3].sort()), 'на витрине все снятые общей кнопкой и вернутая по одной', ids);
  ok(!ids.includes(C1), 'скрытая по одной на витрину не вернулась');
  const s7 = await adminRows();
  ok(s7.stats.closed === false && s7.stats.unpublished === 0 && s7.stats.hidden === 1 && s7.stats.listed === 5,
    'счётчики после возврата', s7.stats);

  const D1 = 'mycard_d1_' + t;
  await api('POST', '/api/cards', { id: D1, card: card('Анна · третья') }, { token: a.token });
  ok((await pubIds()).includes(D1), 'витрина открыта — новая карта сразу видна');

  const delC2 = await api('POST', '/api/cards/delete', { id: C1 }, { token: c.token });
  await api('POST', '/api/cards', { id: C1, card: card('Вера') }, { token: c.token });
  const s8 = await adminRows();
  ok(delC2.status === 200 && !(await pubIds()).includes(C1) && s8.by[C1].hidden === 1,
    'и при открытой витрине скрытая по одной сама не возвращается', s8.by[C1]);

  const on2 = await api('POST', '/api/admin/cards/restore-all', {}, A);
  ok(on2.status === 200 && on2.body.restored === 0, 'повторное «Вернуть все» — возвращать нечего', on2.body);

  /* ── журнал ── */
  const log = await api('GET', '/api/admin/log?limit=100', null, A);
  const rows = log.body.rows || [];
  const offs = rows.filter((r) => r.action === 'cards-unpublish-all');
  const ons = rows.filter((r) => r.action === 'cards-restore-all');
  ok(log.status === 200 && offs.length === 2 && ons.length === 2, 'в журнале оба «Снять все» и оба «Вернуть все»', rows.map((r) => r.action));
  const firstOff = offs[offs.length - 1];
  ok(!!firstOff && /снято 3/.test(firstOff.detail || '') && firstOff.who === 'ключ владельца' && firstOff.target === 'витрина карт',
    'запись говорит, сколько снято и кто нажал', firstOff);
  const firstOn = ons[ons.length - 1];
  ok(!!firstOn && /возвращено 4/.test(firstOn.detail || ''), 'запись возврата — сколько вернулось', firstOn);

  /* ── пульт: кнопки на месте ── */
  const html = readFileSync(path.join(HERE, 'operator.html'), 'utf8');
  ok(/data-act="cardsoff"/.test(html) && /data-act="cardson"/.test(html)
    && /Снять все карты с витрины/.test(html) && /Вернуть все/.test(html)
    && /\/api\/admin\/cards\/unpublish-all/.test(html) && /\/api\/admin\/cards\/restore-all/.test(html),
  'в разделе «Каталог» есть «Снять все карты с витрины» и «Вернуть все»');
  ok(/ask\(o\)/.test(html) && /cardWord\(n\)/.test(html), 'снятие идёт через своё окно подтверждения с числом карт');

  /* ── выход: снова закрыто ── */
  await api('POST', '/api/admin/logout', {}, A);
  const after = await api('POST', '/api/admin/cards/unpublish-all', {}, A);
  ok(after.status === 403, 'после выхода из пульта снять нельзя', after);
  ok((await pubIds()).length === 6, 'витрина не тронута');
} catch (e) {
  failed++;
  console.log('  FAIL исключение: ' + (e && e.stack || e));
} finally {
  await stop().catch(() => {});
  console.log('\n' + passed + ' ok, ' + failed + ' fail');
  process.exit(failed ? 1 : 0);
}
