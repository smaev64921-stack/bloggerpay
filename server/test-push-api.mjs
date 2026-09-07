/* Уведомления на телефон: ручки сервера и доставка по событиям.

   Поднимаем свой сервер и подставляем вместо службы доставки браузера
   свою заглушку — на неё сервер и шлёт. Проверяем, что подписка живёт,
   что чужую не удалить, что по решению оператора уведомление уходит
   нужному человеку, и что мёртвая подписка убирается сама.

   Запуск: node test-push-api.mjs */

import https from 'node:https';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = 8101, STUB = 8102;
const BASE = 'http://127.0.0.1:' + PORT;
const KEY = 'test-key-push';

let passed = 0, failed = 0;
function ok(c, name, extra) {
  if (c) { passed++; console.log('  ok  ' + name); }
  else { failed++; console.log('  FAIL ' + name + (extra ? '  ← ' + JSON.stringify(extra).slice(0, 240) : '')); }
}
const b64u = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const dir = mkdtempSync(path.join(tmpdir(), 'bp-push-'));

/* ── Заглушка службы доставки ────────────────────────────────────────
   Обязательно ПО HTTPS: сервер намеренно не шлёт уведомления по http,
   иначе строкой в теле запроса его можно было бы заставить стучаться
   куда угодно. Поэтому выписываем себе одноразовый сертификат, а
   серверу в тесте разрешаем ему верить (только в тесте). */
const certFile = path.join(dir, 'stub.pem'), keyFile = path.join(dir, 'stub.key');
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
  '-keyout', keyFile, '-out', certFile, '-days', '1',
  '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'], { stdio: 'ignore' });

/* Адрес заглушки — по ИМЕНИ, а не по 127.0.0.1: сервер намеренно не шлёт
   уведомления на голые адреса, чтобы его нельзя было заставить стучаться
   во внутреннюю сеть. Имя localhost разрешаем серверу через
   PUSH_HOSTS_EXTRA — щель, которая существует ровно для этой проверки. */
const STUB_HOST = 'localhost';

const got = [];
let answer = 201;
const stub = https.createServer(
  { key: readFileSync(keyFile), cert: readFileSync(certFile) },
  (req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      got.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(answer); res.end();
    });
  });
await new Promise((r) => stub.listen(STUB, '127.0.0.1', r));

/* ── Свой сервер ── */
const srv = spawn(process.execPath, ['server.js'], {
  cwd: fileURLToPath(new URL('.', import.meta.url)),
  env: {
    ...process.env, PORT: String(PORT), DB_PATH: path.join(dir, 'db.sqlite'),
    ADMIN_KEY: KEY, ADMIN_EMAIL: '', BOT_TOKEN: '', ADMIN_CHAT_ID: '',
    RESEND_API_KEY: '', TEST_TOPUP: '1', YOOKASSA_SHOP_ID: '', YOOKASSA_SECRET_KEY: '',
    /* Сертификат заглушки самодельный, и сервер обязан ему верить —
       иначе уведомление до неё не дойдёт. Доверяем ИМЕННО ЕМУ, одному
       файлу на время теста, а не выключаем проверку сертификатов совсем:
       выключенная проверка — это открытая дверь для подмены на любом
       чужом соединении, в том числе к настоящим службам доставки. */
    NODE_EXTRA_CA_CERTS: certFile,
    PUSH_HOSTS_EXTRA: STUB_HOST,
  },
  stdio: 'ignore',
});
async function up() {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) return true; } catch (e) {}
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}
async function api(method, p, body, token, key) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  if (key) headers['X-Admin-Key'] = key;
  const r = await fetch(BASE + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let j = {}; try { j = await r.json(); } catch (e) {}
  return { status: r.status, body: j };
}
function subFor(tag) {
  const ua = crypto.createECDH('prime256v1');
  const pub = ua.generateKeys();
  return {
    ecdh: ua,
    wire: {
      endpoint: 'https://' + STUB_HOST + ':' + STUB + '/push/' + tag,
      keys: { p256dh: b64u(pub), auth: b64u(crypto.randomBytes(16)) },
    },
  };
}

