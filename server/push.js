/* ══════════════════════════════════════════════════════════════════════
   BloggerPay — уведомления на телефон, когда приложение закрыто.

   Зачем отдельный файл: до сих пор приложение показывало события только
   пока оно открыто. Закрыл — и о новой заявке, принятой работе или
   выплате человек узнавал, когда сам заходил. Чтобы уведомление дошло до
   закрытого приложения, его должен отправить СЕРВЕР — это и есть web
   push. Здесь он собран целиком, без сторонних библиотек: всё, что нужно,
   есть во встроенном crypto (Node 22).

   Как это работает по шагам.
   1. У сервера есть своя пара ключей (VAPID). Открытый ключ забирает
      приложение и подписывается им на уведомления у своего браузера.
   2. Браузер выдаёт «подписку»: адрес его собственного сервиса доставки
      (endpoint) и два ключа, которыми шифруется текст.
   3. Сервер шлёт письмо по этому адресу: тело зашифровано ключами
      подписки, а сам запрос подписан ключом VAPID — чтобы сервис
      доставки знал, что это правда мы.
   4. Сервис доставки будит service worker в телефоне, тот показывает
      уведомление. Приложение при этом может быть закрыто.

   Стандарты: RFC 8291 (шифрование), RFC 8188 (aes128gcm), RFC 8292 (VAPID).

   ВАЖНО ПРО КЛЮЧИ. Пара VAPID создаётся один раз и лежит в
   server/data/vapid.json. Терять её нельзя: подписки привязаны к
   открытому ключу, и с новым ключом все старые перестанут работать —
   людям придётся разрешать уведомления заново.
   ══════════════════════════════════════════════════════════════════════ */

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const b64u = (buf) => Buffer.from(buf).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Buffer.from(String(s || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64');

/* ── Куда вообще можно слать ──────────────────────────────────────────
   АДРЕС ДОСТАВКИ ЗАДАЁТ КЛИЕНТ. Его выдаёт браузер, но приходит он к нам
   строкой в теле запроса — значит, подставить туда можно что угодно. Без
   проверки это готовый инструмент разведки чужой сети: сервер послушно
   постучится по любому адресу, а по коду ответа и времени отправитель
   узнает, что за ним живёт. Одного «только https» тут мало.

   Поэтому список разрешённых служб доставки. Их немного и они известны:
   у каждого браузера своя. Хост либо совпадает с записью, либо является
   её поддоменом — ничего другого не принимаем.

   Отдельно отказываем адресам, где вместо имени стоит сам IP: настоящие
   службы доставки так не выглядят, а вот внутренние адреса — только так.
   Это снимает попадание во внутреннюю сеть напрямую, без обращений к DNS.

   PUSH_HOSTS_EXTRA — щель для проверок: список хостов через запятую.
   На бою её быть не должно, сервер про это предупреждает при запуске. */
const PUSH_HOSTS = [
  'fcm.googleapis.com',                    /* Chrome и всё на Chromium */
  'android.googleapis.com',                /* он же, старый адрес */
  'updates.push.services.mozilla.com',     /* Firefox */
  'push.services.mozilla.com',
  'notify.windows.com',                    /* Edge, Windows */
  'push.services.microsoft.com',
  'web.push.apple.com',                    /* Safari, iOS */
];

function extraHosts(env) {
  return String((env || process.env).PUSH_HOSTS_EXTRA || '')
    .split(/[,\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/* Похоже ли имя хоста на записанный адрес, а не на имя. */
function isIpLiteral(host) {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;      /* 127.0.0.1 */
  if (host.indexOf(':') >= 0) return true;                     /* [::1] уже без скобок */
  return false;
}

/* Возвращает причину отказа или '' — если адрес годится. */
function endpointWhyBad(endpoint, env) {
  let u;
  try { u = new URL(String(endpoint || '')); } catch (e) { return 'адрес не разбирается'; }
  if (u.protocol !== 'https:') return 'адрес не по https';
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (!host) return 'в адресе нет хоста';
  if (isIpLiteral(host)) return 'вместо имени службы доставки стоит адрес';
  const list = PUSH_HOSTS.concat(extraHosts(env));
  const okHost = list.some((a) => host === a || host.endsWith('.' + a));
  if (!okHost) return 'неизвестная служба доставки: ' + host;
  return '';
}
function endpointOk(endpoint, env) { return endpointWhyBad(endpoint, env) === ''; }

/* ── Пара ключей сервера ──────────────────────────────────────────── */

let KEYS = null;

function keyFile(dbPath) {
  return path.join(path.dirname(dbPath), 'vapid.json');
}

/* Читаем с диска или создаём. Формат — JWK: из него легко собрать и
   объект для подписи, и «сырой» открытый ключ для браузера. */
function keys(dbPath) {
  if (KEYS) return KEYS;
  const file = keyFile(dbPath);
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (j && j.publicJwk && j.privateJwk) {
      KEYS = build(j.publicJwk, j.privateJwk);
      return KEYS;
    }
  } catch (e) { /* нет файла — создадим ниже */ }

  const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicJwk = pair.publicKey.export({ format: 'jwk' });
  const privateJwk = pair.privateKey.export({ format: 'jwk' });
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ publicJwk, privateJwk }, null, 2), { mode: 0o600 });
  } catch (e) {
    console.error('[push] не удалось сохранить ключи VAPID: ' + (e && e.message));
  }
  KEYS = build(publicJwk, privateJwk);
  return KEYS;
}

