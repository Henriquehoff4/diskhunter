import { formatBytes, formatCount, formatDate, plural } from '../../shared/format';
import { Empty, IconButton } from '../components/ui';
import { api, useApp } from '../state';

export function ModelsView() {
  const app = useApp();
  const data = app.models;
  if (!data) return <div className="page"><h1 className="page-title">Modelos de IA</h1><p className="muted">Lendo os cabeçalhos dos arquivos</p></div>;
  const formats = new Map<string, number>();
  for (const model of data.items) formats.set(model.format, (formats.get(model.format) ?? 0) + model.size);
  const sorted = [...formats.entries()].sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...sorted.map(([, bytes]) => bytes));
  return (
    <div className="page">
      <div className="title-row">
        <div>
          <h1 className="page-title">{data.items.length > 0 ? <><span className="num">{formatBytes(data.bytes)}</span> em {plural(data.items.length, 'modelo', 'modelos')} de IA</> : 'Modelos de IA'}</h1>
          <p className="page-lead">GGUF, SafeTensors, checkpoints, PyTorch, ONNX e outros. A assinatura de cada arquivo é conferida no cabeçalho, sem carregar o modelo.</p>
        </div>
      </div>
      {data.items.length === 0 ? (
        <Empty title="Nenhum modelo encontrado">Procuramos arquivos a partir de 1 MB por extensão e nas pastas do Ollama, LM Studio, Hugging Face, ComfyUI e similares.</Empty>
      ) : (
        <>
          <section aria-label="Espaço por formato">
            <ul className="format-list">
              {sorted.map(([format, bytes]) => (
                <li key={format}>
                  <span>{format}</span>
                  <span className="age-track" aria-hidden="true"><span style={{ transform: `scaleX(${bytes / max})` }} /></span>
                  <span className="num muted">{formatBytes(bytes)}</span>
                </li>
              ))}
            </ul>
          </section>
          <div className="table-scroll">
            <table className="data-table models-table">
              <thead>
                <tr><th scope="col"><span className="sr-only">Marcar</span></th><th scope="col">Modelo</th><th scope="col">Formato</th><th scope="col">Detalhes</th><th scope="col">Origem</th><th scope="col">Modificado</th><th scope="col" className="is-right">Tamanho</th><th scope="col"><span className="sr-only">Ações</span></th></tr>
              </thead>
              <tbody>
                {data.items.map((model) => {
                  const marked = model.partIds.every((id) => app.marked.has(id));
                  const perPart = model.size / Math.max(1, model.partIds.length);
                  const details = [model.arch, model.quant, model.tensors != null ? `${formatCount(model.tensors)} tensores` : null, model.parts > 1 ? `${model.parts} partes` : null].filter(Boolean).join(', ');
                  return (
                    <tr key={model.id} className={app.inspected === model.id ? 'is-inspected' : ''} onClick={() => app.inspect(model.id)}>
                      <td onClick={(event) => event.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={marked}
                          aria-label={`Marcar ${model.name} para exclusão`}
                          onChange={() => (marked ? app.unmark(model.partIds) : app.mark(model.partIds.map((id) => ({ id, name: model.name, bytes: perPart }))))}
                        />
                      </td>
                      <td title={model.path}>
                        <div className="model-name">
                          <button type="button" className="link-cell truncate" onClick={(event) => { event.stopPropagation(); app.inspect(model.id); }}>{model.name}</button>
                          <span className="truncate-start muted fine"><bdi>{model.path}</bdi></span>
                        </div>
                      </td>
                      <td>{model.format}{model.confidence === 'likely' && <span className="tag" title="O formato veio da extensão. A assinatura não pôde ser conferida.">provável</span>}</td>
                      <td className="muted">{details || '—'}</td>
                      <td className="muted">{model.runner ?? '—'}</td>
                      <td className="muted num">{formatDate(model.mtime)}</td>
                      <td className="is-right num">{formatBytes(model.size)}</td>
                      <td><IconButton icon="reveal" label="Mostrar no Explorador" onClick={() => void api.reveal(model.id)} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
