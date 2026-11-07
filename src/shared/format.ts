const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

export function formatBytes(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const sign = value < 0 ? '-' : '';
  let amount = Math.abs(value);
  let unit = 0;
  while (amount >= 1024 && unit < UNITS.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  if (unit > 0 && amount >= 999.5 && unit < UNITS.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || amount >= 100 ? 0 : amount >= 10 ? 1 : 2;
  return `${sign}${amount.toLocaleString('pt-BR', { minimumFractionDigits: digits, maximumFractionDigits: digits })} ${UNITS[unit]}`;
}

export function formatDelta(value: number): string {
  return `${value >= 0 ? '+' : ''}${formatBytes(value)}`;
}

export function formatCount(value: number): string {
  return Math.round(value).toLocaleString('pt-BR');
}

export function plural(value: number, one: string, many: string): string {
  return `${formatCount(value)} ${value === 1 ? one : many}`;
}

export function formatDate(unix: number): string {
  if (!unix) return '—';
  return new Date(unix * 1000).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' }).replace(/\. de /g, ' ').replace(/ de /g, ' ').replace('.', '');
}

export function formatDateTime(unix: number): string {
  if (!unix) return '—';
  return new Date(unix * 1000).toLocaleString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }).replace(/\. de /g, ' ').replace(/ de /g, ' ').replace('.', '');
}

export function formatRelative(unix: number, now = Date.now() / 1000): string {
  if (!unix) return '—';
  const seconds = Math.max(0, now - unix);
  if (seconds < 90) return 'agora mesmo';
  const minutes = seconds / 60;
  if (minutes < 60) return `há ${Math.round(minutes)} min`;
  const hours = minutes / 60;
  if (hours < 24) return `há ${Math.round(hours)} h`;
  const days = hours / 24;
  if (days < 45) return `há ${Math.round(days)} ${Math.round(days) === 1 ? 'dia' : 'dias'}`;
  const months = days / 30.44;
  if (months < 18) return `há ${Math.round(months)} ${Math.round(months) === 1 ? 'mês' : 'meses'}`;
  return `há ${(days / 365.25).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} anos`;
}

export function formatDuration(seconds: number): string {
  if (seconds < 1) return `${Math.round(seconds * 1000)} ms`;
  if (seconds < 60) return `${seconds.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} min ${Math.round(seconds - minutes * 60)} s`;
}

export function parseSize(text: string): number | undefined {
  const match = /^\s*([\d.,]+)\s*(b|kb|mb|gb|tb|k|m|g|t)?\s*$/i.exec(text);
  if (!match) return undefined;
  const raw = match[1];
  const normalized = raw.includes(',') ? raw.replace(/\./g, '').replace(',', '.') : /^\d{1,3}(\.\d{3})+$/.test(raw) ? raw.replace(/\./g, '') : raw;
  const value = Number(normalized);
  if (!Number.isFinite(value)) return undefined;
  const unit = (match[2] ?? 'mb').toLowerCase()[0];
  const power = { b: 0, k: 1, m: 2, g: 3, t: 4 }[unit] ?? 2;
  return Math.round(value * 1024 ** power);
}

export const CATEGORY_NAMES = ['Outros', 'Vídeo', 'Imagens', 'Áudio', 'Documentos', 'Compactados', 'Código', 'Programas', 'Modelos de IA'];
export const AGE_NAMES = ['Até 30 dias', '1 a 3 meses', '3 a 12 meses', '1 a 3 anos', 'Mais de 3 anos'];
export const RISK_NAMES = { low: 'Seguro', review: 'Revise antes', caution: 'Cuidado' } as const;

export function winError(code: number): string {
  if (code === 5) return 'Acesso negado';
  if (code === 2 || code === 3) return 'Não encontrado';
  if (code === 32) return 'Em uso por outro programa';
  if (code === 123) return 'Nome inválido';
  if (code === 1920) return 'O arquivo não pode ser acessado pelo sistema';
  if (code === -1) return 'Erro inesperado ao ler';
  return `Erro ${code} do Windows`;
}
