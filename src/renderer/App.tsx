import { useEffect, useRef, useState } from 'react';
import { formatBytes, plural } from '../shared/format';
import { Inspector } from './components/Inspector';
import { ReviewDialog } from './components/ReviewDialog';
import { Icon, IconButton, Mark, useDebounced } from './components/ui';
import { CleanupView } from './views/CleanupView';
import { DuplicatesView } from './views/DuplicatesView';
import { ExploreView } from './views/ExploreView';
import { GrowthView } from './views/GrowthView';
import { HomeView } from './views/HomeView';
import { MapView } from './views/MapView';
import { ModelsView } from './views/ModelsView';
import { OverviewView } from './views/OverviewView';
import { ReportsView } from './views/ReportsView';
import { SettingsView } from './views/SettingsView';
import { useApp, type View } from './state';

const NAV: { view: View; label: string; icon: string; needsScan?: boolean }[] = [
  { view: 'home', label: 'Discos', icon: 'home' },
  { view: 'overview', label: 'Visão geral', icon: 'overview', needsScan: true },
  { view: 'map', label: 'Mapa do disco', icon: 'map', needsScan: true },
  { view: 'explore', label: 'Maiores e busca', icon: 'explore', needsScan: true },
  { view: 'cleanup', label: 'Limpeza', icon: 'cleanup', needsScan: true },
  { view: 'duplicates', label: 'Duplicatas', icon: 'duplicates', needsScan: true },
  { view: 'models', label: 'Modelos de IA', icon: 'models', needsScan: true },
  { view: 'growth', label: 'Crescimento', icon: 'growth' },
  { view: 'reports', label: 'Relatórios', icon: 'reports' },
];

function Sidebar() {
  const app = useApp();
  const counts: Partial<Record<View, string>> = {
    cleanup: app.cleanup ? formatBytes(app.cleanup.recoverable) : undefined,
    duplicates: app.dupSummary ? formatBytes(app.dupSummary.wasted) : undefined,
    models: app.models ? formatBytes(app.models.bytes) : undefined,
  };
  return (
    <nav className="sidebar" aria-label="Principal">
      <div className="brand">
        <Mark />
        <span className="brand-name">DiskHunter</span>
      </div>
      {app.summary && (
        <div className="scope" title={app.summary.path}>
          <span className="scope-path truncate">{app.summary.path}</span>
          <span className="scope-size num">{formatBytes(app.logical ? app.summary.size : app.summary.alloc)}{app.summary.cancelled ? ', incompleta' : ''}</span>
        </div>
      )}
      <ul className="nav-list">
        {NAV.map((item) => {
          const disabled = item.needsScan && !app.summary;
          const current = app.view === item.view;
          return (
            <li key={item.view}>
              <button type="button" className={`nav-item${current ? ' is-current' : ''}`} aria-current={current ? 'page' : undefined} disabled={disabled} onClick={() => app.go(item.view)}>
                <Icon name={item.icon} />
                <span className="nav-label">{item.label}</span>
                {counts[item.view] && <span className="nav-count num">{counts[item.view]}</span>}
              </button>
            </li>
          );
        })}
      </ul>
      <button type="button" className={`nav-item nav-bottom${app.view === 'settings' ? ' is-current' : ''}`} aria-current={app.view === 'settings' ? 'page' : undefined} onClick={() => app.go('settings')}>
        <Icon name="settings" />
        <span className="nav-label">Ajustes</span>
      </button>
    </nav>
  );
}

function TopBar() {
  const app = useApp();
  const [text, setText] = useState(app.explore.text ?? '');
  const debounced = useDebounced(text, 180);
  const input = useRef<HTMLInputElement>(null);
  const first = useRef(true);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (!app.summary) return;
    const value = debounced.trim();
    if ((app.explore.text ?? '') === value) return;
    app.setExplore({ ...app.explore, text: value || undefined });
    if (value) app.go('explore');
  }, [debounced]);

  useEffect(() => setText(app.explore.text ?? ''), [app.explore.text]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey && event.key.toLowerCase() === 'k') || (event.ctrlKey && event.key.toLowerCase() === 'f')) {
        event.preventDefault();
        input.current?.focus();
        input.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <header className="topbar">
      <div className="search">
        <Icon name="explore" />
        <input
          ref={input}
          type="search"
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="Procurar por nome, como relatório ou *.iso"
          aria-label="Procurar arquivos e pastas"
          disabled={!app.summary}
        />
        <kbd>Ctrl K</kbd>
      </div>
    </header>
  );
}

function Selection() {
  const app = useApp();
  const count = app.marked.size;
  if (count === 0) return null;
  let bytes = 0;
  for (const item of app.marked.values()) bytes += item.bytes;
  return (
    <div className="selection-bar" role="region" aria-label="Itens marcados">
      <span><strong className="num">{plural(count, 'item marcado', 'itens marcados')}</strong> somando <strong className="num">{formatBytes(bytes)}</strong></span>
      <span className="selection-actions">
        <button type="button" className="button" onClick={app.clearMarks}>Limpar seleção</button>
        <button type="button" className="button is-primary" onClick={() => app.setReviewOpen(true)}>Revisar e excluir</button>
      </span>
    </div>
  );
}

function Toasts() {
  const app = useApp();
  return (
    <div className="toasts" aria-live="polite">
      {app.toasts.map((toast) => (
        <div key={toast.id} className={`toast${toast.tone === 'error' ? ' is-error' : ''}`}>
          <span>{toast.text}</span>
          <IconButton icon="close" label="Dispensar" onClick={() => app.dismissToast(toast.id)} />
        </div>
      ))}
    </div>
  );
}

function CurrentView() {
  const app = useApp();
  switch (app.view) {
    case 'overview': return app.summary ? <OverviewView /> : <HomeView />;
    case 'map': return app.summary ? <MapView /> : <HomeView />;
    case 'explore': return app.summary ? <ExploreView /> : <HomeView />;
    case 'cleanup': return app.summary ? <CleanupView /> : <HomeView />;
    case 'duplicates': return app.summary ? <DuplicatesView /> : <HomeView />;
    case 'models': return app.summary ? <ModelsView /> : <HomeView />;
    case 'growth': return <GrowthView />;
    case 'reports': return <ReportsView />;
    case 'settings': return <SettingsView />;
    default: return <HomeView />;
  }
}

export function App() {
  const app = useApp();
  const showInspector = app.inspected !== null && app.summary !== null && !['home', 'settings', 'reports', 'growth'].includes(app.view);
  return (
    <div className={`shell${showInspector ? ' has-inspector' : ''}`}>
      <Sidebar />
      <div className="workspace">
        <TopBar />
        <main className="content" key={app.view}><CurrentView /></main>
        <Selection />
      </div>
      {showInspector && <Inspector id={app.inspected as number} />}
      <ReviewDialog />
      <Toasts />
    </div>
  );
}
