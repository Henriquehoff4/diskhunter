import { useEffect, useState } from 'react';
import { formatBytes, formatCount, formatDateTime, winError } from '../../shared/format';
import type { AppInfo, HistoryEntry, ReportFormat, ScanErrorsPage } from '../../shared/types';
import { Notice } from '../components/ui';
import { api, errorText, useApp } from '../state';

const FORMATS: { format: ReportFormat; title: string; text: string }[] = [
  { format: 'html', title: 'Página HTML', text: 'Para ler, imprimir ou enviar a alguém.' },
  { format: 'csv', title: 'Planilha CSV', text: 'Abre no Excel, com ponto e vírgula e acentos corretos.' },
  { format: 'json', title: 'JSON', text: 'Para scripts e automações.' },
];

export function ReportsView() {
  const app = useApp();
  const [busy, setBusy] = useState<ReportFormat | null>(null);
  const [last, setLast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [errors, setErrors] = useState<ScanErrorsPage | null>(null);
  const [info, setInfo] = useState<AppInfo | null>(null);

  useEffect(() => {
    void api.history().then(setHistory);
    void api.info().then(setInfo);
    if (app.summary) void api.call<ScanErrorsPage>('scan.errors', { limit: 200 }).then(setErrors).catch(() => undefined);
  }, [app.version, app.summary]);

  const run = async (format: ReportFormat) => {
    setBusy(format);
    setError(null);
    setLast(null);
    try {
      const result = await api.exportReport(format);
      if (result) {
        setLast(result.path);
        app.toast('Relatório salvo.');
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="page">
      <div className="title-row">
        <div>
          <h1 className="page-title">Relatórios</h1>
          <p className="page-lead">Reúne o resumo, os maiores arquivos e pastas, os tipos, as recomendações, os modelos de IA e as duplicatas encontradas.</p>
        </div>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      {last && <Notice>Salvo em {last}</Notice>}
      <section aria-labelledby="export-title">
        <h2 id="export-title" className="section-title">Exportar a análise atual</h2>
        {!app.summary ? <p className="muted">Faça uma análise para exportar.</p> : (
          <ul className="export-list">
            {FORMATS.map((item) => (
              <li key={item.format}>
                <span><strong>{item.title}</strong><span className="muted"> {item.text}</span></span>
                <button type="button" className="button" disabled={busy !== null} onClick={() => void run(item.format)}>{busy === item.format ? 'Gerando' : 'Exportar'}</button>
              </li>
            ))}
          </ul>
        )}
      </section>
      {errors && errors.total > 0 && (
        <section aria-labelledby="denied-title">
          <div className="section-head">
            <h2 id="denied-title" className="section-title">{formatCount(errors.total)} {errors.total === 1 ? 'pasta sem acesso' : 'pastas sem acesso'}</h2>
            {info && !info.isAdmin && (
              <button type="button" className="button" onClick={() => void api.relaunchAsAdmin().then((result) => { if (!result.ok && result.reason) app.toast(result.reason, 'error'); })}>
                Abrir como administrador
              </button>
            )}
          </div>
          <ul className="plain-list">
            {errors.items.map((item) => <li key={item.path}><span className="truncate-start" title={item.path}><bdi>{item.path}</bdi></span><span className="muted">{winError(item.code)}</span></li>)}
          </ul>
          {errors.total > errors.items.length && <p className="fine">Mostrando as primeiras {formatCount(errors.items.length)}.</p>}
        </section>
      )}
      <section aria-labelledby="history-title">
        <h2 id="history-title" className="section-title">Histórico de exclusões</h2>
        {history.length === 0 ? <p className="muted">Nada foi excluído pelo DiskHunter até agora.</p> : (
          <ul className="plain-list history-list">
            {history.slice(0, 200).map((entry, index) => (
              <li key={`${entry.time}${index}`}>
                <span className="truncate-start" title={entry.path}><bdi>{entry.path}</bdi></span>
                <span className="num muted">{formatBytes(entry.bytes)}</span>
                <span className={entry.ok ? 'muted' : 'danger-text'} title={entry.reason}>{entry.ok ? (entry.action === 'trash' ? 'Lixeira' : 'Permanente') : 'Falhou'}</span>
                <span className="muted">{formatDateTime(entry.time)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
