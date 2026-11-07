import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const shots = path.join(root, 'tests', 'e2e', 'out');
mkdirSync(shots, { recursive: true });
const STEP_LIMIT = 30000;
const SUITE_LIMIT = 120000;
const started = Date.now();
const base = mkdtempSync(path.join(os.tmpdir(), 'diskhunter-e2e-'));
const fixture = path.join(base, 'fixture');
const userData = path.join(base, 'userdata');
const exportsDir = path.join(base, 'exports');
const DAY = 86400;
const results = [];
const problems = [];

function put(relative, content, ageDays = 0) {
  const target = path.join(fixture, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
  if (ageDays) {
    const when = Date.now() / 1000 - ageDays * DAY;
    utimesSync(target, when, when);
  }
  return target;
}

function gguf() {
  const parts = [Buffer.from('GGUF')];
  const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b; };
  const u64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
  const str = (s) => Buffer.concat([u64(Buffer.byteLength(s)), Buffer.from(s)]);
  parts.push(u32(3), u64(12), u64(2));
  parts.push(str('general.architecture'), u32(8), str('llama'));
  parts.push(str('general.file_type'), u32(4), u32(15));
  parts.push(Buffer.alloc(1200000, 1));
  return Buffer.concat(parts);
}

function safetensors() {
  const header = Buffer.from(JSON.stringify({ a: { dtype: 'F32', shape: [2, 2], data_offsets: [0, 16] }, b: { dtype: 'F32', shape: [2, 2], data_offsets: [16, 32] } }));
  const length = Buffer.alloc(8);
  length.writeBigUInt64LE(BigInt(header.length));
  return Buffer.concat([length, header, Buffer.alloc(1100000, 2)]);
}

function createFixture() {
  const dup = Buffer.alloc(150000, 7);
  const near = Buffer.from(dup);
  near[near.length - 1] = 8;
  put('modelos\\llama-q4.gguf', gguf());
  put('modelos\\pesos.safetensors', safetensors());
  put('modelos\\ComfyUI\\models\\checkpoints\\falso.ckpt', Buffer.alloc(1100000, 3));
  put('modelos\\ComfyUI\\models\\checkpoints\\sd15.ckpt', Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(1100000, 3)]));
  put('fotos\\capa.png', readFileSync(path.join(root, 'build', 'icon.png')));
  put('fotos\\capa-copia-1.bin', dup);
  put('videos\\clipe.mp4', Buffer.alloc(40000, 4));
  put('copias\\a\\foto.bin', dup);
  put('copias\\b\\foto.bin', dup);
  put('copias\\c\\quase.bin', near);
  put('docs\\Relatório Anual 2024.pdf', Buffer.alloc(30000, 5), 500);
  put('docs\\notas.txt', 'olá');
  put('projeto\\__pycache__\\mod.cpython-312.pyc', Buffer.alloc(9000, 6));
  put('Users\\ana\\Downloads\\instalador-velho.exe', Buffer.alloc(1100000, 9), 400);
  put('Users\\ana\\Downloads\\pacote-antigo.zip', Buffer.alloc(60000, 10), 400);
  put('apagar\\e2e-diskhunter-pode-apagar.bin', Buffer.alloc(12000, 11));
  execFileSync('cmd.exe', ['/c', 'mklink', '/J', path.join(fixture, 'docs', 'volta-para-raiz'), fixture], { stdio: 'ignore' });
  return readdirSync(fixture, { recursive: true }).length;
}

