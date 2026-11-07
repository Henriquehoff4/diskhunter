import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const target = process.argv[2];
if (!target || process.argv[3] !== '--sim') {
  console.log('Uso: npm run perf:disk -- <pasta ou disco> --sim');
  console.log('Só lê nomes e tamanhos, não altera nada, e fica de fora da suíte normal. Pode levar minutos em discos grandes.');
  process.exit(target ? 1 : 0);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const engine = [
  path.join(root, 'engine', 'publish', 'diskhunter-engine.exe'),
  path.join(root, 'engine', 'DiskHunter.Engine', 'bin', 'Release', 'net8.0', 'win-x64', 'diskhunter-engine.exe'),
].find(existsSync);
if (!engine) {
  console.error('Motor não encontrado. Rode npm run build:engine.');
  process.exit(1);
}

const data = mkdtempSync(path.join(os.tmpdir(), 'diskhunter-perf-'));
const child = spawn(engine, ['--data', data], { stdio: ['pipe', 'pipe', 'inherit'] });
const lines = createInterface({ input: child.stdout });
let next = 1;
const pending = new Map();
const call = (cmd, args = {}) => new Promise((resolve, reject) => {
  const id = next++;
  pending.set(id, { resolve, reject });
  child.stdin.write(`${JSON.stringify({ id, cmd, args })}\n`);
});

let finished;
const done = new Promise((resolve, reject) => { finished = { resolve, reject }; });
lines.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.event === 'scan.done') finished.resolve(message.data);
  else if (message.event === 'scan.failed') finished.reject(new Error(message.data.message));
  else if (message.event === 'scan.progress') process.stderr.write(`\r${message.data.files} arquivos, ${message.data.elapsed.toFixed(1)} s   `);
  else if (message.id && pending.has(message.id)) {
    const entry = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
    else entry.resolve(message.result);
  }
});

const timed = async (label, fn) => {
  const begin = performance.now();
  await fn();
  console.log(`${label}: ${Math.round(performance.now() - begin)} ms`);
};

try {
  await call('scan.start', { path: target, snapshot: false });
  const summary = await done;
  console.log(`\nArquivos: ${summary.files}, pastas ${summary.nodes - summary.files}, sem acesso ${summary.errors}`);
  console.log(`Tempo: ${summary.elapsed.toFixed(2)} s (${Math.round(summary.files / Math.max(summary.elapsed, 0.001))} arquivos/s)`);
  console.log(`Memória do índice: ${Math.round(summary.memory / 1048576)} MB`);
  await timed('Mapa', () => call('treemap', { id: 0, budget: 7000 }));
  await timed('Maiores arquivos', () => call('query', { filter: { kind: 'file', sort: 'size' }, limit: 100 }));
  await timed('Busca', () => call('query', { filter: { kind: 'file', sort: 'size', text: 'a' }, limit: 100 }));
  await timed('Recomendações', () => call('cleanup', { downloadsDays: 180, installerDays: 30 }));
  await timed('Modelos de IA', () => call('models'));
} finally {
  child.kill();
}
