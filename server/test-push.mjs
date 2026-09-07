/* Уведомления на телефон: шифрование и подпись.

   Сеть здесь не нужна и не трогается. Проверяем то, что нельзя проверить
   глазами: что зашифрованное нами сообщение РАСШИФРОВЫВАЕТСЯ по тем же
   правилам, по которым его будет разбирать браузер (RFC 8291), и что
   подпись запроса (VAPID, RFC 8292) сходится открытым ключом.

   Если этот набор красный — уведомления не дойдут вообще, и сервис
   доставки ответит невнятной ошибкой.

   Запуск: node test-push.mjs */

import crypto from 'node:crypto';
import { rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(here, 'data', 'test-push.db');
try { rmSync(path.join(here, 'data', 'vapid.json'), { force: true }); } catch (e) {}

const push = require('./push.js');

let passed = 0, failed = 0;
function ok(c, name, extra) {
  if (c) { passed++; console.log('  ok  ' + name); }
  else { failed++; console.log('  FAIL ' + name + (extra ? '  ← ' + JSON.stringify(extra).slice(0, 240) : '')); }
}
const b64u = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

console.log('\nУведомления: шифрование и подпись');

/* ── Ключи сервера ── */
const k = push.keys(tmpDb);
ok(k.publicRaw.length === 65, 'открытый ключ — несжатая точка в 65 байт', { len: k.publicRaw.length });
ok(k.publicRaw[0] === 4, 'ключ начинается с 0x04');
ok(push.keys(tmpDb).publicB64 === k.publicB64, 'ключ не пересоздаётся при повторном чтении');

/* ── Подписка «браузера»: пара ключей и секрет ── */
const ua = crypto.createECDH('prime256v1');
const uaPublic = ua.generateKeys();
const auth = crypto.randomBytes(16);
/* Адрес выдуманный, поэтому разрешаем его тесту явно — так же, как это
   делают проверки ручек. Сервер по умолчанию шлёт только в известные
   службы доставки, и это отдельно проверяется ниже. */
const ENV = { PUSH_HOSTS_EXTRA: 'push.example.org' };
const sub = {
  endpoint: 'https://push.example.org/abc123',
  p256dh: b64u(uaPublic),
  auth: b64u(auth),
};

/* ── Куда слать можно, а куда нельзя ── */
const okHosts = [
  'https://fcm.googleapis.com/fcm/send/abc',
  'https://updates.push.services.mozilla.com/wpush/v2/xyz',
  'https://wns2-by3p.notify.windows.com/w/?token=A',
  'https://web.push.apple.com/QABC',
];
ok(okHosts.every((u) => push.endpointOk(u)), 'настоящие службы доставки разрешены',
  okHosts.filter((u) => !push.endpointOk(u)));

const bad = {
  'петля по адресу': 'https://127.0.0.1:8102/push/a',
  'метаданные облака': 'https://169.254.169.254/latest/meta-data/',
  'петля IPv6': 'https://[::1]/x',
  'чужой сайт': 'https://evil.example.org/collect',
  'похожий домен': 'https://fcm.googleapis.com.evil.org/x',
  'без https': 'http://fcm.googleapis.com/x',
  'мусор вместо адреса': 'не адрес вовсе',
};
for (const name of Object.keys(bad)) {
  ok(!push.endpointOk(bad[name]), 'отклонено: ' + name, { url: bad[name] });
}

/* ── Шифруем тем же путём, каким это делает отправка ── */
const TEXT = JSON.stringify({ title: 'Новая заявка', body: 'Сбер предлагает 45 000 ₽', url: '/' });

/* sendOne уходит в сеть, поэтому шифрование зовём через ту же функцию,
   но перехватываем запрос: подменяем fetch и забираем тело. */
let captured = null;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  captured = { url, headers: opts.headers, body: Buffer.from(opts.body) };
  return { ok: true, status: 201 };
};
const res = await push.sendOne(sub, TEXT, { dbPath: tmpDb, subject: 'mailto:test@bloggerpay', env: ENV });
globalThis.fetch = realFetch;

ok(res.ok && res.status === 201, 'отправка отдала успех', res);
ok(captured && captured.url === sub.endpoint, 'запрос ушёл на адрес подписки');
ok(captured && captured.headers['Content-Encoding'] === 'aes128gcm', 'кодировка тела объявлена');
ok(captured && String(captured.headers.TTL) === '86400', 'срок жизни уведомления задан');

/* ── Разбираем тело так, как это сделает браузер ── */
const body = captured.body;
const salt = body.subarray(0, 16);
const idlen = body[20];
const asPublic = body.subarray(21, 21 + idlen);
const cipher = body.subarray(21 + idlen);
ok(idlen === 65, 'в теле лежит разовый ключ отправителя', { idlen });

