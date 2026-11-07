import { useEffect, useState } from 'react';
import { formatBytes, formatCount, formatDate, formatDuration, plural } from '../../shared/format';
import type { DupGroup, DupPage, Item } from '../../shared/types';
import { Empty, IconButton, Notice } from '../components/ui';
import { api, errorText, itemPath, useApp } from '../state';

const STAGES = { group: 'Agrupando por tamanho', partial: 'Comparando trechos dos arquivos', hash: 'Calculando SHA-256', verify: 'Conferindo byte a byte' };
const PAGE = 100;

type Strategy = 'oldest' | 'newest' | 'shortest';

function chooseKeeper(files: Item[], strategy: Strategy): Item {
  const sorted = [...files];
  if (strategy === 'oldest') sorted.sort((a, b) => a.mtime - b.mtime);
  else if (strategy === 'newest') sorted.sort((a, b) => b.mtime - a.mtime);
  else sorted.sort((a, b) => itemPath(a).length - itemPath(b).length);
  return sorted[0];
}

function GroupCard({ group }: { group: DupGroup }) {
  const app = useApp();
  const remark = (selected: Set<number>) => {
    const keeper = group.files.find((file) => !selected.has(file.id));
    if (!keeper) return;
    app.unmark(group.files.map((file) => file.id));
    app.mark(group.files.filter((file) => selected.has(file.id)).map((file) => ({ id: file.id, name: file.name, bytes: file.alloc, keep: keeper.id })));
  };
  return (
    <li className="dup-group">
      <div className="dup-head">
        <strong className="num">{plural(group.files.length, 'cópia', 'cópias')}</strong>
        <span className="num muted">{formatBytes(group.size)} cada</span>
        <span className="num">{formatBytes(group.wasted)} a recuperar</span>
        <span className="dup-hash muted" title={`SHA-256 ${group.hash}`}>SHA-256 {group.hash.slice(0, 12)}</span>
      </div>
      <ul className="dup-files">
        {group.files.map((file) => {
          const marked = app.marked.has(file.id);
          const others = group.files.filter((other) => other.id !== file.id && !app.marked.has(other.id));
          const blocked = !marked && others.length === 0;
          return (
            <li key={file.id} className={marked ? 'is-marked' : ''}>
              <input
                type="checkbox"
                checked={marked}
                disabled={blocked}
                aria-label={`Marcar ${itemPath(file)} para exclusão`}
                title={blocked ? 'Pelo menos uma cópia precisa ficar.' : undefined}
                onChange={() => {
                  const selected = new Set(group.files.filter((other) => app.marked.has(other.id)).map((other) => other.id));
                  if (marked) selected.delete(file.id);
                  else selected.add(file.id);
                  remark(selected);
                }}
              />
              <button type="button" className="dup-path" onClick={() => app.inspect(file.id)} title={itemPath(file)}>
                <span className="truncate-start"><bdi>{itemPath(file)}</bdi></span>
              </button>
              <span className="muted num">{formatDate(file.mtime)}</span>
              <span className={marked ? 'dup-state is-out' : 'dup-state'}>{marked ? 'Sai' : 'Fica'}</span>
              <IconButton icon="reveal" label="Mostrar no Explorador" onClick={() => void api.reveal(file.id)} />
            </li>
          );
        })}
      </ul>
    </li>
  );
}

