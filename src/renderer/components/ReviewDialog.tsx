import { useEffect, useRef, useState } from 'react';
import { formatBytes, formatCount, plural } from '../../shared/format';
import type { DeleteOutcome, DeletePlan, DeleteProgress } from '../../shared/types';
import { api, errorText, useApp } from '../state';
import { Icon, Notice } from './ui';

export function ReviewDialog() {
  const app = useApp();
  const dialog = useRef<HTMLDialogElement>(null);
  const [plan, setPlan] = useState<DeletePlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [typed, setTyped] = useState('');
  const [progress, setProgress] = useState<DeleteProgress | null>(null);
  const [outcome, setOutcome] = useState<DeleteOutcome | null>(null);
  const [running, setRunning] = useState(false);

  const buildPlan = (ids: number[], keep: Record<number, number>, permanent: boolean) => {
    setPlan(null);
    setError(null);
    setConfirmed(false);
    setTyped('');
    api.planDelete({ ids, keep, permanent }).then(setPlan).catch((e) => setError(errorText(e)));
  };

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (app.reviewOpen) {
      if (!element.open) element.showModal();
      setOutcome(null);
      const items = [...app.marked.values()];
      const keep: Record<number, number> = {};
      for (const item of items) if (item.keep !== undefined) keep[item.id] = item.keep;
      buildPlan(items.map((item) => item.id), keep, false);
    } else if (element.open) {
      element.close();
    }
  }, [app.reviewOpen]);

  useEffect(() => api.onDeleteProgress(setProgress), []);

  const run = async () => {
    if (!plan) return;
    setRunning(true);
    setError(null);
    try {
      const result = await api.runDelete(plan.token);
      setOutcome(result);
      setPlan(null);
      const failedIds = new Set(result.failed.map((f) => f.id));
      if (result.moved > 0) {
        app.unmark(plan.entries.filter((e) => e.status === 'ok' && !failedIds.has(e.id)).map((e) => e.id));
        await app.bump();
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setRunning(false);
      setProgress(null);
    }
  };

  const close = () => app.setReviewOpen(false);
  const permanent = plan?.permanent ?? false;
  const canRun = plan !== null && plan.allowed > 0 && !running && (permanent ? typed.trim().toUpperCase() === 'EXCLUIR' : confirmed);

  return (
    <dialog ref={dialog} className="dialog review" aria-labelledby="review-title" onCancel={(event) => { event.preventDefault(); if (!running) close(); }}>
      <div className="dialog-head">
        <h2 id="review-title">{outcome ? 'Resultado' : permanent ? 'Excluir permanentemente' : 'Revisar antes de excluir'}</h2>
        <button type="button" className="icon-button" onClick={close} disabled={running} aria-label="Fechar"><Icon name="close" /></button>
      </div>

      {error && <Notice tone="error">{error}</Notice>}
      {!plan && !outcome && !error && <p className="muted">Conferindo cada item</p>}

      {plan && !running && (
        <>
          <p className="review-lead">
            {plan.allowed > 0 ? (
              <><strong className="num">{plural(plan.allowed, 'item', 'itens')}</strong> somando <strong className="num">{formatBytes(plan.bytes)}</strong> {permanent ? 'serão apagados sem passar pela Lixeira.' : 'irão para a Lixeira.'}</>
            ) : 'Nenhum item da seleção pode ser excluído.'}
            {plan.refused > 0 && <> {plural(plan.refused, 'item foi recusado', 'itens foram recusados')} pela proteção.</>}
          </p>
          {!permanent && plan.allowed > 0 && <p className="muted">O espaço só volta depois de esvaziar a Lixeira. Até lá, dá para restaurar qualquer item.</p>}
          <ul className="review-list">
            {plan.entries.slice(0, 500).map((entry) => (
              <li key={entry.id} className={entry.status === 'refused' ? 'is-refused' : ''}>
                <Icon name={entry.isDir ? 'folder' : 'file'} size={14} />
                <span className="review-path">
                  <span className="truncate" title={entry.path}>{entry.path || entry.name}</span>
                  {entry.reason && <span className="review-reason">{entry.reason}</span>}
                </span>
                <span className="num muted">{entry.status === 'ok' ? formatBytes(entry.bytes) : 'recusado'}</span>
              </li>
            ))}
          </ul>
          {plan.entries.length > 500 && <p className="muted">E mais {formatCount(plan.entries.length - 500)} itens.</p>}
          {plan.allowed > 0 && (permanent ? (
            <label className="field">
              <span>Escreva EXCLUIR para confirmar. Não há como desfazer.</span>
              <input className="input" value={typed} onChange={(event) => setTyped(event.target.value)} autoComplete="off" spellCheck={false} />
            </label>
          ) : (
            <label className="check-line">
              <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
              <span>Revisei a lista e quero mover estes itens para a Lixeira</span>
            </label>
          ))}
          <div className="dialog-actions">
            <button type="button" className="button" onClick={close}>Voltar sem excluir</button>
            <button type="button" className={permanent ? 'button is-danger' : 'button is-primary'} disabled={!canRun} onClick={() => void run()}>
              {permanent ? 'Excluir permanentemente' : `Mover ${plural(plan.allowed, 'item', 'itens')} para a Lixeira`}
            </button>
          </div>
        </>
      )}

      {running && (
        <div className="review-progress" role="status">
          <p>{progress ? `${formatCount(progress.done)} de ${formatCount(progress.total)}` : 'Começando'}</p>
          <div className="progress-track"><span style={{ transform: `scaleX(${progress && progress.total ? progress.done / progress.total : 0})` }} /></div>
          <p className="muted truncate">{progress?.current}</p>
          <div className="dialog-actions"><button type="button" className="button" onClick={() => void api.cancelDelete()}>Parar depois do item atual</button></div>
        </div>
      )}

      {outcome && (
        <>
          <p className="review-lead">
            {outcome.moved > 0
              ? <><strong className="num">{plural(outcome.moved, 'item', 'itens')}</strong> {outcome.permanent ? 'apagados' : 'na Lixeira'}, somando <strong className="num">{formatBytes(outcome.bytes)}</strong>.</>
              : 'Nenhum item foi excluído.'}
            {outcome.cancelled && ' A operação foi interrompida.'}
          </p>
          {outcome.failed.length > 0 && (
            <>
              <p>{plural(outcome.failed.length, 'item não foi excluído', 'itens não foram excluídos')} e {outcome.failed.length === 1 ? 'continua' : 'continuam'} no disco:</p>
              <ul className="review-list">
                {outcome.failed.slice(0, 200).map((item) => (
                  <li key={item.id} className="is-refused">
                    <Icon name="warning" size={14} />
                    <span className="review-path"><span className="truncate" title={item.path}>{item.path}</span><span className="review-reason">{item.reason}</span></span>
                  </li>
                ))}
              </ul>
            </>
          )}
          <div className="dialog-actions">
            {!outcome.permanent && outcome.moved > 0 && <button type="button" className="button" onClick={() => void api.openRecycleBin()}>Abrir a Lixeira</button>}
            {!outcome.permanent && outcome.failed.length > 0 && (
              <button
                type="button"
                className="button is-danger-outline"
                onClick={() => {
                  const ids = outcome.failed.map((f) => f.id);
                  const keep: Record<number, number> = {};
                  for (const id of ids) {
                    const marked = app.marked.get(id);
                    if (marked?.keep !== undefined) keep[id] = marked.keep;
                  }
                  setOutcome(null);
                  buildPlan(ids, keep, true);
                }}
              >
                Excluir sem usar a Lixeira
              </button>
            )}
            <button type="button" className="button is-primary" onClick={close}>Concluir</button>
          </div>
        </>
      )}
    </dialog>
  );
}
