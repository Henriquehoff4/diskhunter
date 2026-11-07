import { useCallback, useEffect, useRef, useState } from 'react';
import { formatBytes, formatDate, formatCount } from '../../shared/format';
import { FLAG, type Item, type QueryFilter, type QueryPage } from '../../shared/types';
import { api, errorText, isCancelled, useApp } from '../state';
import { CatDot, Empty, Icon, IconButton, VirtualList } from './ui';

const PAGE = 200;

export function useQueryPages(filter: QueryFilter, version: number) {
  const [state, setState] = useState<{ total: number; totalBytes: number; capped: boolean; window: number; loading: boolean; error: string | null }>({ total: 0, totalBytes: 0, capped: false, window: 0, loading: true, error: null });
  const pages = useRef(new Map<number, Item[]>());
  const pending = useRef(new Set<number>());
  const [, tick] = useState(0);
  const generation = useRef(0);
  const key = JSON.stringify(filter);

  const fetchPage = useCallback((offset: number, gen: number, first: boolean) => {
    pending.current.add(offset);
    api.call<QueryPage>('query', { filter: JSON.parse(key), offset, limit: PAGE }, first ? 'query' : undefined).then((page) => {
      if (gen !== generation.current) return;
      pages.current.set(offset, page.items);
      pending.current.delete(offset);
      setState({ total: page.total, totalBytes: page.totalBytes, capped: page.capped, window: page.window, loading: false, error: null });
      tick((n) => n + 1);
    }).catch((error) => {
      if (gen !== generation.current || isCancelled(error)) return;
      pending.current.delete(offset);
      setState((current) => ({ ...current, loading: false, error: errorText(error) }));
    });
  }, [key]);

  useEffect(() => {
    generation.current += 1;
    pages.current = new Map();
    pending.current = new Set();
    setState((current) => ({ ...current, loading: true, error: null }));
    fetchPage(0, generation.current, true);
  }, [key, version, fetchPage]);

  const onRange = useCallback((first: number, last: number) => {
    for (let page = Math.floor(first / PAGE); page <= Math.floor(Math.max(first, last - 1) / PAGE); page += 1) {
      const offset = page * PAGE;
      if (!pages.current.has(offset) && !pending.current.has(offset)) fetchPage(offset, generation.current, false);
    }
  }, [fetchPage]);

  const itemAt = (index: number): Item | undefined => pages.current.get(Math.floor(index / PAGE) * PAGE)?.[index % PAGE];

  return { ...state, itemAt, onRange };
}

interface Props {
  filter: QueryFilter;
  label: string;
  onSort?: (sort: NonNullable<QueryFilter['sort']>) => void;
  emptyTitle?: string;
  emptyText?: string;
}

