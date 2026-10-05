/* Картинки заданий: POST /api/media и GET /media/<id>.

   Баннеры, фото товара и обложки больше не едут внутри задания строкой
   base64 — сервер хранит их отдельно. Проверяем: без входа не принять,
   не картинку не принять (даже под видом картинки), большую не принять,
   принятая отдаётся теми же байтами и с долгим кэшем, чужой адрес не
   угадывается.

   Запуск: node test-media.mjs */

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = 8107;
const BASE = 'http://127.0.0.1:' + PORT;

let passed = 0, failed = 0;
function ok(c, name, extra) {
  if (c) { passed++; console.log('  ok  ' + name); }
  else { failed++; console.log('  FAIL ' + name + (extra ? '  ← ' + JSON.stringify(extra).slice(0, 240) : '')); }
}

const dir = mkdtempSync(path.join(tmpdir(), 'bp-media-'));
const srv = spawn(process.execPath, ['server.js'], {
  cwd: fileURLToPath(new URL('.', import.meta.url)),
  env: {
    ...process.env, PORT: String(PORT), DB_PATH: path.join(dir, 'db.sqlite'),
    ADMIN_KEY: 'test-key-media', ADMIN_EMAIL: '', BOT_TOKEN: '', ADMIN_CHAT_ID: '',
    RESEND_API_KEY: '', TEST_TOPUP: '1', YOOKASSA_SHOP_ID: '', YOOKASSA_SECRET_KEY: '',
  },
  stdio: 'ignore',
});
async function up() {
  for (let i = 0; i < 40; i++) {
    try { const r = await get(BASE + '/api/health'); if (r.ok) return true; } catch (e) {}
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}
async function api(method, p, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const r = await fetch(BASE + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let j = {}; try { j = await r.json(); } catch (e) {}
  return { status: r.status, body: j };
}

/* Ответ дочитываем до конца: недочитанное тело при выходе роняет libuv на Windows */
async function get(u, opt) { const r = await fetch(u, opt); try { await r.arrayBuffer(); } catch (e) {} return r; }

/* Самая маленькая настоящая картинка PNG 1×1 */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
/* JPEG: SOI + немного данных — серверу важны первые байты */
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2000, 7), Buffer.from([0xff, 0xd9])]);
const url = (mime, buf) => 'data:' + mime + ';base64,' + buf.toString('base64');

try {
  console.log('\nКартинки заданий');
  ok(await up(), 'сервер поднялся');

  const tag = Date.now().toString(36);
  const A = await api('POST', '/api/register', { email: 'ma' + tag + '@t.ru', name: 'Олег', role: 'advertiser', password: 'парольДлинный12' });
  const T = A.body.token;
  ok(!!T, 'рекламодатель заведён', A.body);

  ok((await api('POST', '/api/media', { data: url('image/png', PNG) })).status === 401, 'без входа картинку не принять');

  const bad = await api('POST', '/api/media', { data: 'data:text/html;base64,' + Buffer.from('<b>x</b>').toString('base64') }, T);
  ok(bad.status === 400, 'не картинку не принять', bad.body);

  const fake = await api('POST', '/api/media', { data: url('image/png', Buffer.from('<script>alert(1)</script>')) }, T);
  ok(fake.status === 400 && /не похож/.test(fake.body.error || ''), 'текст под видом PNG не принять', fake.body);

  const big = await api('POST', '/api/media', { data: url('image/jpeg', Buffer.concat([JPG.slice(0, 4), Buffer.alloc(1024 * 1024 + 10, 1)])) }, T);
  ok(big.status === 400 || big.status === 413, 'картинку больше 1 МБ не принять', big.body);

  const p = await api('POST', '/api/media', { data: url('image/png', PNG) }, T);
  ok(p.status === 200 && /^\/media\/[a-f0-9]{32}$/.test(p.body.url || ''), 'PNG принят, выдан адрес', p.body);

  const g = await fetch(BASE + p.body.url);
  const gb = Buffer.from(await g.arrayBuffer());
  ok(g.status === 200, 'картинка отдаётся без входа');
  ok(g.headers.get('content-type') === 'image/png', 'тип взят из байтов', g.headers.get('content-type'));
  ok(gb.equals(PNG), 'байты те же');
  ok(/immutable/.test(g.headers.get('cache-control') || ''), 'долгий кэш', g.headers.get('cache-control'));
  ok(g.headers.get('x-content-type-options') === 'nosniff', 'nosniff стоит');

  /* Подпись говорит «png», а внутри JPEG — верим байтам */
  const j = await api('POST', '/api/media', { data: url('image/png', JPG) }, T);
  const jg = await get(BASE + j.body.url);
  ok(j.status === 200 && jg.headers.get('content-type') === 'image/jpeg', 'JPEG под подписью png отдан как jpeg', j.body);

  const head = await get(BASE + p.body.url, { method: 'HEAD' });
  ok(head.status === 200 && Number(head.headers.get('content-length')) === PNG.length, 'HEAD отвечает размером');

  ok((await get(BASE + '/media/' + '0'.repeat(32))).status === 404, 'несуществующая — 404');
  ok((await get(BASE + '/media/../server.js')).status === 404, 'путь наружу не открывается');
  ok((await get(BASE + '/media/ABC')).status === 404, 'кривой адрес — 404');
} catch (e) {
  failed++; console.log('  FAIL исключение: ' + (e && e.stack || e));
} finally {
  /* ждём, пока сервер закроется: выход с живым дочерним процессом роняет
     libuv на Windows (Assertion … async.c) уже после итога */
  await new Promise((r) => { srv.once('exit', r); try { srv.kill(); } catch (e) { r(); } setTimeout(r, 2000); });
}
console.log('\nИтого: ' + passed + ' ok, ' + failed + ' FAIL');
/* без process.exit: дожидаемся, пока закроются соединения, — резкий выход
   посреди их закрытия роняет libuv на Windows уже после итога */
process.exitCode = failed ? 1 : 0;