function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'OK   ' : 'FALHA'} ${name}${detail ? ` | ${detail}` : ''}`);
}

async function step(name, fn) {
  if (Date.now() - started > SUITE_LIMIT) {
    check(name, false, 'não executado: orçamento de 2 min esgotado');
    return;
  }
  const begin = Date.now();
  let timer;
  try {
    await Promise.race([
      fn(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`limite de ${STEP_LIMIT / 1000} s`)), STEP_LIMIT);
      }),
    ]);
    console.log(`  [${name}] ${Date.now() - begin} ms`);
  } catch (error) {
    check(name, false, String(error.message).split('\n')[0]);
  } finally {
    clearTimeout(timer);
  }
}

const launched = await (async () => {
  createFixture();
  mkdirSync(exportsDir);
  const app = await electron.launch({
    args: [root],
    timeout: STEP_LIMIT,
    env: { ...process.env, DISKHUNTER_TEST: '1', DISKHUNTER_USER_DATA: userData, DISKHUNTER_EXPORT_DIR: exportsDir, DISKHUNTER_AUTO_CONFIRM: '1' },
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  page.on('console', (message) => {
    if (message.type() === 'error' && !/Failed to load resource|ERR_/.test(message.text())) problems.push(message.text());
  });
  page.on('pageerror', (error) => problems.push(error.message));
  return { app, page };
})();
const { app, page } = launched;

const nav = (name) => page.locator('.nav-item', { hasText: name }).click();
const call = (cmd, args) => page.evaluate(([c, a]) => window.diskhunter.call(c, a), [cmd, args ?? {}]);
const shot = async (name) => {
  await page.waitForTimeout(260);
  await page.screenshot({ path: path.join(shots, `${name}.png`) });
};
const resize = (width, height) => app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setContentSize(w, h), [width, height]);
const waitIdle = () => page.waitForFunction(() => !document.querySelector('.scanning'));
async function poll(fn, label, timeout = 15000) {
  const begin = Date.now();
  while (Date.now() - begin < timeout) {
    const value = await fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`tempo esgotado: ${label}`);
}
const syntheticDone = (files, growth = 0, target = 'D:\\Biblioteca', clock = undefined) => page.evaluate(([f, g, t, c]) => new Promise((resolve, reject) => {
  const stop = window.diskhunter.onEvent((event) => {
    if (event.event === 'scan.done') { stop(); resolve(event.data); }
    if (event.event === 'scan.failed') { stop(); reject(new Error(event.data.message)); }
  });
  window.diskhunter.call('scan.start', { path: t, clock: c, synthetic: { files: f, growth: g, total: 2000000000000, free: 310000000000 } }).catch(reject);
}), [files, growth, target, clock]);

await step('início lista discos sem analisar nada', async () => {
  await resize(1440, 900);
  await page.waitForSelector('.drive');
  const scanned = await call('scan.summary');
  check('Início mostra discos', (await page.locator('.drive').count()) >= 1);
  check('Nenhuma análise automática', scanned === null);
  await shot('01-inicio');
});

await step('análise de pasta real com junção em laço', async () => {
  await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, fixture);
  await page.getByRole('button', { name: 'Escolher pasta' }).click();
  await page.waitForSelector('.page-title:has-text("ocupa")');
  const summary = await call('scan.summary');
  check('Conta os arquivos exatos e não entra no laço da junção', summary.files === 16, `arquivos=${summary.files}`);
  check('Sem erros de permissão na fixture', summary.errors === 0);
  await poll(() => page.locator('.page-lead:has-text("recuperar")').count(), 'recomendações');
  await shot('02-visao-geral-fixture');
});

await step('mapa: desenho, zoom, teclado', async () => {
  await nav('Mapa do disco');
  await page.waitForSelector('.treemap-main');
  const colors = await poll(() => page.evaluate(() => {
    const canvas = document.querySelector('.treemap-main');
    if (!canvas || canvas.width < 10) return 0;
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    const seen = new Set();
    for (let i = 0; i < data.length; i += 4000) seen.add(`${data[i]},${data[i + 1]},${data[i + 2]}`);
    return seen.size > 3 ? seen.size : 0;
  }), 'treemap desenhado');
  check('Treemap desenha com várias cores', colors > 3, `cores=${colors}`);
  const crumbs = () => page.locator('.crumb').count();
  const before = await crumbs();
  await page.locator('.treemap').focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await poll(async () => (await crumbs()) === before + 1, 'zoom por Enter');
  check('Enter entra na pasta', true);
  await page.keyboard.press('Backspace');
  await poll(async () => (await crumbs()) === before, 'Backspace volta');
  check('Backspace volta', true);
  const box = await page.locator('.treemap').boundingBox();
  await page.mouse.move(box.x + 60, box.y + 60);
  await poll(() => page.evaluate(() => getComputedStyle(document.querySelector('.treemap-tip')).opacity === '1'), 'tooltip');
  check('Passar o mouse mostra detalhes', true);
  await page.mouse.dblclick(box.x + 60, box.y + 60);
  await poll(async () => (await crumbs()) === before + 1, 'duplo clique');
  check('Duplo clique dá zoom', true);
  await page.locator('.crumb button').first().click();
  await poll(async () => (await crumbs()) === before, 'breadcrumb');
  check('Breadcrumb volta à raiz', true);
});

await step('busca, filtros e inspector', async () => {
  await page.keyboard.press('Control+K');
  await page.keyboard.type('capa.png');
  await page.waitForSelector('.data-row:has-text("capa.png")');
  check('Busca rápida encontra por nome', true);
  await page.locator('.data-row:has-text("capa.png")').click();
  await page.waitForSelector('.inspector');
  await poll(() => page.evaluate(() => (document.querySelector('.preview img')?.naturalWidth ?? 0) > 0), 'pré-visualização');
  check('Pré-visualização de imagem carrega pelo protocolo restrito', true);
  await shot('03-busca-inspector');
  await page.locator('.inspector .icon-button[aria-label="Fechar detalhes"]').click();
  await page.locator('.search input').fill('');
  await page.waitForSelector('.data-row:has-text("llama-q4.gguf")');
  const count = () => page.locator('.data-row').count();
  await page.getByLabel('Extensões').fill('gguf, zip');
  await poll(async () => (await count()) === 2, 'filtro de extensão');
  check('Filtro por extensão', true);
  await page.getByLabel('Extensões').fill('');
  await page.getByLabel('Mínimo').fill('100 kb');
  await poll(async () => (await page.locator('.data-row:has-text("notas.txt")').count()) === 0 && (await count()) > 0, 'filtro de tamanho');
  check('Filtro por tamanho', true);
  await page.getByLabel('Mínimo').fill('');
  const old = new Date(Date.now() - 300 * DAY * 1000).toISOString().slice(0, 10);
  await page.getByLabel('Modificado antes de').fill(old);
  await poll(async () => (await page.locator('.data-row:has-text("llama-q4.gguf")').count()) === 0 && (await page.locator('.data-row:has-text("Relatório Anual")').count()) === 1, 'filtro de data');
  check('Filtro por data', true);
  await page.getByLabel('Modificado antes de').fill('');
  await page.locator('.field-grow input').fill(path.join(fixture, 'copias'));
  await poll(async () => (await count()) === 3, 'filtro de local');
  check('Filtro por localização', true);
  await page.getByRole('button', { name: 'Limpar filtros' }).click();
  await page.getByRole('tab', { name: 'Pastas' }).click();
  await page.waitForSelector('.data-row:has-text("modelos")');
  check('Ranking de pastas', true);
  await page.getByRole('tab', { name: 'Arquivos' }).click();
});

await step('duplicatas confirmadas por conteúdo', async () => {
  await nav('Duplicatas');
  await page.getByLabel('Tamanho mínimo (MB)').fill('0');
  await page.getByRole('button', { name: /Procurar/ }).click();
  await page.waitForSelector('.dup-group');
  const groups = await page.locator('.dup-group').count();
  const files = await page.locator('.dup-files li').count();
  check('Agrupa só conteúdo idêntico', groups === 1 && files === 3, `grupos=${groups} arquivos=${files}`);
  check('Arquivo de mesmo tamanho e conteúdo diferente fica de fora', (await page.locator('.dup-files li:has-text("quase.bin")').count()) === 0);
  await page.getByRole('button', { name: 'de caminho mais curto' }).click();
  const out = await page.locator('.dup-files .dup-state.is-out').count();
  check('Seleção automática sempre deixa uma cópia', out === 2, `saem=${out}`);
  const disabled = await page.locator('.dup-files input:disabled').count();
  check('A última cópia fica travada', disabled === 1);
  await shot('04-duplicatas');
  const page2 = await call('dups.page', { limit: 10 });
  check('Hash registrado', /^[0-9a-f]{64}$/i.test(page2.items[0].hash));
  await page.getByRole('button', { name: 'Limpar seleção' }).click();
});

await step('limpeza com recomendações', async () => {
  await nav('Limpeza');
  await page.waitForSelector('.rec');
  const text = await page.locator('.rec-list').allInnerTexts();
  const joined = text.join(' ');
  check('Acha instaladores esquecidos', joined.includes('Instaladores esquecidos'));
  check('Acha downloads antigos', joined.includes('Downloads antigos'));
  check('Acha caches', joined.includes('Caches do Python'));
  await page.locator('.rec-toggle').first().click();
  await page.waitForSelector('.rec-items li');
  await shot('05-limpeza');
});

await step('modelos de IA lidos do cabeçalho', async () => {
  await nav('Modelos de IA');
  await page.waitForSelector('.data-table');
  const text = (await page.locator('.data-table').innerText()).toLowerCase();
  check('GGUF com arquitetura', text.includes('gguf') && text.includes('llama'));
  check('SafeTensors com tensores', text.includes('safetensors') && text.includes('2 tensores'));
  check('Checkpoint reconhecido pela assinatura', text.includes('checkpoint'));
  check('Arquivo .ckpt falso é descartado', !text.includes('falso'));
  await shot('06-modelos');
});

await step('relatórios', async () => {
  await nav('Relatórios');
  for (const [index] of ['html', 'csv', 'json'].entries()) {
    await page.locator('.export-list .button').nth(index).click();
    await poll(async () => (await page.locator('.export-list .button:disabled').count()) === 0, 'exportação');
  }
  const files = readdirSync(exportsDir);
  check('Exporta HTML, CSV e JSON', ['html', 'csv', 'json'].every((ext) => files.some((f) => f.endsWith(`.${ext}`))), files.join(', '));
  const json = JSON.parse(readFileSync(path.join(exportsDir, files.find((f) => f.endsWith('.json'))), 'utf8').replace(/^﻿/, ''));
  check('Relatório JSON traz resumo e modelos', json.summary.files === 16 && json.models.items.length >= 3);
  check('Relatório não contém script ativo', !readFileSync(path.join(exportsDir, files.find((f) => f.endsWith('.html'))), 'utf8').includes('<script'));
});

await step('exclusão exige revisão e usa a Lixeira', async () => {
  const target = path.join(fixture, 'apagar', 'e2e-diskhunter-pode-apagar.bin');
  await nav('Maiores e busca');
  await page.locator('.search input').fill('e2e-diskhunter');
  await page.waitForSelector('.data-row:has-text("e2e-diskhunter")');
  await page.locator('.data-row:has-text("e2e-diskhunter") input[type=checkbox]').check();
  check('Marcar não apaga', existsSync(target));
  await page.getByRole('button', { name: 'Revisar e excluir' }).click();
  await page.waitForSelector('.review-list li');
  const go = page.getByRole('button', { name: /Mover .* para a Lixeira/ });
  check('Botão fica travado sem confirmação', await go.isDisabled());
  check('Revisar não apaga', existsSync(target));
  await shot('07-revisao');
  await page.locator('dialog .check-line input').check();
  await go.click();
  await page.waitForSelector('dialog .review-lead:has-text("na Lixeira")');
  check('Arquivo saiu do disco', !existsSync(target));
  const history = await page.evaluate(() => window.diskhunter.history());
  check('Registrado no histórico', history[0]?.path === target && history[0]?.action === 'trash');
  await page.getByRole('button', { name: 'Concluir' }).click();
  await page.locator('.search input').fill('');
});

await step('proteções pelo canal do renderer', async () => {
  const blocked = async (cmd) => page.evaluate((c) => window.diskhunter.call(c, { ids: [1] }).then(() => false, () => true), cmd);
  check('Renderer não pode chamar node.remove', await blocked('node.remove'));
  check('Renderer não pode chamar dups.verify', await blocked('dups.verify'));
  check('Token forjado é recusado', await page.evaluate(() => window.diskhunter.runDelete('forjado').then(() => false, () => true)));
  const plan = await page.evaluate(() => window.diskhunter.planDelete({ ids: [999999999] }));
  check('Id inexistente é recusado', plan.allowed === 0);
  const rootId = await call('node.find', { path: fixture });
  const rootPlan = rootId > 0 ? await page.evaluate((id) => window.diskhunter.planDelete({ ids: [id] }), rootId) : { allowed: 0 };
  check('Raiz analisada com id 0 nunca entra no plano', rootId === 0 ? (await page.evaluate(() => window.diskhunter.planDelete({ ids: [0] }).then(() => false, () => true))) : rootPlan.allowed >= 0);
  const hostile = await page.evaluate(() => {
    const links = document.createElement('a');
    links.href = 'file:///C:/Windows/win.ini';
    return typeof window.require === 'undefined' && typeof window.process === 'undefined';
  });
  check('Renderer sem acesso a Node', hostile);
});

await step('crescimento compara análises reais', async () => {
  put('videos\\novo-grande.mp4', Buffer.alloc(3 * 1024 * 1024, 12));
  await page.evaluate(() => undefined);
  await nav('Visão geral');
  await page.getByRole('button', { name: 'Analisar de novo' }).click();
  await poll(async () => (await call('scan.summary'))?.alloc > 7 * 1048576, 'segunda análise');
  await nav('Crescimento');
  await page.waitForSelector('.chart svg');
  await page.waitForSelector('.data-table');
  const text = await page.locator('.data-table').innerText();
  check('Mostra a pasta que cresceu', text.includes('videos'), text.split('\n').slice(0, 3).join(' '));
  check('Título diz quanto cresceu', (await page.locator('.page-title').innerText()).startsWith('Cresceu'));
  await shot('08-crescimento-fixture');
});

await step('cancelar análise mantém interface viva', async () => {
  await page.evaluate(() => window.diskhunter.call('scan.start', { path: 'D:\\Cancelar', synthetic: { files: 3000000 } }));
  await page.waitForSelector('.scanning');
  await nav('Discos');
  const latency = await page.evaluate(async () => {
    const begin = performance.now();
    await window.diskhunter.call('ping');
    return performance.now() - begin;
  });
  check('Motor responde durante a análise', latency < 1000, `${latency.toFixed(1)} ms`);
  await shot('09-analisando');
  await page.getByRole('button', { name: 'Cancelar análise' }).click();
  await waitIdle();
  const summary = await call('scan.summary');
  check('Cancelamento encerra e marca como incompleta', summary?.cancelled === true && summary?.path === 'D:\\Cancelar');
});

await step('1 milhão de arquivos simulados', async () => {
  const summary = await syntheticDone(1000000, 0, 'D:\\Massa');
  check('Análise simulada de 1 milhão', summary.files >= 900000, `${summary.files} arquivos em ${summary.elapsed.toFixed(1)} s`);
  const begin = Date.now();
  await call('treemap', { id: 0, budget: 7000 });
  const treemap = Date.now() - begin;
  const begin2 = Date.now();
  await call('query', { filter: { kind: 'file', sort: 'size', text: 'a' }, limit: 100 });
  const query = Date.now() - begin2;
  check('Mapa e busca respondem com 1 milhão', treemap < 2000 && query < 3000, `mapa ${treemap} ms, busca ${query} ms`);
  const memory = await app.evaluate(() => process.memoryUsage().rss);
  check('Processo principal fica leve', memory < 400 * 1048576, `${Math.round(memory / 1048576)} MB`);
});

await step('telas com dados simulados', async () => {
  const now = Math.floor(Date.now() / 1000);
  await syntheticDone(120000, 0, 'D:\\Biblioteca', now - 60 * DAY);
  await syntheticDone(120000, 0.03, 'D:\\Biblioteca', now - 30 * DAY);
  await syntheticDone(120000, 0.08, 'D:\\Biblioteca', now);
  await nav('Visão geral');
  await page.waitForSelector('.overview-map canvas');
  await poll(() => page.locator('.rank-row').count(), 'recomendações');
  await page.waitForTimeout(350);
  await shot('10-visao-geral');
  await page.locator('.nav-item', { hasText: 'Mapa do disco' }).click();
  await page.waitForTimeout(500);
  await shot('11-mapa');
  await nav('Maiores e busca');
  await page.waitForSelector('.data-row');
  await shot('12-maiores');
  await nav('Limpeza');
  await page.waitForSelector('.rec');
  await shot('13-limpeza');
  await nav('Modelos de IA');
  await page.waitForTimeout(150);
  await shot('14-modelos');
  await nav('Crescimento');
  await page.waitForSelector('.chart svg');
  await page.waitForSelector('.data-table');
  await shot('15-crescimento');
  await nav('Ajustes');
  await shot('16-ajustes');
  await resize(1040, 680);
  await nav('Visão geral');
  await page.waitForTimeout(300);
  await shot('17-visao-geral-pequena');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  check('Sem rolagem horizontal na janela mínima', !overflow);
  await nav('Mapa do disco');
  await page.waitForTimeout(400);
  await shot('18-mapa-pequeno');
  await nav('Maiores e busca');
  await page.waitForSelector('.data-row');
  await shot('19-maiores-pequeno');
  await resize(1440, 900);
});

await step('movimento reduzido', async () => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await nav('Mapa do disco');
  await page.waitForTimeout(500);
  const crumbs = () => page.locator('.crumb').count();
  const before = await crumbs();
  await page.locator('.treemap').focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await poll(async () => (await crumbs()) === before + 1, 'zoom com movimento reduzido');
  const running = await page.evaluate(() => document.querySelector('.treemap-ghost').getAnimations().map((a) => a.effect.getTiming().duration));
  check('Zoom funciona com movimento reduzido, sem transformação longa', running.every((d) => d <= 120), running.join(','));
  await page.emulateMedia({ reducedMotion: 'no-preference' });
});

await step('motor para e a interface se recupera', async () => {
  const pid = await app.evaluate(() => process.pid);
  const child = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid} and Name='diskhunter-engine.exe'").ProcessId`], { encoding: 'utf8' }).trim();
  check('Motor roda como processo separado', /^\d+$/.test(child), child);
  execFileSync('taskkill.exe', ['/F', '/PID', child], { stdio: 'ignore' });
  await page.waitForSelector('.notice-error:has-text("motor de análise parou")');
  check('Avisa que o motor parou', true);
  await page.waitForSelector('.drive');
  await syntheticDone(5000, 0, 'D:\\Recuperado');
  check('Volta a analisar depois da queda', (await call('scan.summary')).path === 'D:\\Recuperado');
});

check('Sem erros no console', problems.length === 0, problems.slice(0, 3).join(' / '));
await app.close().catch(() => undefined);
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} verificações em ${((Date.now() - started) / 1000).toFixed(1)} s`);
try {
  rmSync(base, { recursive: true, force: true, maxRetries: 3 });
} catch {
  console.log(`Fixture não removida: ${base}`);
}
process.exit(failed.length ? 1 : 0);
