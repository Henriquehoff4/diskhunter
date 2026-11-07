import { useEffect, useState } from 'react';
import { formatBytes, formatCount, formatDuration, formatRelative } from '../../shared/format';
import type { Drive, Snapshot } from '../../shared/types';
import { Icon, Notice } from '../components/ui';
import { api, errorText, useApp } from '../state';

function Scanning() {
  const app = useApp();
  const progress = app.progress;
  if (!progress) return null;
  const known = progress.expected > 0;
  const ratio = known ? Math.min(0.995, progress.alloc / progress.expected) : 0;
  const rate = progress.elapsed > 0.2 ? progress.files / progress.elapsed : 0;
  return (
    <div className="scanning" role="status" aria-live="off">
      <h1 className="page-title">{progress.phase === 'finalize' ? 'Somando os totais' : 'Analisando'}</h1>
      <p className="scan-count num">{formatCount(progress.files)} <span>arquivos</span></p>
      <div className={`progress-track is-large${known ? '' : ' is-indeterminate'}`} role="progressbar" aria-label="Progresso da análise" aria-valuemin={0} aria-valuemax={100} aria-valuenow={known ? Math.round(ratio * 100) : undefined}>
        <span style={known ? { transform: `scaleX(${ratio})` } : undefined} />
      </div>
      <p className="scan-path truncate-start" title={progress.current}><bdi>{progress.current}</bdi></p>
      <dl className="kpis">
        <div><dt>Em disco</dt><dd className="num">{formatBytes(progress.alloc)}</dd></div>
        <div><dt>Pastas</dt><dd className="num">{formatCount(progress.dirs)}</dd></div>
        <div><dt>Velocidade</dt><dd className="num">{formatCount(rate)} arq/s</dd></div>
        <div><dt>Tempo</dt><dd className="num">{formatDuration(progress.elapsed)}</dd></div>
        <div><dt>Sem acesso</dt><dd className="num">{formatCount(progress.errors)}</dd></div>
      </dl>
      <button type="button" className="button" onClick={app.cancelScan}>Cancelar análise</button>
    </div>
  );
}

export function HomeView() {
  const app = useApp();
  const [drives, setDrives] = useState<Drive[] | null>(null);
  const [recent, setRecent] = useState<Snapshot[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.call<Drive[]>('drives.list').then(setDrives).catch((e) => setError(errorText(e)));
    api.call<Snapshot[]>('snapshots.list', {}).then((list) => {
      const seen = new Set<string>();
      setRecent(list.filter((s) => (seen.has(s.root.toLowerCase()) ? false : (seen.add(s.root.toLowerCase()), true))).slice(0, 6));
    }).catch(() => undefined);
  }, [app.version]);

  if (app.scanning) return <div className="page"><Scanning /></div>;

  const pick = async () => {
    const folder = await api.pickFolder();
    if (folder) await app.startScan(folder);
  };

  return (
    <div className="page page-narrow">
      <div className="title-row">
        <div>
          <h1 className="page-title">O que você quer analisar?</h1>
          <p className="page-lead">A análise só lê os nomes e tamanhos. Nada é alterado no disco.</p>
        </div>
        <button type="button" className="button" onClick={() => void pick()}><Icon name="folder" />Escolher pasta</button>
      </div>
      {app.scanError && <Notice tone="error">{app.scanError}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
      {app.summary && (
        <Notice action={<button type="button" className="button" onClick={() => app.go('overview')}>Voltar à análise</button>}>
          Análise de {app.summary.path} carregada, {formatBytes(app.summary.alloc)}.
        </Notice>
      )}
      <section aria-labelledby="drives-title">
        <h2 id="drives-title" className="section-title">Discos</h2>
        {drives === null ? <p className="muted">Procurando discos</p> : drives.length === 0 ? <p className="muted">Nenhum disco encontrado.</p> : (
          <ul className="drive-list">
            {drives.map((drive) => {
              const used = (drive.total ?? 0) - (drive.free ?? 0);
              const ratio = drive.total ? used / drive.total : 0;
              return (
                <li key={drive.path} className="drive">
                  <div className="drive-name">
                    <strong>{drive.path.replace(/\\$/, '')}</strong>
                    <span className="muted truncate">{drive.ready ? [drive.label || 'Sem nome', drive.format, drive.hdd ? 'HD' : drive.type === 'Fixed' ? 'SSD' : drive.type === 'Removable' ? 'Removível' : drive.type === 'Network' ? 'Rede' : null].filter(Boolean).join(', ') : 'Sem mídia'}</span>
                  </div>
                  {drive.ready ? (
                    <>
                      <div className="drive-bar" role="img" aria-label={`${Math.round(ratio * 100)}% usado`}><span style={{ transform: `scaleX(${ratio})` }} className={ratio > 0.9 ? 'is-full' : ''} /></div>
                      <div className="drive-numbers num"><span>{formatBytes(drive.free ?? 0)} livres</span><span className="muted">de {formatBytes(drive.total ?? 0)}</span></div>
                      <button type="button" className="button is-primary" onClick={() => void app.startScan(drive.path)}>Analisar</button>
                    </>
                  ) : <span className="drive-span muted">Indisponível</span>}
                </li>
              );
            })}
          </ul>
        )}
      </section>
      <section aria-labelledby="recent-title">
        <h2 id="recent-title" className="section-title">Análises anteriores</h2>
        {recent.length === 0 ? (
          <p className="muted">Cada análise completa fica guardada aqui para comparar o crescimento depois.</p>
        ) : (
          <ul className="recent-list">
            {recent.map((snapshot) => (
              <li key={`${snapshot.root}${snapshot.id}`}>
                <span className="truncate" title={snapshot.root}>{snapshot.root}</span>
                <span className="num muted">{formatBytes(snapshot.alloc)}</span>
                <span className="muted">{formatRelative(snapshot.time)}</span>
                <button type="button" className="button is-quiet" onClick={() => void app.startScan(snapshot.root)}>Analisar de novo</button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
