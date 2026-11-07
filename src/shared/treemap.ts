import type { RawTreemapNode } from './types';

export interface TreeNode {
  id: number;
  name: string;
  size: number;
  cat: number;
  kind: number;
  hidden: number;
  parent: TreeNode | null;
  children: TreeNode[];
  x: number;
  y: number;
  w: number;
  h: number;
  depth: number;
  header: boolean;
}

export const KIND_FILE = 0;
export const KIND_DIR = 1;
export const KIND_REST = 2;

export function buildTree(raw: RawTreemapNode[]): TreeNode | null {
  if (raw.length === 0) return null;
  const nodes: TreeNode[] = new Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) {
    const [id, parent, name, size, cat, kind, hidden] = raw[i];
    const node: TreeNode = { id, name, size, cat, kind, hidden, parent: null, children: [], x: 0, y: 0, w: 0, h: 0, depth: 0, header: false };
    nodes[i] = node;
    if (parent >= 0) {
      node.parent = nodes[parent];
      node.depth = nodes[parent].depth + 1;
      nodes[parent].children.push(node);
    }
  }
  return nodes[0];
}

export interface LayoutOptions {
  headerHeight: number;
  minHeaderWidth: number;
  minHeaderHeight: number;
  gap: number;
  pad: number;
  minArea: number;
}

export const DEFAULT_LAYOUT: LayoutOptions = {
  headerHeight: 19,
  minHeaderWidth: 56,
  minHeaderHeight: 44,
  gap: 1,
  pad: 2,
  minArea: 2,
};

function worst(sum: number, min: number, max: number, side: number): number {
  const squared = side * side;
  const total = sum * sum;
  return Math.max((squared * max) / total, total / (squared * min));
}

export function squarify(items: { area: number; node: TreeNode }[], x: number, y: number, w: number, h: number): void {
  let cx = x;
  let cy = y;
  let cw = w;
  let ch = h;
  let start = 0;
  while (start < items.length && cw > 0 && ch > 0) {
    const side = Math.min(cw, ch);
    let end = start;
    let sum = 0;
    let min = Infinity;
    let max = 0;
    let best = Infinity;
    while (end < items.length) {
      const area = items[end].area;
      const nextSum = sum + area;
      const nextMin = Math.min(min, area);
      const nextMax = Math.max(max, area);
      const score = worst(nextSum, nextMin, nextMax, side);
      if (end > start && score > best) break;
      best = score;
      sum = nextSum;
      min = nextMin;
      max = nextMax;
      end += 1;
    }
    const horizontal = cw >= ch;
    const thickness = side > 0 ? sum / side : 0;
    let offset = 0;
    for (let i = start; i < end; i += 1) {
      const length = thickness > 0 ? items[i].area / thickness : 0;
      const node = items[i].node;
      if (horizontal) {
        node.x = cx;
        node.y = cy + offset;
        node.w = thickness;
        node.h = length;
      } else {
        node.x = cx + offset;
        node.y = cy;
        node.w = length;
        node.h = thickness;
      }
      offset += length;
    }
    if (horizontal) {
      cx += thickness;
      cw -= thickness;
    } else {
      cy += thickness;
      ch -= thickness;
    }
    start = end;
  }
}

export function layoutTree(root: TreeNode, width: number, height: number, options: LayoutOptions = DEFAULT_LAYOUT): void {
  root.x = 0;
  root.y = 0;
  root.w = width;
  root.h = height;
  root.header = false;
  layoutChildren(root, 0, 0, width, height, options);
}

function layoutChildren(node: TreeNode, x: number, y: number, w: number, h: number, options: LayoutOptions): void {
  const kids = node.children;
  if (kids.length === 0 || w <= 0 || h <= 0) return;
  const total = kids.reduce((sum, kid) => sum + kid.size, 0);
  if (total <= 0) return;
  const scale = (w * h) / total;
  const items = kids.map((kid) => ({ area: kid.size * scale, node: kid })).sort((a, b) => b.area - a.area);
  squarify(items, x, y, w, h);
  for (const kid of kids) {
    if (kid.kind !== KIND_DIR || kid.children.length === 0) continue;
    const showHeader = kid.w >= options.minHeaderWidth && kid.h >= options.minHeaderHeight;
    kid.header = showHeader;
    const top = showHeader ? options.headerHeight : options.pad;
    const innerW = kid.w - options.pad * 2;
    const innerH = kid.h - top - options.pad;
    if (innerW * innerH < options.minArea) continue;
    layoutChildren(kid, kid.x + options.pad, kid.y + top, innerW, innerH, options);
  }
}

export function hitTest(root: TreeNode, px: number, py: number): TreeNode | null {
  if (px < root.x || py < root.y || px > root.x + root.w || py > root.y + root.h) return null;
  let current = root;
  while (true) {
    let next: TreeNode | null = null;
    for (const kid of current.children) {
      if (kid.w <= 0 || kid.h <= 0) continue;
      if (px >= kid.x && px < kid.x + kid.w && py >= kid.y && py < kid.y + kid.h) {
        next = kid;
        break;
      }
    }
    if (!next) return current;
    current = next;
  }
}

export function directChildOf(node: TreeNode | null, root: TreeNode): TreeNode | null {
  let current = node;
  while (current && current.parent && current.parent !== root) current = current.parent;
  return current && current.parent === root ? current : null;
}

export function neighbor(items: TreeNode[], from: TreeNode, direction: 'left' | 'right' | 'up' | 'down'): TreeNode | null {
  const cx = from.x + from.w / 2;
  const cy = from.y + from.h / 2;
  let best: TreeNode | null = null;
  let bestScore = Infinity;
  for (const item of items) {
    if (item === from || item.w <= 0 || item.h <= 0) continue;
    const ix = item.x + item.w / 2;
    const iy = item.y + item.h / 2;
    const dx = ix - cx;
    const dy = iy - cy;
    const along = direction === 'left' ? -dx : direction === 'right' ? dx : direction === 'up' ? -dy : dy;
    if (along <= 0) continue;
    const across = direction === 'left' || direction === 'right' ? Math.abs(dy) : Math.abs(dx);
    const score = along + across * 2;
    if (score < bestScore) {
      bestScore = score;
      best = item;
    }
  }
  return best;
}
