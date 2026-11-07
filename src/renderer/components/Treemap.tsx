import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type WheelEvent } from 'react';
import { CATEGORY_NAMES, formatBytes, formatCount } from '../../shared/format';
import { DEFAULT_LAYOUT, KIND_DIR, KIND_FILE, KIND_REST, buildTree, directChildOf, hitTest, layoutTree, neighbor, type TreeNode } from '../../shared/treemap';
import type { TreemapPayload } from '../../shared/types';
import { CATEGORY_COLORS, api, isCancelled } from '../state';
import { useSize, usePrefersReducedMotion } from './ui';

const SURFACE = [19, 18, 23];
const EASE = 'cubic-bezier(0.23, 1, 0.32, 1)';

function mix(hex: string, amount: number): string {
  const value = parseInt(hex.slice(1), 16);
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  return `rgb(${Math.round(r * amount + SURFACE[0] * (1 - amount))},${Math.round(g * amount + SURFACE[1] * (1 - amount))},${Math.round(b * amount + SURFACE[2] * (1 - amount))})`;
}

const FILLS = CATEGORY_COLORS.map((color) => mix(color, 0.72));
const DIM_FILLS = CATEGORY_COLORS.map((color) => mix(color, 0.16));
const DIR_FILLS = ['#141318', '#1b1b20', '#212126', '#27272d', '#2c2c33'];

function fit(ctx: CanvasRenderingContext2D, text: string, width: number): string | null {
  if (width < 18) return null;
  if (ctx.measureText(text).width <= width) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (ctx.measureText(`${text.slice(0, mid)}…`).width <= width) low = mid;
    else high = mid - 1;
  }
  return low >= 2 ? `${text.slice(0, low)}…` : null;
}

function paint(canvas: HTMLCanvasElement, root: TreeNode, width: number, height: number, ratio: number, highlight: number | null): void {
  canvas.width = Math.max(1, Math.round(width * ratio));
  canvas.height = Math.max(1, Math.round(height * ratio));
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) return;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.fillStyle = '#131217';
  ctx.fillRect(0, 0, width, height);
  ctx.textBaseline = 'middle';
  const gap = DEFAULT_LAYOUT.gap;

  const draw = (node: TreeNode, level: number) => {
    for (const kid of node.children) {
      const w = kid.w - gap;
      const h = kid.h - gap;
      if (w < 0.6 || h < 0.6) continue;
      if (kid.kind === KIND_DIR && kid.children.length > 0) {
        ctx.fillStyle = DIR_FILLS[Math.min(level, DIR_FILLS.length - 1)];
        ctx.fillRect(kid.x, kid.y, w, h);
        if (kid.header) {
          ctx.font = '600 11.5px "Public Sans Variable", sans-serif';
          ctx.fillStyle = '#f2f2f3';
          const sizeText = formatBytes(kid.size);
          const sizeWidth = ctx.measureText(sizeText).width;
          const label = fit(ctx, kid.name, w - sizeWidth - 16);
          if (label) ctx.fillText(label, kid.x + 5, kid.y + 10);
          ctx.font = '400 11px "Public Sans Variable", sans-serif';
          ctx.fillStyle = '#aeb0b6';
          if (w > sizeWidth + 34) ctx.fillText(sizeText, kid.x + w - sizeWidth - 5, kid.y + 10);
        }
        draw(kid, level + 1);
        continue;
      }
      if (kid.kind === KIND_REST) ctx.fillStyle = '#2a2a30';
      else if (kid.kind === KIND_DIR) ctx.fillStyle = '#34343b';
      else ctx.fillStyle = highlight !== null && kid.cat !== highlight ? DIM_FILLS[kid.cat] : FILLS[kid.cat];
      ctx.fillRect(kid.x, kid.y, w, h);
      if (w >= 44 && h >= 17) {
        ctx.font = '500 11.5px "Public Sans Variable", sans-serif';
        const name = kid.kind === KIND_REST ? `${formatCount(kid.hidden)} menores` : kid.name;
        ctx.fillStyle = highlight !== null && kid.cat !== highlight && kid.kind === KIND_FILE ? '#8a8c92' : '#ffffff';
        const label = fit(ctx, name, w - 10);
        if (label) ctx.fillText(label, kid.x + 5, kid.y + 10);
        if (h >= 32) {
          ctx.font = '400 11px "Public Sans Variable", sans-serif';
          ctx.fillStyle = highlight !== null && kid.cat !== highlight && kid.kind === KIND_FILE ? '#8a8c92' : 'rgba(255,255,255,0.82)';
          const size = fit(ctx, formatBytes(kid.size), w - 10);
          if (size) ctx.fillText(size, kid.x + 5, kid.y + 24);
        }
      }
    }
  };
  draw(root, 0);
}