try {
  console.log('\nУведомления: ручки сервера');
  ok(await up(), 'сервер поднялся');

  const tag = Date.now().toString(36);
  const A = await api('POST', '/api/register', { email: 'pa' + tag + '@t.ru', name: 'Аня', role: 'blogger', password: 'парольДлинный12' });
  const B = await api('POST', '/api/register', { email: 'pb' + tag + '@t.ru', name: 'Боря', role: 'blogger', password: 'парольДлинный12' });
  const TA = A.body.token, TB = B.body.token;

  /* ── Открытый ключ ── */
  const k1 = await api('GET', '/api/push/key');
  ok(k1.status === 200 && typeof k1.body.key === 'string' && k1.body.key.length > 80, 'сервер отдаёт открытый ключ', k1.body);
  const k2 = await api('GET', '/api/push/key');
  ok(k2.body.key === k1.body.key, 'ключ один и тот же между запросами');

  /* ── Подписка ── */
  const sa = subFor('a-' + tag);
  ok((await api('POST', '/api/push/subscribe', { sub: sa.wire })).status === 401, 'без входа подписаться нельзя');

  const add = await api('POST', '/api/push/subscribe', { sub: sa.wire }, TA);
  ok(add.status === 200 && add.body.ok, 'подписка сохранена', add.body);

  const again = await api('POST', '/api/push/subscribe', { sub: sa.wire }, TA);
  ok(again.status === 200, 'повторная подписка того же браузера не ошибка');

  const badScheme = await api('POST', '/api/push/subscribe',
    { sub: { endpoint: 'http://127.0.0.1:1/x', keys: sa.wire.keys } }, TA);
  ok(badScheme.status === 400, 'адрес не по https отклонён', badScheme.body);

  const noKeys = await api('POST', '/api/push/subscribe',
    { sub: { endpoint: 'https://fcm.googleapis.com/fcm/send/x' } }, TA);
  ok(noKeys.status === 400, 'подписка без ключей отклонена', noKeys.body);

  /* ── Куда сервер стучаться не должен ──
     Адрес доставки приходит от клиента. Без списка разрешённых служб это
     готовый инструмент разведки чужой сети: по коду ответа и времени
     видно, что живёт за каждым внутренним адресом. */
  const ssrf = {
    'внутренний адрес': 'https://127.0.0.1:' + STUB + '/push/x',
    'метаданные облака': 'https://169.254.169.254/latest/meta-data/',
    'соседняя машина в сети': 'https://10.0.0.5/admin',
    'чужой сайт': 'https://evil.example.org/collect',
    'похожий домен': 'https://fcm.googleapis.com.evil.org/x',
  };
  for (const name of Object.keys(ssrf)) {
    const r = await api('POST', '/api/push/subscribe',
      { sub: { endpoint: ssrf[name], keys: sa.wire.keys } }, TA);
    ok(r.status === 400, 'подписку не заведут на ' + name, { status: r.status, url: ssrf[name] });
  }

  /* И ни один такой адрес не должен был получить запрос. */
  got.length = 0;
  await new Promise((r) => setTimeout(r, 300));
  ok(got.length === 0, 'на отклонённые адреса сервер не ходил', { ушло: got.length });

  /* ── Отписка ── */
  const alien = await api('POST', '/api/push/unsubscribe', { endpoint: sa.wire.endpoint }, TB);
  ok(alien.status === 200 && alien.body.removed === 0, 'чужую подписку снять нельзя', alien.body);

  /* ── Доставка по событию: оператор подтвердил личность ── */
  const PIX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
  const kyc = await api('POST', '/api/kyc/submit', { name: 'Аня Ан', birth: '01.01.1990', photo: PIX, selfie: PIX }, TA);
  got.length = 0;
  const okKyc = await api('POST', '/api/admin/kyc/approve', { requestId: kyc.body.requestId }, null, KEY);
  ok(okKyc.status === 200, 'оператор подтвердил личность', okKyc.body);
  await new Promise((r) => setTimeout(r, 900));
  ok(got.length === 1, 'уведомление ушло ровно одно', { ушло: got.length });
  if (got.length) {
    ok(got[0].url === '/push/a-' + tag, 'ушло на адрес подписки', { url: got[0].url });
    ok(/^vapid t=/.test(String(got[0].headers.authorization || '')), 'запрос подписан ключом сервера');
    ok(got[0].headers['content-encoding'] === 'aes128gcm', 'тело зашифровано');
    ok(got[0].body.length > 80, 'тело не пустое', { len: got[0].body.length });
  }

  /* ── Чужому не приходит ── */
  const sb = subFor('b-' + tag);
  await api('POST', '/api/push/subscribe', { sub: sb.wire }, TB);
  got.length = 0;
  const kyc2 = await api('POST', '/api/kyc/submit', { name: 'Боря Бо', birth: '02.02.1992', photo: PIX, selfie: PIX }, TB);
  await api('POST', '/api/admin/kyc/reject', { requestId: kyc2.body.requestId, note: 'фото нечитаемо' }, null, KEY);
  await new Promise((r) => setTimeout(r, 900));
  ok(got.length === 1 && got[0].url === '/push/b-' + tag, 'решение по Боре ушло только Боре', { ушло: got.map((g) => g.url) });

  /* ── Два устройства одного человека ── */
  const sa2 = subFor('a2-' + tag);
  await api('POST', '/api/push/subscribe', { sub: sa2.wire }, TA);
  got.length = 0;
  await api('POST', '/api/topup', { amount: 50000, opKey: crypto.randomUUID() }, TA);
  const wd = await api('POST', '/api/withdraw', { amount: 5000, requisites: 'карта 1111', opKey: crypto.randomUUID() }, TA);
  ok(wd.status === 200, 'заявка на вывод создана', wd.body);
  await api('POST', '/api/admin/withdrawals/paid', { withdrawalId: wd.body.withdrawalId }, null, KEY);
  await new Promise((r) => setTimeout(r, 1100));
  const urls = got.map((g) => g.url).sort();
  ok(urls.length === 2, 'уведомление пришло на оба устройства', { urls });

  /* ── Мёртвая подписка убирается сама ── */
  answer = 410;
  got.length = 0;
  const wd2 = await api('POST', '/api/withdraw', { amount: 3000, requisites: 'карта 2222', opKey: crypto.randomUUID() }, TA);
  await api('POST', '/api/admin/withdrawals/reject', { withdrawalId: wd2.body.withdrawalId }, null, KEY);
  await new Promise((r) => setTimeout(r, 1200));
  ok(got.length === 2, 'попытка была на оба устройства', { ушло: got.length });

  answer = 201;
  got.length = 0;
  const wd3 = await api('POST', '/api/withdraw', { amount: 2000, requisites: 'карта 3333', opKey: crypto.randomUUID() }, TA);
  await api('POST', '/api/admin/withdrawals/reject', { withdrawalId: wd3.body.withdrawalId }, null, KEY);
  await new Promise((r) => setTimeout(r, 1200));
  ok(got.length === 0, 'после отказа 410 подписки удалены и больше не тревожатся', { ушло: got.length });

} finally {
  try { srv.kill(); } catch (e) {}
  try { stub.close(); } catch (e) {}
}

console.log('\nИтого: ' + passed + ' ok, ' + failed + ' FAIL\n');
process.exit(failed ? 1 : 0);
