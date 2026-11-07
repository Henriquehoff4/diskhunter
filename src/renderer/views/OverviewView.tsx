import { useEffect, useState } from 'react';
import { AGE_NAMES, CATEGORY_NAMES, RISK_NAMES, formatBytes, formatCount, formatDuration } from '../../shared/format';
import { FLAG, type QueryPage, type ScanSummary, type StatsPayload } from '../../shared/types';
import { CatDot, CategoryLegend, Icon, Notice, SegmentBar } from '../components/ui';
import { Treemap } from '../components/Treemap';
import { CATEGORY_COLORS, api, useApp } from '../state';

function headline(summary: ScanSummary): string {
  if (summary.isDrive && summary.volumeTotal > 0) {
    const used = summary.volumeTotal - summary.volumeFree;
    return `${summary.path.replace(/\\$/, '')} está ${Math.round((used / summary.volumeTotal) * 100)}% cheio`;
  }
  return `${summary.path} ocupa ${formatBytes(summary.alloc)}`;
}

export function OverviewView() {
  const app = useApp();
  const summary = app.summary as ScanSummary;
  const [stats, setStats] = useState<StatsPayload | null>(null);
  const [topDirs, setTopDirs] = useState<QueryPage | null>(null);
  const [topFiles, setTopFiles] = useState<QueryPage | null>(null);

  useEffect(() => {
    void api.call<StatsPayload>('stats', { logical: app.logical }, 'stats').then(setStats).catch(() => undefined);
    void api.call<QueryPage>('query', { filter: { kind: 'dir', sort: 'size', logical: app.logical }, limit: 6 }).then(setTopDirs).catch(() => undefined);
    void api.call<QueryPage>('query', { filter: { kind: 'file', sort: 'size', logical: app.logical }, limit: 6 }).then(setTopFiles).catch(() => undefined);
  }, [app.version, app.logical]);

  const recs = app.cleanup?.items.filter((r) => r.action === 'trash').slice(0, 5) ?? [];
  const recMax = Math.max(1, ...recs.map((r) => r.bytes));
  const categories = stats ? [...stats.categories].sort((a, b) => b.bytes - a.bytes) : [];
  const unaccounted = summary.isDrive && summary.volumeTotal > 0 ? Math.max(0, summary.volumeTotal - summary.volumeFree - summary.alloc) : 0;
  const sizeKey = app.logical ? 'size' : 'alloc';
  const ageMax = stats ? Math.max(1, ...stats.ages.map((a) => a.bytes)) : 1;

  const segments = [
    ...categories.map((c) => ({ key: c.cat, value: c.bytes, color: CATEGORY_COLORS[c.cat], title: CATEGORY_NAMES[c.cat] })),
    ...(unaccounted > 0 ? [{ key: 'sys', value: unaccounted, color: '#3a3a3e', title: 'Não contabilizado' }] : []),
    ...(summary.isDrive ? [{ key: 'free', value: summary.volumeFree, color: '#212023', title: 'Livre' }] : []),
  ];

  return (
    <div className="page">
      <div className="title-row">
        <div>
          <h1 className="page-title">{headline(summary)}</h1>
          <p className="page-lead">
            {app.cleanup === null ? 'Calculando o que dá para recuperar' : app.cleanup.recoverable > 0 ? (
              <>Dá para recuperar até <strong className="num">{formatBytes(app.cleanup.recoverable)}</strong> revisando as recomendações.</>
            ) : 'Nenhuma limpeza óbvia por aqui.'}
          </p>
        </div>
        <div className="title-actions">
          <button type="button" className="button" onClick={() => void app.startScan(summary.path)}>Analisar de novo</button>
          <button type="button" className="button is-primary" onClick={() => app.go('cleanup')}>Ver limpeza</button>
        </div>
      </div>

      {summary.cancelled && <Notice tone="warning">A análise foi cancelada. Os números estão incompletos e ela não entra na comparação de crescimento.</Notice>}
      {summary.errors > 0 && (
        <Notice tone="warning" action={<button type="button" className="button" onClick={() => app.go('reports')}>Ver lista</button>}>
          {formatCount(summary.errors)} {summary.errors === 1 ? 'pasta não pôde ser lida' : 'pastas não puderam ser lidas'} por falta de permissão. O total real pode ser maior.
        </Notice>
      )}

      <dl className="kpis">
        <div><dt>{app.logical ? 'Tamanho' : 'Em disco'}</dt><dd className="num">{formatBytes(app.logical ? summary.size : summary.alloc)}</dd></div>
        {summary.isDrive && <div><dt>Livre</dt><dd className="num">{formatBytes(summary.volumeFree)}</dd></div>}
        <div><dt>Arquivos</dt><dd className="num">{formatCount(summary.files)}</dd></div>
        <div><dt>Tempo da análise</dt><dd className="num">{formatDuration(summary.elapsed)}</dd></div>
        <div><dt>Links físicos</dt><dd className="num" title="Contados uma única vez, como o Windows guarda.">{formatCount(summary.hardlinks)}</dd></div>
        {stats && stats.cloudCount > 0 && <div><dt>Só na nuvem</dt><dd className="num" title="Arquivos que não ocupam este espaço no disco.">{formatBytes(stats.cloud)}</dd></div>}
      </dl>

      {stats && (
        <section aria-label="Composição do disco">
          <SegmentBar label={`Composição de ${summary.path} por tipo de arquivo`} segments={segments} />
          <CategoryLegend
            items={categories}
            onPick={(cat) => { app.setExplore({ kind: 'file', sort: 'size', cats: [cat] }); app.go('explore'); }}
          />
          {summary.isDrive && <p className="fine">{unaccounted > 0 ? `Mais ${formatBytes(unaccounted)} usados que a análise não enxerga: metadados do NTFS, pontos de restauração e pastas sem acesso. ` : ''}{formatBytes(summary.volumeFree)} livres.</p>}
        </section>
      )}

      <div className="split-2-1">
        <section aria-labelledby="map-title" className="panel-plain">
          <div className="section-head">
            <h2 id="map-title" className="section-title">Mapa do disco</h2>
            <button type="button" className="link-button" onClick={() => app.openMap(0)}>Abrir mapa completo</button>
          </div>
          <div className="overview-map">
            <Treemap rootId={0} logical={app.logical} version={app.version} highlight={null} budget={1800} compact onZoom={(id) => app.openMap(id)} />
          </div>
        </section>
        <section aria-labelledby="rec-title" className="panel-plain">
          <div className="section-head">
            <h2 id="rec-title" className="section-title">Limpeza recomendada</h2>
            <button type="button" className="link-button" onClick={() => app.go('cleanup')}>Ver tudo</button>
          </div>
          {app.cleanup === null ? <p className="muted">Calculando</p> : recs.length === 0 ? <p className="muted">Nada para limpar nesta análise.</p> : (
            <ul className="rank-list">
              {recs.map((rec) => (
                <li key={rec.id}>
                  <button type="button" className="rank-row" onClick={() => app.go('cleanup')}>
                    <span className="rank-name truncate">{rec.title}</span>
                    <span className="num">{formatBytes(rec.bytes)}</span>
                    <span className="rank-bar" aria-hidden="true"><span style={{ transform: `scaleX(${rec.bytes / recMax})` }} /></span>
                    <span className={`risk risk-${rec.risk}`}>{RISK_NAMES[rec.risk]}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <div className="split-3">
        <section aria-labelledby="dirs-title">
          <div className="section-head"><h2 id="dirs-title" className="section-title">Maiores pastas</h2><button type="button" className="link-button" onClick={() => { app.setExplore({ kind: 'dir', sort: 'size' }); app.go('explore'); }}>Ver ranking</button></div>
          <ul className="mini-list">
            {topDirs?.items.map((item) => (
              <li key={item.id}>
                <button type="button" className="mini-row" onClick={() => app.openMap(item.id)} title={`${item.dir}\\${item.name}`}>
                  <Icon name="folder" size={14} /><span className="truncate">{item.name}</span><span className="num muted">{formatBytes(item[sizeKey])}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
        <section aria-labelledby="files-title">
          <div className="section-head"><h2 id="files-title" className="section-title">Maiores arquivos</h2><button type="button" className="link-button" onClick={() => { app.setExplore({ kind: 'file', sort: 'size' }); app.go('explore'); }}>Ver ranking</button></div>
          <ul className="mini-list">
            {topFiles?.items.map((item) => (
              <li key={item.id}>
                <button type="button" className="mini-row" onClick={() => app.inspect(item.id)} title={`${item.dir}\\${item.name}`}>
                  {item.flags & FLAG.dir ? <Icon name="folder" size={14} /> : <CatDot cat={item.cat} />}<span className="truncate">{item.name}</span><span className="num muted">{formatBytes(item[sizeKey])}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
        <section aria-labelledby="age-title">
          <h2 id="age-title" className="section-title">Última alteração</h2>
          <ul className="age-list">
            {stats?.ages.map((age) => (
              <li key={age.bucket} title={`${formatCount(age.count)} arquivos`}>
                <span>{AGE_NAMES[age.bucket]}</span>
                <span className="age-track" aria-hidden="true"><span style={{ transform: `scaleX(${age.bytes / ageMax})` }} /></span>
                <span className="num muted">{formatBytes(age.bytes)}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
