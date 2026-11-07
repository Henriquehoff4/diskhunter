import { useEffect, useState } from 'react';
import type { AppInfo } from '../../shared/types';
import { IconButton } from '../components/ui';
import { api, useApp } from '../state';

function NumberField({ label, value, onCommit, hint }: { label: string; value: number; onCommit: (value: number) => void; hint: string }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  return (
    <label className="field">
      <span>{label}</span>
      <input
        className="input num"
        inputMode="numeric"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onBlur={() => {
          const parsed = Number(text);
          if (Number.isFinite(parsed) && parsed > 0) onCommit(parsed);
          else setText(String(value));
        }}
      />
      <span className="fine">{hint}</span>
    </label>
  );
}

export function SettingsView() {
  const app = useApp();
  const { settings } = app;
  const [info, setInfo] = useState<AppInfo | null>(null);
  useEffect(() => {
    void api.info().then(setInfo);
  }, []);

  const addExclude = async () => {
    const folder = await api.pickFolder();
    if (folder && !settings.excludes.includes(folder)) await app.updateSettings({ excludes: [...settings.excludes, folder] });
  };

  return (
    <div className="page settings">
      <h1 className="page-title">Ajustes</h1>
      <section className="settings-row">
        <div><h2 className="section-title">Medida de tamanho</h2><p className="muted">Em disco é o espaço de fato ocupado. Tamanho é o valor nominal, que conta arquivos só na nuvem e ignora compressão.</p></div>
        <div className="settings-panel">
          <label className="check-line"><input type="radio" name="metric" checked={settings.metric === 'alloc'} onChange={() => void app.updateSettings({ metric: 'alloc' })} /><span>Em disco</span></label>
          <label className="check-line"><input type="radio" name="metric" checked={settings.metric === 'size'} onChange={() => void app.updateSettings({ metric: 'size' })} /><span>Tamanho</span></label>
        </div>
      </section>
      <section className="settings-row">
        <div><h2 className="section-title">Pastas ignoradas</h2><p className="muted">Não são lidas nas próximas análises.</p></div>
        <div className="settings-panel">
          {settings.excludes.length === 0 ? <p className="muted">Nenhuma pasta ignorada.</p> : (
            <ul className="exclude-list">
              {settings.excludes.map((folder) => (
                <li key={folder}>
                  <span className="truncate" title={folder}>{folder}</span>
                  <IconButton icon="close" label={`Parar de ignorar ${folder}`} onClick={() => void app.updateSettings({ excludes: settings.excludes.filter((f) => f !== folder) })} />
                </li>
              ))}
            </ul>
          )}
          <button type="button" className="button" onClick={() => void addExclude()}>Adicionar pasta</button>
        </div>
      </section>
      <section className="settings-row">
        <div><h2 className="section-title">Recomendações</h2><p className="muted">Valem a partir da próxima análise ou exclusão.</p></div>
        <div className="settings-panel settings-fields">
          <NumberField label="Downloads antigos, em dias" value={settings.downloadsDays} hint="Itens sem alteração há mais tempo que isso." onCommit={(value) => void app.updateSettings({ downloadsDays: value })} />
          <NumberField label="Instaladores esquecidos, em dias" value={settings.installerDays} hint="Instaladores em Downloads, Desktop e Documentos." onCommit={(value) => void app.updateSettings({ installerDays: value })} />
        </div>
      </section>
      <section className="settings-row">
        <div><h2 className="section-title">Proteção</h2><p className="muted">Sempre ativa e não pode ser desligada.</p></div>
        <div className="settings-panel">
          <ul className="bullet-list">
            <li>Nada é excluído sem revisão e confirmação sua.</li>
            <li>Windows, Arquivos de Programas, ProgramData e pastas do perfil são recusados. Exceções: temporários e caches conhecidos.</li>
            <li>Antes de excluir, cada item é conferido de novo. Se mudou desde a análise, fica onde está.</li>
            <li>Links não são seguidos, então não há risco de excluir o destino deles.</li>
            <li>Toda exclusão fica registrada em Relatórios.</li>
          </ul>
        </div>
      </section>
      <section className="settings-row">
        <div><h2 className="section-title">Sobre</h2></div>
        <div className="settings-panel">
          <p>DiskHunter {info?.version}{info?.isAdmin ? ', em modo administrador' : ''}</p>
          {info && !info.isAdmin && (
            <button type="button" className="button" onClick={() => void api.relaunchAsAdmin().then((result) => { if (!result.ok && result.reason) app.toast(result.reason, 'error'); })}>
              Abrir como administrador
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
