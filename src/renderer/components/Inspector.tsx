import { useEffect, useState } from 'react';
import { CATEGORY_NAMES, formatBytes, formatCount, formatDateTime, formatRelative } from '../../shared/format';
import { FLAG, type NodeInfo, type PreviewInfo } from '../../shared/types';
import { api, errorText, useApp } from '../state';
import { Icon, IconButton } from './ui';

function Preview({ id }: { id: number }) {
  const [preview, setPreview] = useState<PreviewInfo | null>(null);
  const [broken, setBroken] = useState(false);
  useEffect(() => {
    let alive = true;
    setPreview(null);
    setBroken(false);
    api.preview(id).then((value) => {
      if (alive) setPreview(value);
    }).catch(() => {
      if (alive) setPreview({ kind: 'none' });
    });
    return () => {
      alive = false;
    };
  }, [id]);
  if (!preview || preview.kind === 'none') {
    return preview?.reason ? <p className="preview-note">{preview.reason}</p> : null;
  }
  if (broken) {
    return preview.thumb ? <div className="preview"><img src={preview.thumb} alt="Miniatura do arquivo" /></div> : <p className="preview-note">Este formato não pode ser pré-visualizado aqui.</p>;
  }
  if (preview.kind === 'video') {
    return (
      <div className="preview">
        <video src={preview.url} poster={preview.thumb} controls preload="metadata" onError={() => setBroken(true)} aria-label="Pré-visualização do vídeo" />
      </div>
    );
  }
  return <div className="preview"><img src={preview.url ?? preview.thumb} alt="Pré-visualização da imagem" onError={() => setBroken(true)} /></div>;
}

export function Inspector({ id }: { id: number }) {
  const app = useApp();
  const [info, setInfo] = useState<NodeInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setError(null);
    api.call<NodeInfo[]>('node.info', { ids: [id] }).then(([value]) => {
      if (!alive) return;
      if (!value || value.gone) app.inspect(null);
      else setInfo(value);
    }).catch((e) => {
      if (alive) setError(errorText(e));
    });
    return () => {
      alive = false;
    };
  }, [id, app.version]);

  const close = (
    <IconButton icon="close" label="Fechar detalhes" onClick={() => app.inspect(null)} />
  );
  if (error) return <aside className="inspector" aria-label="Detalhes"><div className="inspector-head"><span />{close}</div><p className="danger-text">{error}</p></aside>;
  if (!info || info.id !== id) return <aside className="inspector" aria-label="Detalhes"><div className="inspector-head"><span className="skeleton" style={{ width: 160 }} />{close}</div></aside>;

  const isDir = (info.flags & FLAG.dir) !== 0;
  const marked = app.marked.has(id);
  const notes: string[] = [];
  if (info.flags & FLAG.hardlinkDup) notes.push('Este arquivo é um link físico de outro caminho já contado. Excluir só este nome não libera espaço.');
  if (info.flags & FLAG.cloud) notes.push('O conteúdo está só na nuvem. O DiskHunter não abre este arquivo para não disparar o download.');
  if (info.flags & FLAG.link) notes.push('Link para outro local. Não é seguido na análise e não conta no tamanho.');
  if (info.flags & FLAG.denied) notes.push('Sem permissão para ler o conteúdo. O tamanho real pode ser maior.');
  if (info.flags & FLAG.partial) notes.push('Só parte do conteúdo pôde ser lida.');
  if (info.flags & FLAG.excluded) notes.push('Pasta excluída da análise nos ajustes.');

  return (
    <aside className="inspector" aria-label={`Detalhes de ${info.name}`}>
      <div className="inspector-head">
        <h2 className="inspector-name" title={info.name}>{info.name}</h2>
        {close}
      </div>
      {!isDir && <Preview id={id} />}
      <p className="inspector-path">{info.path}</p>
      <dl className="meta-list">
        <div><dt>Em disco</dt><dd className="num">{formatBytes(info.alloc)}</dd></div>
        <div><dt>Tamanho</dt><dd className="num">{formatBytes(info.size)}</dd></div>
        {isDir ? (
          <div><dt>Arquivos</dt><dd className="num">{formatCount(info.files)}</dd></div>
        ) : (
          <div><dt>Tipo</dt><dd>{info.ext ? `.${info.ext}, ${CATEGORY_NAMES[info.cat]}` : CATEGORY_NAMES[info.cat]}</dd></div>
        )}
        <div><dt>Modificado</dt><dd title={formatDateTime(info.mtime)}>{formatRelative(info.mtime)}</dd></div>
      </dl>
      {notes.map((note) => <p key={note} className="inspector-note">{note}</p>)}
      <div className="inspector-actions">
        <button type="button" className="button" onClick={() => void api.reveal(id)}><Icon name="reveal" />Mostrar no Explorador</button>
        <button
          type="button"
          className="button"
          onClick={() => void api.open(id).then((result) => {
            if (!result.ok && result.reason) app.toast(result.reason);
          })}
        >
          <Icon name="open" />Abrir
        </button>
        <button
          type="button"
          className="button"
          onClick={() => void api.copyPath(id).then(() => app.toast('Caminho copiado.'))}
        >
          <Icon name="copy" />Copiar caminho
        </button>
        {isDir && <button type="button" className="button" onClick={() => app.openMap(id)}><Icon name="map" />Ver no mapa</button>}
        {isDir && (
          <button type="button" className="button" onClick={() => { app.setExplore({ kind: 'file', sort: 'size', within: id }); app.go('explore'); }}>
            <Icon name="explore" />Procurar aqui dentro
          </button>
        )}
        <button
          type="button"
          className={`button${marked ? ' is-on' : ''}`}
          aria-pressed={marked}
          onClick={() => (marked ? app.unmark([id]) : app.mark([{ id, name: info.name, bytes: info.alloc }]))}
        >
          <Icon name={marked ? 'check' : 'cleanup'} />{marked ? 'Marcado para excluir' : 'Marcar para excluir'}
        </button>
      </div>
    </aside>
  );
}