const shared = ua.computeSecret(asPublic);
const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'utf8'), uaPublic, asPublic]);
const ikm = crypto.hkdfSync('sha256', shared, auth, keyInfo, 32);
const cek = crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16);
const nonce = crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12);

let plain = null, err = null;
try {
  const tag = cipher.subarray(cipher.length - 16);
  const data = cipher.subarray(0, cipher.length - 16);
  const d = crypto.createDecipheriv('aes-128-gcm', Buffer.from(cek), Buffer.from(nonce));
  d.setAuthTag(tag);
  plain = Buffer.concat([d.update(data), d.final()]);
} catch (e) { err = (e && e.message) || String(e); }

ok(plain !== null, 'сообщение расшифровалось ключами подписки', { err });
if (plain) {
  ok(plain[plain.length - 1] === 2, 'в конце стоит признак последней записи');
  const text = plain.subarray(0, plain.length - 1).toString('utf8');
  ok(text === TEXT, 'текст дошёл без искажений', { got: text.slice(0, 80) });
}

/* ── Чужие ключи расшифровать не должны ── */
const other = crypto.createECDH('prime256v1');
other.generateKeys();
let opened = false;
try {
  const s2 = other.computeSecret(asPublic);
  const i2 = crypto.hkdfSync('sha256', s2, auth, keyInfo, 32);
  const c2 = crypto.hkdfSync('sha256', i2, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16);
  const n2 = crypto.hkdfSync('sha256', i2, salt, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12);
  const tag = cipher.subarray(cipher.length - 16);
  const d2 = crypto.createDecipheriv('aes-128-gcm', Buffer.from(c2), Buffer.from(n2));
  d2.setAuthTag(tag);
  Buffer.concat([d2.update(cipher.subarray(0, cipher.length - 16)), d2.final()]);
  opened = true;
} catch (e) { opened = false; }
ok(!opened, 'чужим ключом сообщение не открывается');

/* ── Подпись запроса ── */
const authHeader = String(captured.headers.Authorization || '');
ok(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/.test(authHeader), 'заголовок подписи собран по формату', { authHeader: authHeader.slice(0, 60) });

const m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(authHeader);
if (m) {
  const head = JSON.parse(unb64u(m[1]).toString('utf8'));
  const payload = JSON.parse(unb64u(m[2]).toString('utf8'));
  ok(head.alg === 'ES256' && head.typ === 'JWT', 'заголовок подписи — ES256');
  ok(payload.aud === 'https://push.example.org', 'адресат подписи — сервис доставки', payload);
  ok(payload.sub === 'mailto:test@bloggerpay', 'в подписи указан контакт владельца');
  ok(payload.exp > Math.floor(Date.now() / 1000) && payload.exp < Math.floor(Date.now() / 1000) + 13 * 3600,
    'срок подписи не больше двенадцати часов', { exp: payload.exp });
  ok(m[4] === k.publicB64, 'в заголовке тот же открытый ключ, что отдаём приложению');

  const pub = crypto.createPublicKey({
    key: { kty: 'EC', crv: 'P-256', x: b64u(k.publicRaw.subarray(1, 33)), y: b64u(k.publicRaw.subarray(33)) },
    format: 'jwk',
  });
  const good = crypto.verify('sha256', Buffer.from(m[1] + '.' + m[2]), { key: pub, dsaEncoding: 'ieee-p1363' }, unb64u(m[3]));
  ok(good, 'подпись сходится открытым ключом');

  const bad = crypto.verify('sha256', Buffer.from(m[1] + '.' + m[2] + 'x'), { key: pub, dsaEncoding: 'ieee-p1363' }, unb64u(m[3]));
  ok(!bad, 'подделанная строка подпись не проходит');
}

/* ── Мёртвая подписка распознаётся ── */
globalThis.fetch = async () => ({ ok: false, status: 410 });
const gone = await push.sendOne(sub, TEXT, { dbPath: tmpDb, env: ENV });
globalThis.fetch = realFetch;
ok(gone.gone === true, 'ответ 410 помечен как «подписки больше нет»', gone);

/* ── Сеть упала — отправка не бросает ── */
globalThis.fetch = async () => { throw new Error('сеть недоступна'); };
const dead = await push.sendOne(sub, TEXT, { dbPath: tmpDb, env: ENV });
globalThis.fetch = realFetch;
ok(dead.ok === false && !dead.gone, 'сбой сети не роняет отправку и не считается отпиской', dead);

try { rmSync(path.join(here, 'data', 'vapid.json'), { force: true }); } catch (e) {}
console.log('\nИтого: ' + passed + ' ok, ' + failed + ' FAIL\n');
process.exit(failed ? 1 : 0);