function outline(ctx: CanvasRenderingContext2D, node: TreeNode, color: string, line: number): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = line;
  ctx.strokeRect(node.x + line / 2, node.y + line / 2, Math.max(0, node.w - DEFAULT_LAYOUT.gap - line), Math.max(0, node.h - DEFAULT_LAYOUT.gap - line));
}

function findById(root: TreeNode, id: number): TreeNode | null {
  const stack = [root];
  while (stack.length) {
    const node = stack.pop() as TreeNode;
    if (node.id === id) return node;
    stack.push(...node.children);
  }
  return null;
}

export interface TreemapProps {
  rootId: number;
  logical: boolean;
  version: number;
  highlight: number | null;
  budget?: number;
  selected?: number | null;
  compact?: boolean;
  onZoom: (id: number) => void;
  onUp?: () => void;
  onSelect?: (id: number) => void;
}

export function Treemap({ rootId, logical, version, highlight, budget = 7000, selected, compact, onZoom, onUp, onSelect }: TreemapProps) {
  const [frame, size] = useSize<HTMLDivElement>();
  const main = useRef<HTMLCanvasElement>(null);
  const ghost = useRef<HTMLCanvasElement>(null);
  const overlay = useRef<HTMLCanvasElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  const tree = useRef<TreeNode | null>(null);
  const [, redraw] = useState(0);
  const [payload, setPayload] = useState<TreemapPayload | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [focused, setFocused] = useState<TreeNode | null>(null);
  const hovered = useRef<TreeNode | null>(null);
  const previous = useRef<{ id: number; root: TreeNode | null } | null>(null);
  const lastWheel = useRef(0);
  const reduced = usePrefersReducedMotion();

  useEffect(() => {
    let alive = true;
    setFailed(null);
    api.call<TreemapPayload>('treemap', { id: rootId, budget, logical }, compact ? 'treemap-mini' : 'treemap').then((data) => {
      if (alive) setPayload(data);
    }).catch((error) => {
      if (alive && !isCancelled(error)) setFailed(error instanceof Error ? error.message : String(error));
    });
    return () => {
      alive = false;
    };
  }, [rootId, logical, version, budget, compact]);

  const drawOverlay = useCallback(() => {
    const canvas = overlay.current;
    if (!canvas) return;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(size.width * ratio));
    canvas.height = Math.max(1, Math.round(size.height * ratio));
    canvas.style.width = `${size.width}px`;
    canvas.style.height = `${size.height}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, size.width, size.height);
    const root = tree.current;
    if (!root) return;
    const hover = hovered.current;
    if (hover) {
      const top = directChildOf(hover, root);
      if (top && top !== hover) outline(ctx, top, 'rgba(255,255,255,0.45)', 1);
      if (hover.parent && hover.parent !== root && hover.parent !== top) outline(ctx, hover.parent, 'rgba(255,255,255,0.6)', 1);
      outline(ctx, hover, '#ffffff', 1.5);
    }
    if (selected != null) {
      const target = findById(root, selected);
      if (target) outline(ctx, target, '#4a8ad6', 2);
    }
    if (focused) outline(ctx, focused, '#ffffff', 2);
  }, [size.width, size.height, selected, focused]);

  useEffect(() => {
    const canvas = main.current;
    if (!canvas || !payload || size.width < 2 || size.height < 2) return;
    const ratio = window.devicePixelRatio || 1;
    const root = buildTree(payload.nodes);
    if (!root) return;
    layoutTree(root, size.width, size.height);
    const old = previous.current;
    const changedRoot = old !== null && old.id !== payload.id;
    const ghostCanvas = ghost.current;

    if (changedRoot && ghostCanvas && canvas.width > 1) {
      ghostCanvas.width = canvas.width;
      ghostCanvas.height = canvas.height;
      ghostCanvas.style.width = canvas.style.width;
      ghostCanvas.style.height = canvas.style.height;
      ghostCanvas.getContext('2d')?.drawImage(canvas, 0, 0);
    }

    paint(canvas, root, size.width, size.height, ratio, highlight);
    tree.current = root;
    hovered.current = null;
    setFocused(null);
    if (tip.current) tip.current.style.opacity = '0';

    if (changedRoot && ghostCanvas) {
      const options: KeyframeAnimationOptions = { duration: reduced ? 120 : 260, easing: EASE, fill: 'both' };
      const intoRect = old.root ? findById(old.root, payload.id) : null;
      const backRect = findById(root, old.id);
      ghostCanvas.style.visibility = 'visible';
      let ghostFrames: Keyframe[] = [{ opacity: 1 }, { opacity: 0 }];
      let mainFrames: Keyframe[] = [{ opacity: 0 }, { opacity: 1 }];
      if (!reduced && intoRect && intoRect.w > 1 && intoRect.h > 1) {
        const sx = size.width / intoRect.w;
        const sy = size.height / intoRect.h;
        ghostFrames = [{ transform: 'none', opacity: 1 }, { transform: `translate(${-intoRect.x * sx}px, ${-intoRect.y * sy}px) scale(${sx}, ${sy})`, opacity: 0 }];
      } else if (!reduced && backRect && backRect.w > 1 && backRect.h > 1) {
        const sx = backRect.w / size.width;
        const sy = backRect.h / size.height;
        ghostFrames = [{ transform: 'none', opacity: 1 }, { transform: `translate(${backRect.x}px, ${backRect.y}px) scale(${sx}, ${sy})`, opacity: 0 }];
        mainFrames = [{ opacity: 0.25 }, { opacity: 1 }];
      }
      const animation = ghostCanvas.animate(ghostFrames, options);
      canvas.animate(mainFrames, options);
      animation.onfinish = () => {
        ghostCanvas.style.visibility = 'hidden';
        animation.cancel();
      };
    }
    previous.current = { id: payload.id, root };
    redraw((n) => n + 1);
  }, [payload, size.width, size.height, highlight, reduced]);

  useEffect(() => {
    drawOverlay();
  });

  const nodeAt = (event: MouseEvent<HTMLDivElement>): TreeNode | null => {
    const root = tree.current;
    if (!root) return null;
    const rect = event.currentTarget.getBoundingClientRect();
    return hitTest(root, event.clientX - rect.left, event.clientY - rect.top);
  };

  const onMove = (event: MouseEvent<HTMLDivElement>) => {
    const node = nodeAt(event);
    const target = node && node !== tree.current ? node : null;
    const element = tip.current;
    if (hovered.current !== target) {
      hovered.current = target;
      drawOverlay();
      if (element && target) {
        const nameEl = element.querySelector('.tip-name');
        const metaEl = element.querySelector('.tip-meta');
        if (nameEl) nameEl.textContent = target.kind === KIND_REST ? `${formatCount(target.hidden)} itens menores` : target.name;
        if (metaEl) metaEl.textContent = `${formatBytes(target.size)}${target.kind === KIND_FILE ? `, ${CATEGORY_NAMES[target.cat]}` : target.kind === KIND_DIR ? ', pasta' : ''}`;
      }
    }
    if (element) {
      const rect = event.currentTarget.getBoundingClientRect();
      const x = Math.min(event.clientX - rect.left + 14, rect.width - element.offsetWidth - 6);
      const y = Math.min(event.clientY - rect.top + 16, rect.height - element.offsetHeight - 6);
      element.style.transform = `translate(${Math.max(4, x)}px, ${Math.max(4, y)}px)`;
      element.style.opacity = target ? '1' : '0';
    }
  };

  const onLeave = () => {
    hovered.current = null;
    drawOverlay();
    if (tip.current) tip.current.style.opacity = '0';
  };

  const zoomTarget = (node: TreeNode | null): number | null => {
    const root = tree.current;
    if (!node || !root) return null;
    const top = directChildOf(node, root);
    return top && top.kind === KIND_DIR && top.id >= 0 ? top.id : null;
  };

  const onDouble = (event: MouseEvent<HTMLDivElement>) => {
    const target = zoomTarget(nodeAt(event));
    if (target !== null) onZoom(target);
  };

  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    const node = nodeAt(event);
    if (compact) {
      const target = zoomTarget(node);
      onZoom(target ?? rootId);
      return;
    }
    if (node && node.id >= 0 && node !== tree.current) onSelect?.(node.id);
  };

  const onWheel = (event: WheelEvent<HTMLDivElement>) => {
    if (compact) return;
    const now = performance.now();
    if (now - lastWheel.current < 280) return;
    lastWheel.current = now;
    if (event.deltaY > 0) {
      onUp?.();
    } else if (event.deltaY < 0) {
      const root = tree.current;
      if (!root) return;
      const rect = event.currentTarget.getBoundingClientRect();
      const target = zoomTarget(hitTest(root, event.clientX - rect.left, event.clientY - rect.top));
      if (target !== null) onZoom(target);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const root = tree.current;
    if (!root || compact) return;
    const items = root.children;
    const directions: Record<string, 'left' | 'right' | 'up' | 'down'> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };
    if (event.key in directions) {
      event.preventDefault();
      const next = focused ? neighbor(items, focused, directions[event.key]) : items[0] ?? null;
      if (next) setFocused(next);
    } else if (event.key === 'Enter' && focused) {
      event.preventDefault();
      if (focused.kind === KIND_DIR && focused.id >= 0) onZoom(focused.id);
    } else if (event.key === ' ' && focused && focused.id >= 0) {
      event.preventDefault();
      onSelect?.(focused.id);
    } else if (event.key === 'Backspace' || event.key === 'Escape') {
      event.preventDefault();
      onUp?.();
    }
  };

  const focusLabel = focused ? `${focused.kind === KIND_REST ? `${formatCount(focused.hidden)} itens menores` : focused.name}, ${formatBytes(focused.size)}` : '';

  return (
    <div
      ref={frame}
      className={`treemap${compact ? ' is-compact' : ''}`}
      role="application"
      aria-label={compact ? 'Mapa do disco. Clique para abrir.' : 'Mapa do disco. Use as setas para percorrer, Enter para entrar na pasta, Espaço para ver detalhes e Backspace para voltar.'}
      tabIndex={compact ? -1 : 0}
      onMouseMove={onMove}
      onMouseLeave={onLeave}
      onClick={onClick}
      onDoubleClick={compact ? undefined : onDouble}
      onWheel={onWheel}
      onKeyDown={onKeyDown}
    >
      <canvas ref={main} className="treemap-main" />
      <canvas ref={ghost} className="treemap-ghost" />
      <canvas ref={overlay} className="treemap-overlay" />
      <div ref={tip} className="treemap-tip" aria-hidden="true"><div className="tip-name" /><div className="tip-meta" /></div>
      <span className="sr-only" aria-live="polite">{focusLabel}</span>
      {failed && <div className="treemap-state">Não foi possível desenhar o mapa. {failed}</div>}
      {!failed && !payload && <div className="treemap-state">Montando o mapa</div>}
      {payload && payload.nodes.length <= 1 && <div className="treemap-state">Esta pasta está vazia.</div>}
    </div>
  );
}
