import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { CleanupPayload, DiskHunterApi, DupProgress, DupSummary, EngineEvent, Item, ModelsPayload, QueryFilter, ScanProgress, ScanSummary, Settings } from '../shared/types';
import { DEFAULT_SETTINGS } from '../shared/types';

declare global {
  interface Window {
    diskhunter: DiskHunterApi;
  }
}

export const api = window.diskhunter;

export type View = 'home' | 'overview' | 'map' | 'explore' | 'duplicates' | 'cleanup' | 'models' | 'growth' | 'reports' | 'settings';

export interface MarkedItem {
  id: number;
  name: string;
  bytes: number;
  keep?: number;
}

export interface Toast {
  id: number;
  text: string;
  tone: 'info' | 'error';
}

interface AppState {
  view: View;
  go: (view: View) => void;
  summary: ScanSummary | null;
  progress: ScanProgress | null;
  scanning: boolean;
  scanError: string | null;
  startScan: (path: string) => Promise<void>;
  cancelScan: () => void;
  settings: Settings;
  updateSettings: (patch: Partial<Settings>) => Promise<void>;
  logical: boolean;
  inspected: number | null;
  inspect: (id: number | null) => void;
  marked: Map<number, MarkedItem>;
  mark: (items: MarkedItem[]) => void;
  unmark: (ids: number[]) => void;
  clearMarks: () => void;
  version: number;
  bump: () => Promise<void>;
  toasts: Toast[];
  toast: (text: string, tone?: Toast['tone']) => void;
  dismissToast: (id: number) => void;
  mapRoot: number;
  openMap: (id: number) => void;
  setMapRoot: (id: number) => void;
  explore: QueryFilter;
  setExplore: (filter: QueryFilter) => void;
  dupProgress: DupProgress | null;
  dupSummary: DupSummary | null;
  dupRunning: boolean;
  dupError: string | null;
  cleanup: CleanupPayload | null;
  models: ModelsPayload | null;
  reviewOpen: boolean;
  setReviewOpen: (open: boolean) => void;
}

const Context = createContext<AppState | null>(null);

export function useApp(): AppState {
  const value = useContext(Context);
  if (!value) throw new Error('AppProvider ausente');
  return value;
}

export function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, '');
}

