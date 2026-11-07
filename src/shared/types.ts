export const FLAG = {
  dir: 1,
  link: 2,
  hidden: 4,
  system: 8,
  readOnly: 16,
  cloud: 32,
  hardlinkDup: 64,
  denied: 128,
  deleted: 256,
  excluded: 512,
  partial: 1024,
} as const;

export interface Drive {
  path: string;
  type: string;
  ready: boolean;
  label?: string;
  format?: string;
  total?: number;
  free?: number;
  hdd?: boolean;
}

export interface ScanProgress {
  files: number;
  dirs: number;
  bytes: number;
  alloc: number;
  errors: number;
  elapsed: number;
  expected: number;
  phase: string;
  current: string;
}

export interface ScanSummary {
  path: string;
  alloc: number;
  size: number;
  files: number;
  nodes: number;
  elapsed: number;
  cancelled: boolean;
  errors: number;
  hardlinks: number;
  links: number;
  threads: number;
  volumeTotal: number;
  volumeFree: number;
  removed: number;
  memory: number;
  isDrive: boolean;
  snapshot: string | null;
}

export interface Item {
  id: number;
  name: string;
  size: number;
  alloc: number;
  rawSize: number;
  mtime: number;
  flags: number;
  cat: number;
  ext: string;
  files: number;
  children: number;
  dir?: string;
  parent?: number;
}

export interface NodeInfo extends Omit<Item, 'dir' | 'parent'> {
  path: string;
  lossy: boolean;
  gone?: boolean;
  incomplete?: boolean;
}

export interface QueryFilter {
  kind?: 'file' | 'dir' | 'all';
  text?: string;
  exts?: string[];
  cats?: number[];
  minSize?: number;
  maxSize?: number;
  after?: number;
  before?: number;
  within?: number;
  logical?: boolean;
  sort?: 'size' | 'name' | 'mtime' | 'ext';
  asc?: boolean;
}

export interface QueryPage {
  total: number;
  totalBytes: number;
  capped: boolean;
  window: number;
  items: Item[];
}

export type RawTreemapNode = [id: number, parent: number, name: string, size: number, cat: number, kind: number, hidden: number];

export interface TreemapPayload {
  id: number;
  nodes: RawTreemapNode[];
}

export interface StatsPayload {
  categories: { cat: number; bytes: number; count: number }[];
  exts: { ext: string; bytes: number; count: number; cat: number }[];
  ages: { bucket: number; bytes: number; count: number }[];
  hidden: number;
  cloud: number;
  cloudCount: number;
}

export type Risk = 'low' | 'review' | 'caution';

export interface Recommendation {
  id: string;
  group: string;
  title: string;
  why: string;
  risk: Risk;
  action: 'trash' | 'info';
  note?: string;
  bytes: number;
  count: number;
  items: Item[];
}

export interface CleanupPayload {
  recoverable: number;
  items: Recommendation[];
}

export interface DupProgress {
  stage: 'group' | 'partial' | 'hash' | 'verify';
  bytesDone: number;
  bytesTotal: number;
  candidates: number;
  groups: number;
}

export interface DupGroup {
  hash: string;
  size: number;
  wasted: number;
  files: Item[];
}

export interface DupSummary {
  groups: number;
  wasted: number;
  skipped: number;
  scanned: number;
  elapsed: number;
  cancelled: boolean;
}

export interface DupPage extends DupSummary {
  skippedPaths: string[];
  items: DupGroup[];
}

export interface ModelItem {
  id: number;
  path: string;
  name: string;
  format: string;
  size: number;
  parts: number;
  confidence: 'verified' | 'likely';
  arch?: string;
  quant?: string;
  tensors?: number;
  runner?: string;
  mtime: number;
  partIds: number[];
}

export interface ModelsPayload {
  bytes: number;
  items: ModelItem[];
}

