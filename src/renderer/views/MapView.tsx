import { useEffect, useState } from 'react';
import { CATEGORY_NAMES, formatBytes, formatDate } from '../../shared/format';
import { FLAG, type Item, type StatsPayload } from '../../shared/types';
import { Treemap } from '../components/Treemap';
import { CatDot, Icon, VirtualList } from '../components/ui';
import { api, useApp } from '../state';

export function MapView() {
  const app = useApp();
  const [chain, setChain] = useState<Item[]>([]);
  const [children, setChildren] = useState<Item[]>([]);
  const [highlight, setHighlight] = useState<number | null>(null);
  const [stats, setStats] = useState<StatsPayload | null>(null);
  const [active, setActive] = useState(-1);
  const root = app.mapRoot;

  useEffect(() => {
    let alive = true;
    api.call<Item[]>('node.chain', { id: root }).then((value) => {
      if (alive) setChain(value);
    }).catch(() => app.setMapRoot(0));
    api.call<{ items: Item[] }>('node.children', { id: root, limit: 2000, logical: app.logical }, 'children').then((value) => {
      if (alive) {
        setChildren(value.items);
        setActive(-1);
      }
    }).catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [root, app.version, app.logical]);

  useEffect(() => {
    void api.call<StatsPayload>('stats', { logical: app.logical }, 'map-stats').then(setStats).catch(() => undefined);
  }, [app.version, app.logical]);

  const up = () => {
    if (chain.length > 1) app.setMapRoot(chain[chain.length - 2].id);
  };
  const sizeKey = app.logical ? 'size' : 'alloc';
  const total = chain.length ? chain[chain.length - 1][sizeKey] : 0;
  const categories = stats ? [...stats.categories].filter((c) => c.bytes > 0).sort((a, b) => b.bytes - a.bytes) : [];

  return (
    <div className="map-page">
      <div className="map-bar">
        <button type="button" className="icon-button" onClick={up} disabled={chain.length <= 1} aria-label="Subir uma pasta" title="Subir uma pasta (Backspace)"><Icon name="up" /></button>
        <nav className="crumbs" aria-label="Caminho no mapa">
          {chain.map((item, index) => (
            <span key={item.id} className="crumb">
              {index > 0 && <Icon name="chevron" size={12} />}
              <button type="button" className={index === chain.length - 1 ? 'is-current' : ''} aria-current={index === chain.length - 1 ? 'location' : undefined} onClick={() => app.setMapRoot(item.id)}>{index === 0 ? item.name.replace(/\\$/, '') : item.name}</button>
            </span>
          ))}
        </nav>
        <span className="num map-total">{formatBytes(total)}</span>
        <div className="metric" role="group" aria-label="Medida do mapa">
          <button type="button" className={!app.logical ? 'is-on' : ''} aria-pressed={!app.logical} onClick={() => void app.updateSettings({ metric: 'alloc' })} title="Espaço realmente ocupado no disco">Em disco</button>
          <button type="button" className={app.logical ? 'is-on' : ''} aria-pressed={app.logical} onClick={() => void app.updateSettings({ metric: 'size' })} title="Tamanho nominal, incluindo arquivos só na nuvem">Tamanho</button>
        </div>
      </div>
      <div className="map-body">
        <div className="map-stage">
          <Treemap
            rootId={root}
            logical={app.logical}
            version={app.version}
            highlight={highlight}
            selected={app.inspected}
            onZoom={app.setMapRoot}
            onUp={up}
            onSelect={app.inspect}
          />
          <ul className="legend map-legend" aria-label="Filtrar cor por tipo de arquivo">
            {categories.map((c) => (
              <li key={c.cat}>
                <button type="button" className={`legend-item${highlight === c.cat ? ' is-on' : ''}`} aria-pressed={highlight === c.cat} onClick={() => setHighlight(highlight === c.cat ? null : c.cat)}>
                  <CatDot cat={c.cat} />
                  <span>{CATEGORY_NAMES[c.cat]}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
        <section className="map-list" aria-label="Conteúdo da pasta atual">
          <VirtualList
            count={children.length}
            rowHeight={42}
            label="pasta-atual"
            active={active}
            setActive={(index) => {
              setActive(index);
              app.inspect(children[index].id);
            }}
            onActivate={(index) => {
              const item = children[index];
              if (item.flags & FLAG.dir && item.children > 0) app.setMapRoot(item.id);
              else void api.reveal(item.id);
            }}
            onToggle={(index) => {
              const item = children[index];
              if (app.marked.has(item.id)) app.unmark([item.id]);
              else app.mark([{ id: item.id, name: item.name, bytes: item.alloc }]);
            }}
            renderRow={(index, isActive) => {
              const item = children[index];
              const value = item[sizeKey];
              const isDir = (item.flags & FLAG.dir) !== 0;
              return (
                <div
                  className={`list-row${isActive ? ' is-active' : ''}${app.inspected === item.id ? ' is-inspected' : ''}`}
                  title={`${item.name}, modificado em ${formatDate(item.mtime)}`}
                  onClick={() => { setActive(index); app.inspect(item.id); }}
                  onDoubleClick={() => (isDir && item.children > 0 ? app.setMapRoot(item.id) : void api.reveal(item.id))}
                >
                  <span className="list-line">
                    {isDir ? <Icon name="folder" size={14} /> : <CatDot cat={item.cat} />}
                    <span className="truncate">{item.name}</span>
                    <span className="num">{formatBytes(value)}</span>
                  </span>
                  <span className="list-bar" aria-hidden="true"><span style={{ transform: `scaleX(${total > 0 ? Math.min(1, value / total) : 0})` }} /></span>
                </div>
              );
            }}
          />
        </section>
      </div>
    </div>
  );
}