export function isCancelled(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /cancel/i.test(message) || /A task was canceled|operation was canceled/i.test(message);
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [view, setView] = useState<View>('home');
  const [summary, setSummary] = useState<ScanSummary | null>(null);
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [inspected, setInspected] = useState<number | null>(null);
  const [marked, setMarked] = useState<Map<number, MarkedItem>>(new Map());
  const [version, setVersion] = useState(0);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [mapRoot, setMapRootState] = useState(0);
  const [explore, setExplore] = useState<QueryFilter>({ kind: 'file', sort: 'size' });
  const [dupProgress, setDupProgress] = useState<DupProgress | null>(null);
  const [dupSummary, setDupSummary] = useState<DupSummary | null>(null);
  const [dupRunning, setDupRunning] = useState(false);
  const [dupError, setDupError] = useState<string | null>(null);
  const [cleanup, setCleanup] = useState<CleanupPayload | null>(null);
  const [models, setModels] = useState<ModelsPayload | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const toastId = useRef(0);

  const logical = settings.metric === 'size';

  const toast = useCallback((text: string, tone: Toast['tone'] = 'info') => {
    const id = ++toastId.current;
    setToasts((list) => [...list.slice(-3), { id, text, tone }]);
    setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), tone === 'error' ? 9000 : 5000);
  }, []);

  const dismissToast = useCallback((id: number) => setToasts((list) => list.filter((t) => t.id !== id)), []);

  useEffect(() => {
    void api.getSettings().then(setSettings);
    void api.call<ScanSummary | null>('scan.summary').then((value) => {
      if (value) {
        setSummary(value);
        setView('overview');
      }
    }).catch(() => undefined);
  }, []);

  const loadDerived = useCallback((current: Settings) => {
    void api.call<CleanupPayload>('cleanup', { downloadsDays: current.downloadsDays, installerDays: current.installerDays }, 'cleanup').then(setCleanup).catch(() => undefined);
    void api.call<ModelsPayload>('models', {}, 'models').then(setModels).catch(() => undefined);
  }, []);

  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  useEffect(() => {
    return api.onEvent((event: EngineEvent) => {
      switch (event.event) {
        case 'scan.progress':
          setScanning(true);
          setProgress(event.data);
          break;
        case 'scan.done':
          setScanning(false);
          setProgress(null);
          setSummary(event.data);
          setMapRootState(0);
          setInspected(null);
          setMarked(new Map());
          setDupSummary(null);
          setDupProgress(null);
          setDupRunning(false);
          setCleanup(null);
          setModels(null);
          setExplore({ kind: 'file', sort: 'size' });
          setVersion((v) => v + 1);
          setView((current) => (current === 'home' ? 'overview' : current));
          loadDerived(settingsRef.current);
          break;
        case 'scan.failed':
          setScanning(false);
          setProgress(null);
          setScanError(event.data.message);
          break;
        case 'dups.progress':
          setDupRunning(true);
          setDupProgress(event.data);
          break;
        case 'dups.done':
          setDupRunning(false);
          setDupProgress(null);
          setDupSummary(event.data);
          break;
        case 'dups.failed':
          setDupRunning(false);
          setDupProgress(null);
          setDupError(event.data.message);
          break;
        case 'engine.down':
          setScanning(false);
          setProgress(null);
          setDupRunning(false);
          setSummary(null);
          setCleanup(null);
          setModels(null);
          setMarked(new Map());
          setInspected(null);
          setView('home');
          setScanError('O motor de análise parou e foi reiniciado. Faça a análise de novo.');
          break;
        case 'engine.up':
          setVersion((v) => v + 1);
          break;
      }
    });
  }, [loadDerived]);

  useEffect(() => {
    if (scanning) setView('home');
  }, [scanning]);

  const startScan = useCallback(async (path: string) => {
    setScanError(null);
    setScanning(true);
    setView('home');
    setProgress({ files: 0, dirs: 0, bytes: 0, alloc: 0, errors: 0, elapsed: 0, expected: 0, phase: 'scan', current: path });
    try {
      await api.call('scan.start', { path, excludes: settingsRef.current.excludes });
    } catch (error) {
      setScanning(false);
      setProgress(null);
      setScanError(errorText(error));
    }
  }, []);

  const cancelScan = useCallback(() => {
    void api.call('scan.cancel').catch(() => undefined);
  }, []);

  const updateSettings = useCallback(async (patch: Partial<Settings>) => {
    const next = await api.setSettings(patch);
    setSettings(next);
    setVersion((v) => v + 1);
  }, []);

  const mark = useCallback((items: MarkedItem[]) => {
    setMarked((current) => {
      const next = new Map(current);
      for (const item of items) next.set(item.id, item);
      return next;
    });
  }, []);

  const unmark = useCallback((ids: number[]) => {
    setMarked((current) => {
      const next = new Map(current);
      for (const id of ids) next.delete(id);
      return next;
    });
  }, []);

  const clearMarks = useCallback(() => setMarked(new Map()), []);

  const bump = useCallback(async () => {
    const value = await api.call<ScanSummary | null>('scan.summary');
    setSummary(value);
    setVersion((v) => v + 1);
    loadDerived(settingsRef.current);
  }, [loadDerived]);

  const go = useCallback((next: View) => setView(next), []);
  const openMap = useCallback((id: number) => {
    setMapRootState(id);
    setView('map');
  }, []);

  const state = useMemo<AppState>(() => ({
    view, go, summary, progress, scanning, scanError, startScan, cancelScan, settings, updateSettings, logical,
    inspected, inspect: setInspected, marked, mark, unmark, clearMarks, version, bump, toasts, toast, dismissToast,
    mapRoot, openMap, setMapRoot: setMapRootState, explore, setExplore, dupProgress, dupSummary, dupRunning, dupError,
    cleanup, models, reviewOpen, setReviewOpen,
  }), [view, go, summary, progress, scanning, scanError, startScan, cancelScan, settings, updateSettings, logical, inspected, marked, mark, unmark, clearMarks, version, bump, toasts, toast, dismissToast, mapRoot, openMap, explore, dupProgress, dupSummary, dupRunning, dupError, cleanup, models, reviewOpen]);

  return <Context.Provider value={state}>{children}</Context.Provider>;
}

export function itemPath(item: Item): string {
  return item.dir ? `${item.dir.replace(/\\$/, '')}\\${item.name}` : item.name;
}

export const CATEGORY_COLORS = ['#63646b', '#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];