function build(publicJwk, privateJwk) {
  /* Открытый ключ для браузера — несжатая точка: 0x04 || X || Y. */
  const raw = Buffer.concat([Buffer.from([4]), unb64u(publicJwk.x), unb64u(publicJwk.y)]);
  return {
    publicRaw: raw,
    publicB64: b64u(raw),
    privateKey: crypto.createPrivateKey({ key: privateJwk, format: 'jwk' }),
    privateRaw: unb64u(privateJwk.d),
  };
}

/* ── Подпись запроса (VAPID) ──────────────────────────────────────── */

function vapidHeader(endpoint, subject, k) {
  const aud = new URL(endpoint).origin;
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const body = b64u(JSON.stringify({
    aud,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: subject,
  }));
  /* Подпись обязана быть «сырой» парой r||s, а не DER — иначе сервисы
     доставки отвечают 401. Node умеет это сам: ieee-p1363. */
  const sig = crypto.sign('sha256', Buffer.from(head + '.' + body), {
    key: k.privateKey,
    dsaEncoding: 'ieee-p1363',
  });
  return 'vapid t=' + head + '.' + body + '.' + b64u(sig) + ', k=' + k.publicB64;
}

/* ── Шифрование тела (RFC 8291, aes128gcm) ────────────────────────── */

function encrypt(payload, uaPublicB64, authB64) {
  const uaPublic = unb64u(uaPublicB64);
  const auth = unb64u(authB64);
  if (uaPublic.length !== 65 || auth.length !== 16) throw new Error('Ключи подписки неверной длины');

  /* Разовая пара ключей на каждое сообщение. */
  const ecdh = crypto.createECDH('prime256v1');
  const asPublic = ecdh.generateKeys();
  const shared = ecdh.computeSecret(uaPublic);

  /* Общий ключ выводим из ECDH и секрета подписки. */
  const keyInfo = Buffer.concat([
    Buffer.from('WebPush: info\0', 'utf8'), uaPublic, asPublic,
  ]);
  const ikm = crypto.hkdfSync('sha256', shared, auth, keyInfo, 32);

  const salt = crypto.randomBytes(16);
  const cek = crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16);
  const nonce = crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12);

  /* Текст + разделитель записи (0x02 — последняя запись). */
  const plain = Buffer.concat([Buffer.from(payload, 'utf8'), Buffer.from([2])]);
  const cipher = crypto.createCipheriv('aes-128-gcm', Buffer.from(cek), Buffer.from(nonce));
  const body = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);

  /* Заголовок записи: соль, размер записи, длина ключа и сам ключ. */
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096, 0);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

/* ── Отправка одной подписке ──────────────────────────────────────── */

/* Возвращает { ok, status }. Никогда не бросает: уведомление не должно
   ронять то действие, ради которого оно посылается.
   410 и 404 от сервиса доставки значат «подписки больше нет» — такую
   строку вызывающий обязан удалить, иначе она будет висеть вечно. */
async function sendOne(sub, payload, opts) {
  const o = opts || {};
  try {
    /* Проверяем адрес ЕЩЁ РАЗ, перед самой отправкой. Первый раз это
       делается при подписке, но строка с тех пор могла попасть в базу
       другим путём или список разрешённых служб мог измениться. Правило
       одно: сервер стучится только туда, куда ему разрешено. */
    const why = endpointWhyBad(sub && sub.endpoint, o.env);
    if (why) return { ok: false, status: 0, error: why, gone: true };

    const k = keys(o.dbPath || './data/bloggerpay.db');
    const data = encrypt(payload, sub.p256dh, sub.auth);
    const res = await fetch(sub.endpoint, {
      method: 'POST',
      headers: {
        'Authorization': vapidHeader(sub.endpoint, o.subject || 'mailto:admin@bloggerpay', k),
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        'TTL': String(o.ttl || 86400),
        'Urgency': o.urgency || 'normal',
      },
      body: data,
      /* Перенаправлениям не следуем: ответ 302 от разрешённой службы увёл
         бы запрос на любой другой адрес — и весь список разрешённых
         обошёлся бы одной строкой в заголовке Location. */
      redirect: 'manual',
      signal: AbortSignal.timeout(12000),
    });
    return { ok: res.ok, status: res.status, gone: res.status === 404 || res.status === 410 };
  } catch (e) {
    return { ok: false, status: 0, error: (e && e.message) || String(e), gone: false };
  }
}

module.exports = { keys, sendOne, b64u, endpointOk, endpointWhyBad, PUSH_HOSTS };
