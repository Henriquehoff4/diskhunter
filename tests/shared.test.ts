import { describe, expect, it } from 'vitest';
import { formatBytes, formatDelta, formatRelative, parseSize, plural } from '../src/shared/format';
import { buildCsv, buildHtml, buildJson, escapeCsv, escapeHtml, type ReportData } from '../src/shared/report';
import { buildTree, directChildOf, hitTest, layoutTree, neighbor, squarify, type TreeNode } from '../src/shared/treemap';
import type { RawTreemapNode } from '../src/shared/types';

describe('format', () => {
  it('formatBytes usa unidades binárias', () => {
    expect(formatBytes(0)).toMatch(/^0/);
    expect(formatBytes(1536)).toMatch(/1,50?\s*KB/);
    expect(formatBytes(1024 ** 3 * 2)).toMatch(/2(,0+)?\s*GB/);
  });
  it('formatDelta tem sinal', () => {
    expect(formatDelta(1024)).toMatch(/^\+/);
    expect(formatDelta(-1024)).toMatch(/^[-−]/);
  });
  it('parseSize aceita vírgula, ponto e milhares', () => {
    expect(parseSize('100')).toBe(100 * 1048576);
    expect(parseSize('1,5 GB')).toBe(1.5 * 1024 ** 3);
    expect(parseSize('1.5 GB')).toBe(1.5 * 1024 ** 3);
    expect(parseSize('1.024 kb')).toBe(1024 * 1024);
    expect(parseSize('abc')).toBeUndefined();
  });
  it('plural e relativo', () => {
    expect(plural(1, 'item', 'itens')).toMatch(/1 item$/);
    expect(plural(3, 'item', 'itens')).toMatch(/3 itens$/);
    expect(formatRelative(1000 - 86400 * 3, 1000)).toMatch(/3 dias/);
  });
});

const raw = (id: number, parent: number, name: string, size: number, kind = 0, cat = 0): RawTreemapNode => [id, parent, name, size, cat, kind, 0] as unknown as RawTreemapNode;

describe('treemap', () => {
  const sample = [raw(0, -1, 'raiz', 1000, 1), raw(1, 0, 'a', 600, 1), raw(2, 1, 'a1', 400), raw(3, 1, 'a2', 200), raw(4, 0, 'b', 300), raw(5, 0, 'c', 100)];

  it('monta a árvore com pais', () => {
    const root = buildTree(sample) as TreeNode;
    expect(root.children.map((c) => c.name)).toEqual(['a', 'b', 'c']);
    expect(root.children[0].children[0].parent?.name).toBe('a');
  });
  it('squarify preenche o retângulo sem sobrepor', () => {
    const items = [500, 300, 150, 50].map((area, index) => ({ area, node: { id: index } as TreeNode }));
    const total = items.reduce((sum, item) => sum + item.area, 0);
    squarify(items.map((item) => ({ ...item, area: (item.area / total) * 40000 })), 0, 0, 200, 200);
    const nodes = items.map((item) => item.node);
    const sum = nodes.reduce((acc, n) => acc + n.w * n.h, 0);
    expect(sum).toBeCloseTo(40000, 3);
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        const a = nodes[i];
        const b = nodes[j];
        const overlap = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
        expect(overlap).toBeLessThan(0.001);
      }
    }
  });
  it('layout fica dentro da área, áreas proporcionais', () => {
    const root = buildTree(sample) as TreeNode;
    layoutTree(root, 800, 500);
    const [a, b] = root.children;
    expect(a.x + a.w).toBeLessThanOrEqual(800.01);
    expect(a.y + a.h).toBeLessThanOrEqual(500.01);
    expect(a.w * a.h).toBeGreaterThan(b.w * b.h);
  });
  it('hitTest acha a folha e o filho direto da raiz', () => {
    const root = buildTree(sample) as TreeNode;
    layoutTree(root, 800, 500);
    const leaf = root.children[0].children[0];
    const hit = hitTest(root, leaf.x + 4, leaf.y + leaf.h / 2) as TreeNode;
    expect(hit.name).toBe('a1');
    expect(directChildOf(hit, root)?.name).toBe('a');
  });
  it('neighbor anda na direção pedida', () => {
    const root = buildTree(sample) as TreeNode;
    layoutTree(root, 800, 500);
    const [a] = root.children;
    const moved = neighbor(root.children, a, 'right') ?? neighbor(root.children, a, 'down');
    expect(moved).not.toBeNull();
    expect(moved).not.toBe(a);
  });
  it('100 mil nós simulados fazem layout em menos de 1 s', () => {
    const many = [raw(0, -1, 'raiz', 100000, 1)];
    for (let i = 1; i <= 100000; i += 1) many.push(raw(i, 0, `f${i}`, 1));
    const root = buildTree(many) as TreeNode;
    const start = performance.now();
    layoutTree(root, 1600, 900);
    expect(performance.now() - start).toBeLessThan(1000);
  });
});

describe('report', () => {
  const data = {
    generatedAt: 1700000000,
    summary: { path: 'D:\\<x>', isDrive: false, volumeTotal: 0, volumeFree: 0, size: 10, alloc: 10, files: 1, dirs: 1, errors: 0, elapsed: 1, cancelled: false, hardlinks: 0 },
    stats: { categories: [], ages: [], extensions: [], cloud: 0, cloudCount: 0 },
    topFiles: [{ id: 1, name: '=cmd|calc.exe', dir: 'D:\\<x>', size: 1, alloc: 1, mtime: 0, flags: 0, cat: 0, children: 0 }],
    topDirs: [],
    cleanup: { recoverable: 0, items: [] },
    models: { bytes: 0, items: [] },
    duplicates: null,
  } as unknown as ReportData;

  it('CSV neutraliza fórmulas', () => {
    expect(escapeCsv('=1+1')).toContain("'=");
    expect(buildCsv(data)).not.toMatch(/(^|;)=cmd/m);
  });
  it('HTML escapa nomes', () => {
    expect(escapeHtml('<b>')).toBe('&lt;b&gt;');
    expect(buildHtml(data)).not.toContain('<x>');
  });
  it('JSON é válido', () => {
    expect(JSON.parse(buildJson(data)).summary.path).toBe('D:\\<x>');
  });
});
