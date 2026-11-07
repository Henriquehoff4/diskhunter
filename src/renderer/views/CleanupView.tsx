import { useState } from 'react';
import { RISK_NAMES, formatBytes, formatCount, formatDate, plural } from '../../shared/format';
import { FLAG, type Recommendation } from '../../shared/types';
import { CatDot, Empty, Icon, IconButton, Notice } from '../components/ui';
import { api, itemPath, useApp } from '../state';

const GROUP_ORDER = ['Temporários', 'Caches', 'Downloads', 'Desenvolvimento', 'Sistema'];

function RecRow({ rec, max }: { rec: Recommendation; max: number }) {
  const app = useApp();
  const [open, setOpen] = useState(false);
  const ids = rec.items.map((item) => item.id);
  const selected = ids.filter((id) => app.marked.has(id)).length;
  const selectedBytes = rec.items.filter((item) => app.marked.has(item.id)).reduce((sum, item) => sum + item.alloc, 0);
  const canAct = rec.action === 'trash';
  const all = selected === ids.length && ids.length > 0;
  const partial = rec.count > rec.items.length;

  return (
    <li className={`rec${open ? ' is-open' : ''}`}>
      <div className="rec-head">
        <button type="button" className="rec-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          <span className="rec-chevron"><Icon name="chevron" size={14} /></span>
          <span className="rec-title">{rec.title}</span>
          <span className={`risk risk-${rec.risk}`}>{canAct ? RISK_NAMES[rec.risk] : 'Só orientação'}</span>
        </button>
        <span className="rec-bar" aria-hidden="true"><span style={{ transform: `scaleX(${rec.bytes / max})` }} /></span>
        <span className="rec-size num">{formatBytes(rec.bytes)}</span>
        <span className="rec-count num muted">{plural(rec.count, 'item', 'itens')}</span>
        {canAct ? (
          <button type="button" className={`button${all ? ' is-on' : ''}`} aria-pressed={all} onClick={() => (all ? app.unmark(ids) : app.mark(rec.items.map((item) => ({ id: item.id, name: item.name, bytes: item.alloc }))))}>
            {all ? 'Selecionado' : 'Selecionar'}
          </button>
        ) : rec.id === 'recycle' ? (
          <button type="button" className="button" onClick={() => void api.openRecycleBin()}>Abrir a Lixeira</button>
        ) : <span />}
      </div>
      <div className="rec-detail" hidden={!open}>
        {open && (
          <>
            <p className="rec-why">{rec.why}{rec.note ? ` ${rec.note}` : ''}</p>
            {canAct && selected > 0 && <p className="fine num">{plural(selected, 'item selecionado', 'itens selecionados')}, {formatBytes(selectedBytes)}</p>}
            {partial && <p className="fine">Mostrando os {formatCount(rec.items.length)} maiores de {formatCount(rec.count)} itens. Selecionar inclui só os exibidos.</p>}
            <ul className="rec-items">
              {rec.items.slice(0, 200).map((item) => (
                <li key={item.id} className={app.inspected === item.id ? 'is-inspected' : ''}>
                  {canAct ? (
                    <input type="checkbox" checked={app.marked.has(item.id)} aria-label={`Marcar ${item.name}`} onChange={() => (app.marked.has(item.id) ? app.unmark([item.id]) : app.mark([{ id: item.id, name: item.name, bytes: item.alloc }]))} />
                  ) : <span />}
                  <button type="button" className="rec-item" onClick={() => app.inspect(item.id)} title={itemPath(item)}>
                    {item.flags & FLAG.dir ? <Icon name="folder" size={14} /> : <CatDot cat={item.cat} />}
                    <span className="truncate">{item.name}</span>
                    <span className="truncate-start muted"><bdi>{item.dir}</bdi></span>
                  </button>
                  <span className="muted num">{formatDate(item.mtime)}</span>
                  <span className="num">{formatBytes(item.alloc)}</span>
                  <IconButton icon="reveal" label="Mostrar no Explorador" onClick={() => void api.reveal(item.id)} />
                </li>
              ))}
            </ul>
            {rec.items.length > 200 && <p className="fine">Mais {formatCount(rec.items.length - 200)} itens estão na seleção, mas não aparecem nesta lista. Veja todos em Revisar e excluir.</p>}
          </>
        )}
      </div>
    </li>
  );
}

export function CleanupView() {
  const app = useApp();
  const data = app.cleanup;
  if (!data) return <div className="page"><h1 className="page-title">Limpeza</h1><p className="muted">Calculando recomendações</p></div>;
  const max = Math.max(1, ...data.items.map((r) => r.bytes));
  const groups = GROUP_ORDER.map((name) => ({ name, items: data.items.filter((r) => r.group === name) })).filter((g) => g.items.length > 0);
  return (
    <div className="page">
      <div className="title-row">
        <div>
          <h1 className="page-title">{data.recoverable > 0 ? <>Até <span className="num">{formatBytes(data.recoverable)}</span> recuperáveis</> : 'Limpeza'}</h1>
          <p className="page-lead">Nada é apagado sozinho. Escolha o que excluir, revise a lista e confirme. Os itens vão para a Lixeira.</p>
        </div>
      </div>
      <Notice>A estimativa soma o espaço em disco dos itens. Arquivos em uso são pulados na hora de excluir, então o ganho real pode ser menor.</Notice>
      {data.items.length === 0 && <Empty title="Nada para limpar">Esta análise não encontrou temporários, caches ou downloads antigos.</Empty>}
      {groups.map((group) => (
        <section key={group.name} aria-label={group.name}>
          <h2 className="section-title">{group.name}</h2>
          <ul className="rec-list">
            {group.items.map((rec) => <RecRow key={rec.id} rec={rec} max={max} />)}
          </ul>
        </section>
      ))}
    </div>
  );
}