export interface Snapshot {
  id: string;
  root: string;
  time: number;
  alloc: number;
  size: number;
  files: number;
  dirs: number;
  volumeTotal: number;
  volumeFree: number;
}

export interface GrowthItem {
  path: string;
  before: number;
  after: number;
  delta: number;
  filesDelta: number;
  status: 'new' | 'removed' | 'changed';
}

export interface GrowthPayload {
  base: Snapshot;
  target: Snapshot;
  grown: number;
  shrunk: number;
  items: GrowthItem[];
}

export interface ScanErrorsPage {
  total: number;
  items: { path: string; code: number }[];
}

export interface DeleteRequest {
  ids: number[];
  keep?: Record<number, number>;
  permanent?: boolean;
}

export interface PlanEntry {
  id: number;
  path: string;
  name: string;
  bytes: number;
  isDir: boolean;
  files: number;
  status: 'ok' | 'refused';
  reason?: string;
}

export interface DeletePlan {
  token: string;
  permanent: boolean;
  entries: PlanEntry[];
  bytes: number;
  allowed: number;
  refused: number;
}

export interface DeleteProgress {
  done: number;
  total: number;
  current: string;
}

export interface DeleteOutcome {
  moved: number;
  bytes: number;
  failed: { id: number; path: string; reason: string }[];
  cancelled: boolean;
  permanent: boolean;
}

export interface HistoryEntry {
  time: number;
  action: 'trash' | 'permanent';
  path: string;
  bytes: number;
  ok: boolean;
  reason?: string;
}

export interface Settings {
  metric: 'alloc' | 'size';
  excludes: string[];
  downloadsDays: number;
  installerDays: number;
  dupMinMB: number;
  dupIncludeSystem: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  metric: 'alloc',
  excludes: [],
  downloadsDays: 180,
  installerDays: 30,
  dupMinMB: 1,
  dupIncludeSystem: false,
};

export interface AppInfo {
  version: string;
  isAdmin: boolean;
  isPackaged: boolean;
  engineReady: boolean;
  testMode: boolean;
}

export type ReportFormat = 'html' | 'csv' | 'json';

export interface ReportResult {
  path: string;
}

export interface PreviewInfo {
  kind: 'image' | 'video' | 'none';
  url?: string;
  thumb?: string;
  reason?: string;
}

export type EngineEvent =
  | { event: 'scan.progress'; data: ScanProgress }
  | { event: 'scan.done'; data: ScanSummary }
  | { event: 'scan.failed'; data: { message: string } }
  | { event: 'dups.progress'; data: DupProgress }
  | { event: 'dups.done'; data: DupSummary }
  | { event: 'dups.failed'; data: { message: string } }
  | { event: 'engine.down'; data: { message: string } }
  | { event: 'engine.up'; data: null };

export interface DiskHunterApi {
  info(): Promise<AppInfo>;
  call<T>(cmd: string, args?: unknown, slot?: string): Promise<T>;
  onEvent(listener: (event: EngineEvent) => void): () => void;
  pickFolder(): Promise<string | null>;
  getSettings(): Promise<Settings>;
  setSettings(patch: Partial<Settings>): Promise<Settings>;
  reveal(id: number): Promise<void>;
  revealPath(path: string): Promise<boolean>;
  open(id: number): Promise<{ ok: boolean; reason?: string }>;
  copyPath(id: number): Promise<void>;
  preview(id: number): Promise<PreviewInfo>;
  planDelete(request: DeleteRequest): Promise<DeletePlan>;
  runDelete(token: string): Promise<DeleteOutcome>;
  cancelDelete(): Promise<void>;
  onDeleteProgress(listener: (progress: DeleteProgress) => void): () => void;
  history(): Promise<HistoryEntry[]>;
  openRecycleBin(): Promise<void>;
  exportReport(format: ReportFormat): Promise<ReportResult | null>;
  relaunchAsAdmin(): Promise<{ ok: boolean; reason?: string }>;
}
