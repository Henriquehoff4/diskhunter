import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const exe = path.join(root, 'release', 'win-unpacked', 'DiskHunter.exe');
if (!existsSync(exe)) {
  console.error('Rode npm run dist antes.');
  process.exit(1);
}
const base = mkdtempSync(path.join(os.tmpdir(), 'diskhunter-pack-'));
const fixture = path.join(base, 'fixture');
const userData = path.join(base, 'userdata');
const put = (relative, content) => {
  const target = path.join(fixture, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
};
const dup = Buffer.alloc(80000, 7);
put('a\\foto.bin', dup);
put('b\\foto.bin', dup);
put('c\\capa.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/AAwAEAQH/7yNaRwAAAABJRU5ErkJggg==', 'base64'));
const gguf = Buffer.alloc(1200000);
gguf.write('GGUF');
gguf.writeUInt32LE(3, 4);
put('m\\modelo.gguf', gguf);
execFileSync('cmd.exe', ['/c', 'mklink', '/J', path.join(fixture, 'a', 'laco'), fixture], { stdio: 'ignore' });

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'OK   ' : 'FALHA'} ${name}${detail ? ` | ${detail}` : ''}`);
};
const guard = setTimeout(() => {
  console.error('Limite de 30 s atingido.');
  process.exit(1);
}, 30000);

const app = await electron.launch({
  executablePath: exe,
  args: [`--user-data-dir=${userData}`],
  timeout: 20000,
  env: { ...process.env, DISKHUNTER_TEST: '1', DISKHUNTER_AUTO_CONFIRM: '1', DISKHUNTER_EXPORT_DIR: base, DISKHUNTER_USER_DATA: path.join(base, 'ignorar') },
});
const page = await app.firstWindow();
page.setDefaultTimeout(10000);
const problems = [];
page.on('pageerror', (error) => problems.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error' && !/Failed to load resource|ERR_/.test(message.text())) problems.push(message.text());
});
const call = (cmd, args = {}) => page.evaluate(([c, a]) => window.diskhunter.call(c, a), [cmd, args]);
const scan = (args) => page.evaluate((a) => new Promise((resolve, reject) => {
  const stop = window.diskhunter.onEvent((event) => {
    if (event.event === 'scan.done') { stop(); resolve(event.data); }
    if (event.event === 'scan.failed') { stop(); reject(new Error(event.data.message)); }
  });
  window.diskhunter.call('scan.start', a).catch(reject);
}), args);

await page.waitForSelector('.drive');
const info = await page.evaluate(() => window.diskhunter.info());
check('Roda empacotado e sem modo de teste', info.isPackaged && !info.testMode && info.engineReady !== false);
check('Lista discos com o motor publicado', (await page.locator('.drive').count()) >= 1);

const synthetic = await scan({ path: fixture, synthetic: { files: 500000 } });
check('Modo sintético é ignorado no app instalado', synthetic.files === 4, `arquivos=${synthetic.files}`);
check('Não segue a junção em laço', synthetic.files === 4);
check('Modo de teste não muda a pasta de dados', !existsSync(path.join(base, 'ignorar')));

const map = await call('treemap', { id: 0, budget: 500 });
check('Motor publicado responde ao mapa', map.nodes.length >= 5);
const query = await call('query', { filter: { kind: 'file', sort: 'size' }, limit: 10 });
check('Motor publicado responde à busca', query.total === 4);
const stats = await call('stats');
check('Motor publicado responde às estatísticas', stats.categories.length > 0);
const cleanup = await call('cleanup', { downloadsDays: 180, installerDays: 30 });
check('Motor publicado responde à limpeza', Array.isArray(cleanup.items));
const models = await call('models');
check('Lê GGUF no motor publicado', models.items.length === 1 && models.items[0].format === 'GGUF');
const snapshots = await call('snapshots.list', { path: fixture });
check('Guarda a análise para comparar depois', snapshots.length === 1);

await page.evaluate((min) => window.diskhunter.call('dups.start', { minSize: min, includeSystem: false }), 1);
let groups = null;
for (let i = 0; i < 40 && !groups?.items?.length; i += 1) {
  await page.waitForTimeout(100);
  groups = await call('dups.page', { limit: 10 });
}
check('Acha duplicatas com o hash publicado', groups?.items?.length === 1 && /^[0-9a-f]{64}$/i.test(groups.items[0].hash));

const id = query.items.find((item) => item.name === 'capa.png').id;
const plan = await page.evaluate((i) => window.diskhunter.planDelete({ ids: [i], permanent: true }), id);
await page.evaluate((token) => window.diskhunter.cancelDelete().then(() => token), plan.token);
check('Planejar não apaga', existsSync(path.join(fixture, 'c', 'capa.png')));

const icon = await app.evaluate(({ BrowserWindow }) => {
  const win = BrowserWindow.getAllWindows()[0];
  return { title: win.getTitle(), sandbox: win.webContents.getLastWebPreferences().sandbox };
});
check('Janela isolada em sandbox', icon.sandbox === true && icon.title === 'DiskHunter');
await page.locator('.nav-item', { hasText: 'Mapa do disco' }).waitFor();
check('Sem erros no console', problems.length === 0, problems.slice(0, 2).join(' / '));

await app.close().catch(() => undefined);
clearTimeout(guard);
try {
  rmSync(base, { recursive: true, force: true, maxRetries: 3 });
} catch {
  console.log(`Fixture não removida: ${base}`);
}
console.log(`${results.filter(Boolean).length}/${results.length} verificações`);
process.exit(results.every(Boolean) ? 0 : 1);
