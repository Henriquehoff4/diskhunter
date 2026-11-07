import { useEffect, useMemo, useRef, useState } from 'react';
import { formatBytes, formatDateTime, formatDelta, formatRelative } from '../../shared/format';
import type { GrowthPayload, Snapshot } from '../../shared/types';
import { Empty, IconButton, Notice, useSize } from '../components/ui';
import { api, errorText, useApp } from '../state';

function HistoryChart({ snapshots, base, target }: { snapshots: Snapshot[]; base: string; target: string }) {
  const [ref, size] = useSize<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  const points = useMemo(() => [...snapshots].sort((a, b) => a.time - b.time), [snapshots]);
  const height = 170;
  const pad = { l: 72, r: 16, t: 14, b: 26 };
  const width = Math.max(240, size.width);
  const values = points.map((p) => p.alloc);
  const low = Math.min(...values);
  const high = Math.max(...values);
  const span = high - low || Math.max(1, high * 0.1);
  const y0 = Math.max(0, low - span * 0.15);
  const y1 = high + span * 0.15;
  const x = (i: number) => (points.length < 2 ? pad.l : pad.l + (i / (points.length - 1)) * (width - pad.l - pad.r));
  const y = (value: number) => pad.t + (1 - (value - y0) / (y1 - y0)) * (height - pad.t - pad.b);
  const ticks = [0, 1, 2, 3].map((i) => y0 + ((y1 - y0) * i) / 3);
  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)} ${y(p.alloc).toFixed(1)}`).join(' ');
  const active = hover !== null ? points[hover] : null;

  return (
    <div ref={ref} className="chart" onMouseLeave={() => setHover(null)}>
      <svg
        ref={svg}
        width={width}
        height={height}
        role="img"
        aria-label={`Espaço em disco ao longo de ${points.length} análises, de ${formatBytes(points[0].alloc)} a ${formatBytes(points[points.length - 1].alloc)}`}
        onMouseMove={(event) => {
          const rect = svg.current?.getBoundingClientRect();
          if (!rect || points.length === 0) return;
          const ratio = (event.clientX - rect.left - pad.l) / (width - pad.l - pad.r);
          setHover(Math.max(0, Math.min(points.length - 1, Math.round(ratio * (points.length - 1)))));
        }}
      >
        {ticks.map((tick) => (
          <g key={tick}>
            <line x1={pad.l} x2={width - pad.r} y1={y(tick)} y2={y(tick)} stroke="#2a2a2e" />
            <text x={pad.l - 10} y={y(tick) + 4} textAnchor="end" className="chart-tick">{formatBytes(tick)}</text>
          </g>
        ))}
        <path d={path} fill="none" stroke="#3987e5" strokeWidth="2" strokeLinejoin="round" />
        {points.map((p, i) => {
          const special = p.id === base || p.id === target;
          return <circle key={p.id} cx={x(i)} cy={y(p.alloc)} r={special ? 5 : 3} fill={special ? '#f2f2f3' : '#3987e5'} stroke="#171719" strokeWidth="2" />;
        })}
        {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={height - pad.b} stroke="#8a8c92" />}
        <text x={pad.l} y={height - 6} className="chart-tick">{formatRelative(points[0].time)}</text>
        <text x={width - pad.r} y={height - 6} textAnchor="end" className="chart-tick">{formatRelative(points[points.length - 1].time)}</text>
      </svg>
      {active && hover !== null && (
        <div className="chart-tip" style={{ transform: `translate(${Math.min(width - 190, x(hover) + 10)}px, 6px)` }}>
          <strong className="num">{formatBytes(active.alloc)}</strong>
          <span className="muted">{formatDateTime(active.time)}</span>
        </div>
      )}
    </div>
  );
}

export function GrowthView() {
  const app = useApp();
  const [root, setRoot] = useState<string | null>(app.summary?.path ?? null);
  const [roots, setRoots] = useState<string[]>([]);
  const [snapshots, setSnapshots] = useState<Snapshot[] | null>(null);
  const [baseId, setBaseId] = useState('');
  const [targetId, setTargetId] = useState('');
  const [data, setData] = useState<GrowthPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api.call<Snapshot[]>('snapshots.list', {}).then((list) => {
      const unique = [...new Set(list.map((s) => s.root))];
      setRoots(unique);
      setRoot((current) => (current && unique.some((r) => r.toLowerCase() === current.toLowerCase()) ? current : unique[0] ?? null));
    }).catch((e) => setError(errorText(e)));
  }, [app.version]);

  useEffect(() => {
    if (!root) {
      setSnapshots([]);
      return;
    }
    void api.call<Snapshot[]>('snapshots.list', { path: root }).then((list) => {
      setSnapshots(list);
      setTargetId(list[0]?.id ?? '');
      setBaseId(list[1]?.id ?? '');
    }).catch((e) => setError(errorText(e)));
  }, [root, app.version]);

  useEffect(() => {
    if (!root || !baseId || !targetId || baseId === targetId) {
      setData(null);
      return;
    }
    let alive = true;
    api.call<GrowthPayload>('snapshots.compare', { path: root, base: baseId, target: targetId }, 'compare').then((value) => {
      if (alive) {
        setData(value);
        setError(null);
      }
    }).catch((e) => {
      if (alive) setError(errorText(e));
    });
    return () => {
      alive = false;
    };
  }, [root, baseId, targetId]);

  const net = data ? data.target.alloc - data.base.alloc : 0;
  const maxDelta = data ? Math.max(1, ...data.items.map((i) => Math.abs(i.delta))) : 1;
  const showFolder = (path: string) => {
    if (app.summary && path.toLowerCase().startsWith(app.summary.path.replace(/\\$/, '').toLowerCase())) {
      void api.call<number | null>('node.find', { path }).then((id) => {
        if (id !== null) app.openMap(id);
        else app.toast('Esta pasta não está na análise atual.');
      });
    } else {
      app.toast('Analise este disco para abrir a pasta no mapa.');
    }
  };

  const enough = snapshots !== null && snapshots.length >= 2;

  return (
    <div className="page">
      <div className="title-row">
        <div>
          <h1 className="page-title">
            {data ? <>{net >= 0 ? 'Cresceu' : 'Encolheu'} <span className="num">{formatBytes(Math.abs(net))}</span> {formatRelative(data.base.time).replace('agora mesmo', 'há instantes')}</> : 'Crescimento'}
          </h1>
          <p className="page-lead">Cada análise completa fica guardada no seu computador. Compare duas para ver onde o espaço foi parar. Pastas abaixo de 1 MB não entram.</p>
        </div>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      {roots.length > 1 && (
        <label className="field field-select">
          <span>Local</span>
          <select className="input" value={root ?? ''} onChange={(event) => setRoot(event.target.value)}>
            {roots.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </label>
      )}
      {snapshots !== null && !enough && (
        <Empty title={snapshots.length === 1 ? 'Só há uma análise deste local' : 'Ainda não há análises para comparar'}>
          Faça outra análise completa mais tarde. O DiskHunter compara as duas e mostra quais pastas mudaram.
        </Empty>
      )}
      {enough && snapshots && (
        <>
          <HistoryChart snapshots={snapshots} base={baseId} target={targetId} />
          <div className="compare-row">
            <label className="field field-select">
              <span>Comparar de</span>
              <select className="input" value={baseId} onChange={(event) => setBaseId(event.target.value)}>
                {snapshots.map((s) => <option key={s.id} value={s.id}>{formatDateTime(s.time)}, {formatBytes(s.alloc)}</option>)}
              </select>
            </label>
            <label className="field field-select">
              <span>Até</span>
              <select className="input" value={targetId} onChange={(event) => setTargetId(event.target.value)}>
                {snapshots.map((s) => <option key={s.id} value={s.id}>{formatDateTime(s.time)}, {formatBytes(s.alloc)}</option>)}
              </select>
            </label>
          </div>
          {baseId === targetId && <p className="muted">Escolha duas análises diferentes.</p>}
          {data && data.items.length === 0 && <Empty title="Nada mudou de forma relevante">Nenhuma pasta variou mais de 1 MB entre as duas análises.</Empty>}
          {data && data.items.length > 0 && (
            <div className="table-scroll">
              <table className="data-table growth-table">
                <thead>
                  <tr><th scope="col">Pasta</th><th scope="col">Situação</th><th scope="col" className="is-right">Antes</th><th scope="col" className="is-right">Depois</th><th scope="col" className="is-right">Variação</th><th scope="col"><span className="sr-only">Ações</span></th></tr>
                </thead>
                <tbody>
                  {data.items.slice(0, 300).map((item) => (
                    <tr key={item.path} onClick={() => showFolder(item.path)}>
                      <td title={item.path}>
                        <div className="growth-path">
                          <button type="button" className="link-cell truncate-start" onClick={(event) => { event.stopPropagation(); showFolder(item.path); }}><bdi>{item.path}</bdi></button>
                          <span className={`growth-bar ${item.delta > 0 ? 'is-up' : 'is-down'}`} aria-hidden="true"><span style={{ transform: `scaleX(${Math.abs(item.delta) / maxDelta})` }} /></span>
                        </div>
                      </td>
                      <td className="muted">{item.status === 'new' ? 'Nova' : item.status === 'removed' ? 'Removida' : 'Alterada'}</td>
                      <td className="is-right num muted">{formatBytes(item.before)}</td>
                      <td className="is-right num muted">{formatBytes(item.after)}</td>
                      <td className={`is-right num ${item.delta > 0 ? 'delta-up' : 'delta-down'}`}>{formatDelta(item.delta)}</td>
                      <td><IconButton icon="reveal" label="Mostrar no Explorador" onClick={() => void api.revealPath(item.path).then((found) => { if (!found) app.toast('Esta pasta não está na análise atual. Analise este local de novo.'); })} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