export function ItemTable({ filter, label, onSort, emptyTitle, emptyText }: Props) {
  const app = useApp();
  const query = useQueryPages({ ...filter, logical: app.logical }, app.version);
  const [active, setActive] = useState(-1);
  const sizeKey = app.logical ? 'size' : 'alloc';
  const top = query.itemAt(0);
  const scale = top ? Math.max(1, top[sizeKey]) : 1;
  const count = Math.min(query.window, query.total);

  useEffect(() => setActive(-1), [query.total]);

  const toggle = (item: Item) => {
    if (app.marked.has(item.id)) app.unmark([item.id]);
    else app.mark([{ id: item.id, name: item.name, bytes: item.alloc }]);
  };

  const sortButton = (key: NonNullable<QueryFilter['sort']>, text: string, right?: boolean) => (
    <button type="button" className={`th-button${right ? ' is-right' : ''}${filter.sort === key ? ' is-sorted' : ''}`} onClick={() => onSort?.(key)} aria-label={`Ordenar por ${text}${filter.sort === key ? (filter.asc ? ', crescente' : ', decrescente') : ''}`}>
      {text}
    </button>
  );

  return (
    <div className="item-table">
      <div className="table-meta" aria-live="polite">
        {query.error ? <span className="danger-text">{query.error}</span> : (
          <span>
            {query.loading && query.total === 0 ? 'Procurando' : <><strong className="num">{formatCount(query.total)}</strong> {filter.kind === 'dir' ? (query.total === 1 ? 'pasta' : 'pastas') : query.total === 1 ? 'arquivo' : 'arquivos'} somando <strong className="num">{formatBytes(query.totalBytes)}</strong></>}
            {query.capped && <span className="muted">. Mostrando os primeiros {formatCount(query.window)}; refine os filtros para ver o restante.</span>}
          </span>
        )}
      </div>
      <div className="table-head row-grid" role="presentation">
        <span />
        {sortButton('name', 'Nome')}
        <span className="th">Local</span>
        {sortButton('mtime', 'Modificado')}
        {sortButton('size', app.logical ? 'Tamanho' : 'Em disco', true)}
        <span />
      </div>
      {count === 0 && !query.loading && !query.error ? (
        <Empty title={emptyTitle ?? 'Nada encontrado'}>{emptyText ?? 'Tente afrouxar os filtros.'}</Empty>
      ) : (
        <VirtualList
          count={count}
          rowHeight={36}
          label={label}
          active={active}
          setActive={(index) => {
            setActive(index);
            const item = query.itemAt(index);
            if (item) app.inspect(item.id);
          }}
          onRange={query.onRange}
          onActivate={(index) => {
            const item = query.itemAt(index);
            if (!item) return;
            if (item.flags & FLAG.dir) app.openMap(item.id);
            else void api.reveal(item.id);
          }}
          onToggle={(index) => {
            const item = query.itemAt(index);
            if (item) toggle(item);
          }}
          renderRow={(index, isActive) => {
            const item = query.itemAt(index);
            if (!item) return <div className="row-grid row-skeleton"><span /><span className="skeleton" /><span className="skeleton" /><span /><span /><span /></div>;
            const value = item[sizeKey];
            const checked = app.marked.has(item.id);
            const isDir = (item.flags & FLAG.dir) !== 0;
            return (
              <div
                className={`row-grid data-row${isActive ? ' is-active' : ''}${app.inspected === item.id ? ' is-inspected' : ''}`}
                onClick={() => {
                  setActive(index);
                  app.inspect(item.id);
                }}
                onDoubleClick={() => (isDir ? app.openMap(item.id) : void api.reveal(item.id))}
              >
                <label className="check-cell" onClick={(event) => event.stopPropagation()}>
                  <input type="checkbox" checked={checked} onChange={() => toggle(item)} aria-label={`Marcar ${item.name} para exclusão`} />
                </label>
                <span className="name-cell" title={item.name}>
                  {isDir ? <Icon name="folder" size={14} /> : <CatDot cat={item.cat} />}
                  <span className="truncate">{item.name}</span>
                  {item.flags & FLAG.hardlinkDup ? <span className="tag" title="Mesmo conteúdo em outro caminho. Não ocupa espaço extra.">link físico</span> : null}
                  {item.flags & FLAG.cloud ? <span className="tag" title="Conteúdo guardado na nuvem. Não ocupa este tamanho no disco.">na nuvem</span> : null}
                </span>
                <span className="path-cell truncate-start" title={item.dir}><bdi>{item.dir}</bdi></span>
                <span className="muted num">{formatDate(item.mtime)}</span>
                <span className="size-cell num">
                  <span className="size-bar" aria-hidden="true"><span style={{ transform: `scaleX(${Math.min(1, value / scale)})` }} /></span>
                  {formatBytes(value)}
                </span>
                <span className="row-actions">
                  <IconButton icon="reveal" label="Mostrar no Explorador" onClick={() => void api.reveal(item.id)} />
                </span>
              </div>
            );
          }}
        />
      )}
    </div>
  );
}