export function DuplicatesView() {
  const app = useApp();
  const [page, setPage] = useState<DupPage | null>(null);
  const [limit, setLimit] = useState(PAGE);
  const [minSize, setMinSize] = useState(String(app.settings.dupMinMB));
  const [includeSystem, setIncludeSystem] = useState(app.settings.dupIncludeSystem);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (app.dupRunning) return;
    void api.call<DupPage | null>('dups.page', { limit }).then(setPage).catch((e) => setError(errorText(e)));
  }, [app.dupRunning, app.dupSummary, app.version, limit]);

  const start = async () => {
    setError(null);
    setPage(null);
    const mb = Math.max(0, Number(minSize.replace(',', '.')) || 0);
    await app.updateSettings({ dupMinMB: mb, dupIncludeSystem: includeSystem });
    try {
      await api.call('dups.start', { minSize: Math.max(1, Math.round(mb * 1048576)), includeSystem });
    } catch (e) {
      setError(errorText(e));
    }
  };

  const applyStrategy = (strategy: Strategy) => {
    if (!page) return;
    const marks = page.items.flatMap((group) => {
      if (group.files.length < 2) return [];
      const keeper = chooseKeeper(group.files, strategy);
      return group.files.filter((file) => file.id !== keeper.id).map((file) => ({ id: file.id, name: file.name, bytes: file.alloc, keep: keeper.id }));
    });
    app.unmark(page.items.flatMap((group) => group.files.map((file) => file.id)));
    app.mark(marks);
  };

  const progress = app.dupProgress;
  const ratio = progress && progress.bytesTotal > 0 ? Math.min(1, progress.bytesDone / progress.bytesTotal) : 0;

  return (
    <div className="page">
      <div className="title-row">
        <div>
          <h1 className="page-title">{page && page.wasted > 0 ? <>Duplicatas ocupam <span className="num">{formatBytes(page.wasted)}</span> à toa</> : 'Duplicatas'}</h1>
          <p className="page-lead">Só entram aqui arquivos com o mesmo tamanho, o mesmo SHA-256 e conteúdo conferido byte a byte. Links físicos e arquivos só na nuvem ficam de fora.</p>
        </div>
      </div>

      <form className="dup-form" onSubmit={(event) => { event.preventDefault(); void start(); }}>
        <label className="field field-small">
          <span>Tamanho mínimo (MB)</span>
          <input className="input num" inputMode="decimal" value={minSize} onChange={(event) => setMinSize(event.target.value)} disabled={app.dupRunning} />
        </label>
        <label className="check-line">
          <input type="checkbox" checked={includeSystem} onChange={(event) => setIncludeSystem(event.target.checked)} disabled={app.dupRunning} />
          <span>Incluir pastas do sistema (Windows, Arquivos de Programas)</span>
        </label>
        {app.dupRunning ? (
          <button type="button" className="button" onClick={() => void api.call('dups.cancel')}>Cancelar busca</button>
        ) : (
          <button type="submit" className="button is-primary">{page ? 'Procurar de novo' : 'Procurar duplicatas'}</button>
        )}
      </form>

      {error && <Notice tone="error">{error}</Notice>}
      {app.dupError && <Notice tone="error">{app.dupError}</Notice>}

      {app.dupRunning && (
        <div className="dup-progress" role="status">
          <p>{progress ? STAGES[progress.stage] : 'Começando'}{progress && progress.groups > 0 ? `, ${plural(progress.groups, 'grupo confirmado', 'grupos confirmados')}` : ''}</p>
          <div className="progress-track"><span style={{ transform: `scaleX(${ratio})` }} /></div>
          {progress && <p className="muted num">{formatBytes(progress.bytesDone)} de {formatBytes(progress.bytesTotal)}, {plural(progress.candidates, 'arquivo candidato', 'arquivos candidatos')}</p>}
        </div>
      )}

      {page && !app.dupRunning && (
        <>
          {page.cancelled && <Notice tone="warning">A busca foi cancelada. A lista pode estar incompleta.</Notice>}
          {page.skipped > 0 && <Notice tone="warning">{plural(page.skipped, 'arquivo não pôde ser lido e ficou', 'arquivos não puderam ser lidos e ficaram')} de fora, ou mudou durante a busca.</Notice>}
          {page.items.length === 0 ? (
            <Empty title="Nenhuma duplicata encontrada">{formatCount(page.scanned)} arquivos candidatos foram conferidos em {formatDuration(page.elapsed)}.</Empty>
          ) : (
            <>
              <div className="dup-toolbar">
                <span className="muted num">{plural(page.groups, 'grupo', 'grupos')}, conferido em {formatDuration(page.elapsed)}</span>
                <span className="dup-actions">
                  <span className="muted">Selecionar automaticamente, mantendo a</span>
                  <button type="button" className="button" onClick={() => applyStrategy('oldest')}>mais antiga</button>
                  <button type="button" className="button" onClick={() => applyStrategy('newest')}>mais recente</button>
                  <button type="button" className="button" onClick={() => applyStrategy('shortest')}>de caminho mais curto</button>
                </span>
              </div>
              <ul className="dup-list">
                {page.items.map((group) => <GroupCard key={group.hash + group.files[0]?.id} group={group} />)}
              </ul>
              {page.groups > limit && <button type="button" className="button" onClick={() => setLimit(limit + PAGE)}>Mostrar mais grupos</button>}
            </>
          )}
        </>
      )}
    </div>
  );
}
