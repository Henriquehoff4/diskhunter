import { AGE_NAMES, CATEGORY_NAMES, RISK_NAMES, formatBytes, formatCount, formatDateTime, formatDate } from './format';
import type { CleanupPayload, DupPage, Item, ModelsPayload, ScanSummary, StatsPayload } from './types';

export interface ReportData {
  generatedAt: number;
  summary: ScanSummary;
  stats: StatsPayload;
  topFiles: Item[];
  topDirs: Item[];
  cleanup: CleanupPayload;
  duplicates: DupPage | null;
  models: ModelsPayload;
}

const fullPath = (item: Item): string => (item.dir ? `${item.dir.replace(/\\$/, '')}\\${item.name}` : item.name);

export function escapeCsv(value: string | number): string {
  let text = String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  if (/[";\n\r]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function escapeHtml(value: string | number): string {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

function csvSection(title: string, header: string[], rows: (string | number)[][]): string {
  return [escapeCsv(title), header.map(escapeCsv).join(';'), ...rows.map((row) => row.map(escapeCsv).join(';'))].join('\r\n');
}

export function buildCsv(data: ReportData): string {
  const sections = [
    csvSection('Resumo', ['Item', 'Valor'], [
      ['Local', data.summary.path],
      ['Em disco (bytes)', data.summary.alloc],
      ['Tamanho lógico (bytes)', data.summary.size],
      ['Arquivos', data.summary.files],
      ['Sem acesso', data.summary.errors],
      ['Análise concluída', data.summary.cancelled ? 'não, cancelada' : 'sim'],
    ]),
    csvSection('Maiores arquivos', ['Caminho', 'Em disco (bytes)', 'Modificado'], data.topFiles.map((f) => [fullPath(f), f.alloc, formatDate(f.mtime)])),
    csvSection('Maiores pastas', ['Caminho', 'Em disco (bytes)', 'Arquivos'], data.topDirs.map((f) => [fullPath(f), f.alloc, f.files])),
    csvSection('Tipos de arquivo', ['Categoria', 'Em disco (bytes)', 'Arquivos'], data.stats.categories.map((c) => [CATEGORY_NAMES[c.cat], c.bytes, c.count])),
    csvSection('Recomendações de limpeza', ['Recomendação', 'Risco', 'Estimativa (bytes)', 'Itens'], data.cleanup.items.map((r) => [r.title, RISK_NAMES[r.risk], r.bytes, r.count])),
    csvSection('Modelos de IA', ['Nome', 'Formato', 'Tamanho (bytes)', 'Caminho'], data.models.items.map((m) => [m.name, m.format, m.size, m.path])),
  ];
  if (data.duplicates) {
    sections.push(csvSection('Duplicatas', ['Hash SHA-256', 'Tamanho (bytes)', 'Caminho'], data.duplicates.items.flatMap((g) => g.files.map((f) => [g.hash, g.size, fullPath(f)]))));
  }
  return `﻿${sections.join('\r\n\r\n')}\r\n`;
}

export function buildJson(data: ReportData): string {
  return JSON.stringify(data, null, 2);
}

function table(headers: string[], rows: string[][], numeric: number[] = []): string {
  if (rows.length === 0) return '<p class="empty">Nada encontrado.</p>';
  const head = headers.map((h, i) => `<th${numeric.includes(i) ? ' class="n"' : ''}>${escapeHtml(h)}</th>`).join('');
  const body = rows.map((row) => `<tr>${row.map((c, i) => `<td${numeric.includes(i) ? ' class="n"' : ''}>${escapeHtml(c)}</td>`).join('')}</tr>`).join('');
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

export function buildHtml(data: ReportData): string {
  const { summary } = data;
  const css = `body{margin:0 auto;max-width:1040px;padding:40px 32px;background:#171719;color:#fff;font:14px/1.5 "Segoe UI",system-ui,sans-serif}h1{font-size:26px;font-weight:600;margin:0 0 4px}h2{font-size:18px;font-weight:600;margin:40px 0 12px}p{color:#bdbdc0;margin:0}.lead{margin-bottom:24px}dl{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:16px;margin:24px 0}dt{color:#8a8c92;font-size:12px}dd{margin:0;font-size:20px;font-variant-numeric:tabular-nums}table{width:100%;border-collapse:collapse;table-layout:fixed}th{color:#8a8c92;font-weight:500;text-align:left;padding:6px 8px;border-bottom:1px solid #3a3a3e}td{padding:6px 8px;border-bottom:1px solid #222224;word-break:break-all;vertical-align:top}.n{text-align:right;font-variant-numeric:tabular-nums;width:120px;word-break:normal}.empty{color:#8a8c92}@media print{body{background:#fff;color:#000}p,dt,th{color:#444}td,th{border-color:#ccc}}`;
  const parts = [
    `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>${escapeHtml(`DiskHunter: ${summary.path}`)}</title><style>${css}</style></head><body>`,
    `<h1>Relatório do DiskHunter</h1><p class="lead">${escapeHtml(summary.path)}, gerado em ${escapeHtml(formatDateTime(data.generatedAt))}${summary.cancelled ? '. A análise foi cancelada; os números estão incompletos.' : '.'}</p>`,
    `<dl><div><dt>Em disco</dt><dd>${formatBytes(summary.alloc)}</dd></div><div><dt>Arquivos</dt><dd>${formatCount(summary.files)}</dd></div><div><dt>Recuperável (estimativa)</dt><dd>${formatBytes(data.cleanup.recoverable)}</dd></div>${data.duplicates ? `<div><dt>Em duplicatas</dt><dd>${formatBytes(data.duplicates.wasted)}</dd></div>` : ''}<div><dt>Pastas sem acesso</dt><dd>${formatCount(summary.errors)}</dd></div></dl>`,
    '<h2>Recomendações de limpeza</h2>',
    table(['Recomendação', 'Risco', 'Itens', 'Estimativa'], data.cleanup.items.map((r) => [r.title, RISK_NAMES[r.risk], formatCount(r.count), formatBytes(r.bytes)]), [2, 3]),
    '<h2>Maiores arquivos</h2>',
    table(['Caminho', 'Modificado', 'Em disco'], data.topFiles.map((f) => [fullPath(f), formatDate(f.mtime), formatBytes(f.alloc)]), [2]),
    '<h2>Maiores pastas</h2>',
    table(['Caminho', 'Arquivos', 'Em disco'], data.topDirs.map((f) => [fullPath(f), formatCount(f.files), formatBytes(f.alloc)]), [1, 2]),
    '<h2>Tipos de arquivo</h2>',
    table(['Categoria', 'Arquivos', 'Em disco'], [...data.stats.categories].sort((a, b) => b.bytes - a.bytes).map((c) => [CATEGORY_NAMES[c.cat], formatCount(c.count), formatBytes(c.bytes)]), [1, 2]),
    '<h2>Idade dos arquivos</h2>',
    table(['Última alteração', 'Arquivos', 'Em disco'], data.stats.ages.map((a) => [AGE_NAMES[a.bucket], formatCount(a.count), formatBytes(a.bytes)]), [1, 2]),
    '<h2>Modelos de IA</h2>',
    table(['Modelo', 'Formato', 'Caminho', 'Tamanho'], data.models.items.map((m) => [m.name, m.format, m.path, formatBytes(m.size)]), [3]),
  ];
  if (data.duplicates) {
    parts.push('<h2>Duplicatas confirmadas byte a byte</h2>');
    parts.push(table(['Caminho', 'SHA-256', 'Tamanho'], data.duplicates.items.flatMap((g) => g.files.map((f) => [fullPath(f), g.hash.slice(0, 16), formatBytes(g.size)])), [2]));
  }
  parts.push('</body></html>');
  return parts.join('');
}
