import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { CATEGORY_NAMES, formatBytes } from '../../shared/format';
import { CATEGORY_COLORS } from '../state';

const paths: Record<string, ReactNode> = {
  home: <path d="M3 13 12 4l9 9M6 11v9h12v-9" />,
  overview: <><path d="M4 20V10M12 20V4M20 20v-7" /></>,
  map: <><rect x="3" y="4" width="18" height="16" rx="1" /><path d="M12 4v16M12 12h9M16.5 12v8" /></>,
  explore: <><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></>,
  duplicates: <><rect x="8" y="8" width="12" height="12" rx="1" /><path d="M16 8V4H4v12h4" /></>,
  cleanup: <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5M14 11v5" />,
  models: <><rect x="7" y="7" width="10" height="10" rx="1" /><path d="M10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4" /></>,
  growth: <path d="M3 17l6-6 4 4 8-8M15 7h6v6" />,
  reports: <><path d="M6 3h9l4 4v14H6z" /><path d="M9 12h7M9 16h7" /></>,
  settings: <><path d="M4 7h10M18 7h2M4 17h2M10 17h10" /><circle cx="16" cy="7" r="2" /><circle cx="8" cy="17" r="2" /></>,
  folder: <path d="M3 6h6l2 2h10v11H3z" />,
  file: <path d="M6 3h8l4 4v14H6zM14 3v4h4" />,
  reveal: <><path d="M3 6h6l2 2h10v11H3z" /><path d="M12 11v5M9.5 13.5 12 11l2.5 2.5" /></>,
  copy: <><rect x="8" y="8" width="12" height="12" rx="1" /><path d="M16 8V4H4v12h4" /></>,
  open: <path d="M14 4h6v6M20 4l-9 9M18 14v6H4V6h6" />,
  close: <path d="M5 5l14 14M19 5 5 19" />,
  up: <path d="M12 19V5M6 11l6-6 6 6" />,
  check: <path d="m5 12 5 5 9-10" />,
  warning: <path d="M12 4 2.5 20h19zM12 10v5M12 18v.5" />,
  chevron: <path d="m9 6 6 6-6 6" />,
};

export function Icon({ name, size = 16 }: { name: keyof typeof paths | string; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[name]}
    </svg>
  );
}

export function Mark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <rect x="2" y="2" width="11" height="20" fill="#3987e5" />
      <rect x="14" y="2" width="8" height="11" fill="#f2f2f3" />
      <rect x="14" y="14" width="3.5" height="8" fill="#8a8c92" />
      <rect x="18.5" y="14" width="3.5" height="3.5" fill="#d95926" />
      <rect x="18.5" y="18.5" width="3.5" height="3.5" fill="#8a8c92" />
    </svg>
  );
}

export function CatDot({ cat }: { cat: number }) {
  return <span className="cat-dot" style={{ background: CATEGORY_COLORS[cat] }} aria-hidden="true" />;
}

export function IconButton({ icon, label, onClick, disabled }: { icon: string; label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" className="icon-button" title={label} aria-label={label} onClick={(event) => { event.stopPropagation(); onClick(); }} disabled={disabled}>
      <Icon name={icon} />
    </button>
  );
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <p className="empty-title">{title}</p>
      {children && <p className="empty-text">{children}</p>}
      {action}
    </div>
  );
}

