import { useEffect, useState } from 'react';
import { CATEGORY_NAMES, formatBytes, parseSize } from '../../shared/format';
import type { Item, QueryFilter, StatsPayload } from '../../shared/types';
import { ItemTable } from '../components/ItemTable';
import { CatDot, IconButton, useDebounced } from '../components/ui';
import { api, useApp } from '../state';

const toUnix = (value: string, endOfDay = false): number | undefined => {
  if (!value) return undefined;
  const time = new Date(`${value}T${endOfDay ? '23:59:59' : '00:00:00'}`).getTime();
  return Number.isFinite(time) ? Math.floor(time / 1000) : undefined;
};

const toDateInput = (unix?: number): string => (unix ? new Date(unix * 1000).toISOString().slice(0, 10) : '');

export function ExploreView() {
  const app = useApp();
  const filter = app.explore;
  const [exts, setExts] = useState((filter.exts ?? []).join(' '));
  const [min, setMin] = useState(filter.minSize ? String(Math.round(filter.minSize / 1048576)) : '');
  const [max, setMax] = useState(filter.maxSize ? String(Math.round(filter.maxSize / 1048576)) : '');
  const [location, setLocation] = useState('');
  const [locationError, setLocationError] = useState(false);
  const [withinItem, setWithinItem] = useState<Item | null>(null);
  const [stats, setStats] = useState<StatsPayload | null>(null);
  const dExts = useDebounced(exts, 300);
  const dMin = useDebounced(min, 300);
  const dMax = useDebounced(max, 300);
  const dLocation = useDebounced(location, 400);

  useEffect(() => {
    void api.call<StatsPayload>('stats', { logical: app.logical }, 'explore-stats').then(setStats).catch(() => undefined);
  }, [app.version, app.logical]);

  useEffect(() => {
    const list = dExts.split(/[\s,;]+/).map((e) => e.replace(/^\./, '').toLowerCase()).filter(Boolean);
    const minSize = dMin ? parseSize(dMin) : undefined;
    const maxSize = dMax ? parseSize(dMax) : undefined;
    const next = { ...app.explore, exts: list.length ? list : undefined, minSize, maxSize };
    if (JSON.stringify(next) !== JSON.stringify(app.explore)) app.setExplore(next);
  }, [dExts, dMin, dMax]);

  useEffect(() => {
    if (filter.within == null) {
      setWithinItem(null);
      return;
    }
    void api.call<Item[]>('node.chain', { id: filter.within }).then((chain) => {
      const last = chain[chain.length - 1];
      setWithinItem(last ?? null);
      setLocation(chain.map((c, i) => (i === 0 ? c.name.replace(/\\$/, '') : c.name)).join('\\'));
    }).catch(() => setWithinItem(null));
  }, [filter.within]);

  useEffect(() => {
    const value = dLocation.trim();
    if (!value) {
      setLocationError(false);
      if (app.explore.within != null) app.setExplore({ ...app.explore, within: undefined });
      return;
    }
    void api.call<number | null>('node.find', { path: value }).then((id) => {
      setLocationError(id === null);
      if (id !== null && id !== app.explore.within) app.setExplore({ ...app.explore, within: id });
    }).catch(() => setLocationError(true));
  }, [dLocation]);

  const set = (patch: Partial<QueryFilter>) => app.setExplore({ ...filter, ...patch });
  const toggleCat = (cat: number) => {
    const current = new Set(filter.cats ?? []);
    if (current.has(cat)) current.delete(cat);
    else current.add(cat);
    set({ cats: current.size ? [...current] : undefined });
  };
  const hasFilters = Boolean(filter.exts?.length || filter.cats?.length || filter.minSize || filter.maxSize || filter.after || filter.before || filter.within != null || filter.text);
  const clear = () => {
    setExts('');
    setMin('');
    setMax('');
    setLocation('');
    app.setExplore({ kind: filter.kind, sort: 'size' });
  };

  const onSort = (sort: NonNullable<QueryFilter['sort']>) => {
    if (filter.sort === sort) set({ asc: !filter.asc });
    else set({ sort, asc: sort === 'name' });
  };

  const categories = stats ? stats.categories.filter((c) => c.count > 0).sort((a, b) => b.bytes - a.bytes) : [];

  return (
    <div className="explore-page">
      <div className="explore-head">
        <h1 className="page-title">Maiores e busca</h1>
        <div className="tabs" role="tablist" aria-label="Tipo de item">
          <button type="button" role="tab" aria-selected={filter.kind !== 'dir'} className={filter.kind !== 'dir' ? 'is-on' : ''} onClick={() => set({ kind: 'file', exts: filter.exts })}>Arquivos</button>
          <button type="button" role="tab" aria-selected={filter.kind === 'dir'} className={filter.kind === 'dir' ? 'is-on' : ''} onClick={() => set({ kind: 'dir', exts: undefined, cats: undefined })}>Pastas</button>
        </div>
        {hasFilters && <button type="button" className="link-button" onClick={clear}>Limpar filtros</button>}
      </div>

      <form className="filters" onSubmit={(event) => event.preventDefault()} aria-label="Filtros">
        <label className="field">
          <span>Extensões</span>
          <input className="input" value={exts} disabled={filter.kind === 'dir'} onChange={(event) => setExts(event.target.value)} placeholder="iso, mkv, zip" spellCheck={false} />
        </label>
        <label className="field field-small">
          <span>Mínimo</span>
          <input className="input num" value={min} onChange={(event) => setMin(event.target.value)} placeholder="100 MB" aria-describedby="size-hint" />
        </label>
        <label className="field field-small">
          <span>Máximo</span>
          <input className="input num" value={max} onChange={(event) => setMax(event.target.value)} placeholder="2 GB" aria-describedby="size-hint" />
        </label>
        <label className="field field-date">
          <span>Modificado depois de</span>
          <input className="input" type="date" value={toDateInput(filter.after)} onChange={(event) => set({ after: toUnix(event.target.value) })} />
        </label>
        <label className="field field-date">
          <span>Modificado antes de</span>
          <input className="input" type="date" value={toDateInput(filter.before)} onChange={(event) => set({ before: toUnix(event.target.value, true) })} />
        </label>
        <label className="field field-grow">
          <span>{locationError ? 'Esta pasta não está na análise' : 'Dentro da pasta'}</span>
          <span className="input-with-action">
            <input className={`input${locationError ? ' is-invalid' : ''}`} value={location} onChange={(event) => setLocation(event.target.value)} placeholder={app.summary?.path} spellCheck={false} title={withinItem?.name} aria-invalid={locationError} />
            {location && <IconButton icon="close" label="Limpar pasta" onClick={() => setLocation('')} />}
          </span>
        </label>
        <span id="size-hint" className="sr-only">Aceita KB, MB, GB e TB. Sem unidade, vale MB.</span>
      </form>

      {filter.kind !== 'dir' && (
        <div className="chips" role="group" aria-label="Filtrar por tipo de arquivo">
          {categories.map((c) => (
            <button key={c.cat} type="button" className={`chip${filter.cats?.includes(c.cat) ? ' is-on' : ''}`} aria-pressed={Boolean(filter.cats?.includes(c.cat))} onClick={() => toggleCat(c.cat)}>
              <CatDot cat={c.cat} />
              {CATEGORY_NAMES[c.cat]}
              <span className="num muted">{formatBytes(c.bytes)}</span>
            </button>
          ))}
        </div>
      )}

      <ItemTable filter={filter} label="resultados" onSort={onSort} />
    </div>
  );
}
