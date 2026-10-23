import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp, mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {setTimeout as delay} from 'node:timers/promises';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.BDO_NODE_MODULES
  ? require.resolve('playwright', {paths: [process.env.BDO_NODE_MODULES]}) : 'playwright');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const temporary = await mkdtemp(join(tmpdir(), 'bdo-portal-browser-'));
const output = process.env.BDO_PORTAL_REPORT_DIR ?? join(temporary, 'screenshots');
await mkdir(output, {recursive: true});
const base = 'http://127.0.0.1:18693';
assert.equal(await fetch(base + '/api/health').then(() => true).catch(() => false), false, 'test port is occupied');
const server = spawn(process.env.PYTHON ?? 'python', ['-B', '-c',
  `from local_app.backend.app import create_app; create_app(r'${join(temporary, 'isolated.sqlite3')}',testing=True).run(host='127.0.0.1',port=18693,use_reloader=False)`],
  {cwd: root, windowsHide: true, stdio: 'ignore', env: {...process.env, LOCALAPPDATA: temporary, PYTHONDONTWRITEBYTECODE: '1'}});
let browser;
try {
  for (let i = 0; i < 100; i++) {
    if (await fetch(base + '/api/health').then(r => r.ok).catch(() => false)) break;
    assert.equal(server.exitCode, null, 'temporary server exited');
    await delay(100);
  }
  const initial = await (await fetch(base + '/api/bootstrap')).json();
  const name = initial.inventory[0].programName;
  const saved = await fetch(base + '/api/inventory', {method: 'PATCH', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({mutationId: 'portal-seed', baseRevision: initial.revision, kind: 'manual', patch: {items: {[name]: {stock: 37}}}})});
  assert.equal(saved.status, 200);
  const before = await (await fetch(base + '/api/bootstrap')).json();
  browser = await chromium.launch({executablePath: process.env.BDO_CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true});
  const page = await browser.newPage({viewport: {width: 1440, height: 1000}});
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => {if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);});
  await page.goto(base);
  await assert.doesNotReject(() => page.getByRole('heading', {name: '프로그램 선택'}).waitFor());
  await page.screenshot({path: join(output, 'portal-desktop.png'), fullPage: true});
  await page.locator('.barter-card').click();
  await page.waitForFunction(() => document.querySelector('#app-content')?.getAttribute('aria-busy') === 'false');
  assert.equal(new URL(page.url()).pathname, '/barter/');
  assert.equal(await page.locator('.inventory-row').count(), 70);
  await page.getByRole('button', {name: '창고 재고', exact: true}).click();
  assert.equal(await page.getByRole('spinbutton', {name: name + ' 현재 재고', exact: true}).inputValue(), '37');
  await page.screenshot({path: join(output, 'barter-desktop.png'), fullPage: true});
  await page.getByRole('link', {name: '통합 메인으로', exact: true}).click();
  await page.locator('.alchemy-card').click();
  assert.equal(new URL(page.url()).pathname, '/alchemy/');
  await page.getByRole('heading', {name: '제작 대시보드'}).waitFor();
  await page.waitForFunction(() => document.querySelector('#content')?.getAttribute('aria-busy') === 'false');
  await page.reload();
  await page.getByRole('heading', {name: '제작 대시보드'}).waitFor();
  await page.waitForFunction(() => document.querySelector('#content')?.getAttribute('aria-busy') === 'false');
  await page.screenshot({path: join(output, 'alchemy-desktop.png'), fullPage: true});
  await page.getByRole('link', {name: '통합 메인으로', exact: true}).click();
  await page.reload();
  await page.setViewportSize({width: 390, height: 844});
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'portal fits mobile viewport');
  await page.screenshot({path: join(output, 'portal-mobile.png'), fullPage: true});
  await page.locator('.alchemy-card').click();
  await page.waitForFunction(() => document.querySelector('#content')?.getAttribute('aria-busy') === 'false');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'alchemy fits mobile viewport');
  await page.getByRole('link', {name: '물교 작업실 ↗'}).click();
  await page.waitForFunction(() => document.querySelector('#app-content')?.getAttribute('aria-busy') === 'false');
  assert.deepEqual(await (await fetch(base + '/api/bootstrap')).json(), before, 'navigation does not mutate barter state');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ok: true, navigation: 'main → barter → main → alchemy → main; alchemy → barter', reload: true, inventoryPreserved: true, mobileOverflow: false, output}));
} finally {
  await browser?.close();
  if (server.exitCode === null) await new Promise(resolve => {server.once('exit', resolve); server.kill();});
}