export function Notice({ tone = 'info', children, action }: { tone?: 'info' | 'warning' | 'error'; children: ReactNode; action?: ReactNode }) {
  return (
    <div className={`notice notice-${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      {tone !== 'info' && <Icon name="warning" />}
      <div className="notice-body">{children}</div>
      {action}
    </div>
  );
}

export function SegmentBar({ segments, height = 34, label }: { segments: { key: string | number; value: number; color: string; title: string }[]; height?: number; label: string }) {
  const total = segments.reduce((sum, s) => sum + s.value, 0) || 1;
  return (
    <div className="segment-bar" style={{ height }} role="img" aria-label={label}>
      {segments.filter((s) => s.value > 0).map((s) => (
        <span key={s.key} className="segment" title={`${s.title}: ${formatBytes(s.value)}`} style={{ flexGrow: s.value / total, flexBasis: 0, background: s.color }} />
      ))}
    </div>
  );
}

export function CategoryLegend({ items, onPick }: { items: { cat: number; bytes: number }[]; onPick?: (cat: number) => void }) {
  return (
    <ul className="legend">
      {items.filter((i) => i.bytes > 0).map((item) => (
        <li key={item.cat}>
          {onPick ? (
            <button type="button" className="legend-item" onClick={() => onPick(item.cat)}>
              <CatDot cat={item.cat} />
              <span>{CATEGORY_NAMES[item.cat]}</span>
              <span className="num muted">{formatBytes(item.bytes)}</span>
            </button>
          ) : (
            <span className="legend-item">
              <CatDot cat={item.cat} />
              <span>{CATEGORY_NAMES[item.cat]}</span>
              <span className="num muted">{formatBytes(item.bytes)}</span>
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

export function useSize<T extends HTMLElement>(): [React.RefObject<T | null>, { width: number; height: number }] {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      setSize({ width: Math.round(entry.contentRect.width), height: Math.round(entry.contentRect.height) });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, size];
}

export interface VirtualListProps {
  count: number;
  rowHeight: number;
  label: string;
  renderRow: (index: number, active: boolean) => ReactNode;
  onRange?: (first: number, last: number) => void;
  onActivate?: (index: number) => void;
  onToggle?: (index: number) => void;
  active: number;
  setActive: (index: number) => void;
}

export function VirtualList({ count, rowHeight, label, renderRow, onRange, onActivate, onToggle, active, setActive }: VirtualListProps) {
  const [ref, size] = useSize<HTMLDivElement>();
  const [scroll, setScroll] = useState(0);
  const first = Math.max(0, Math.floor(scroll / rowHeight) - 6);
  const last = Math.min(count, Math.ceil((scroll + size.height) / rowHeight) + 6);

  useEffect(() => {
    onRange?.(first, last);
  }, [first, last, onRange]);

  const ensureVisible = useCallback((index: number) => {
    const element = ref.current;
    if (!element) return;
    const top = index * rowHeight;
    if (top < element.scrollTop) element.scrollTop = top;
    else if (top + rowHeight > element.scrollTop + element.clientHeight) element.scrollTop = top + rowHeight - element.clientHeight;
  }, [ref, rowHeight]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (count === 0) return;
    const page = Math.max(1, Math.floor(size.height / rowHeight) - 1);
    const moves: Record<string, number> = { ArrowDown: active + 1, ArrowUp: active - 1, PageDown: active + page, PageUp: active - page, Home: 0, End: count - 1 };
    if (event.key in moves) {
      event.preventDefault();
      const next = Math.max(0, Math.min(count - 1, moves[event.key]));
      setActive(next);
      ensureVisible(next);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (active >= 0) onActivate?.(active);
    } else if (event.key === ' ') {
      event.preventDefault();
      if (active >= 0) onToggle?.(active);
    }
  };

  const rows: ReactNode[] = [];
  for (let i = first; i < last; i += 1) {
    rows.push(
      <div key={i} className="v-row" style={{ transform: `translateY(${i * rowHeight}px)`, height: rowHeight }} role="row" aria-rowindex={i + 1} aria-selected={i === active} id={`row-${label}-${i}`}>
        {renderRow(i, i === active)}
      </div>,
    );
  }

  return (
    <div
      ref={ref}
      className="v-list"
      role="grid"
      aria-label={label}
      aria-rowcount={count}
      tabIndex={0}
      aria-activedescendant={active >= first && active < last ? `row-${label}-${active}` : undefined}
      onKeyDown={onKeyDown}
      onScroll={(event) => setScroll(event.currentTarget.scrollTop)}
    >
      <div className="v-space" style={{ height: count * rowHeight }}>{rows}</div>
    </div>
  );
}

export function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const listener = () => setReduced(media.matches);
    media.addEventListener('change', listener);
    return () => media.removeEventListener('change', listener);
  }, []);
  return reduced;
}
