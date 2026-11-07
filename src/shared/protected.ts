export interface GuardEnv {
  systemDrive: string;
  windows: string;
  programFiles: string[];
  programData: string;
  users: string;
  otherUsers?: string[];
  userProfile: string;
  appPaths: string[];
}

export type GuardResult = { ok: true } | { ok: false; reason: string };

const DRIVE_ROOT_ITEMS = new Set([
  '$recycle.bin',
  'windows.old',
  'system volume information',
  '$winreagent',
  '$windows.~bt',
  '$windows.~ws',
  'recovery',
  'boot',
  'efi',
  'bootmgr',
  'bootnxt',
  'pagefile.sys',
  'hiberfil.sys',
  'swapfile.sys',
  'dumpstack.log',
  'dumpstack.log.tmp',
  'config.sys',
  'autoexec.bat',
  'msocache',
  'documents and settings',
]);

const WINDOWS_ALLOWED = ['temp', 'softwaredistribution\\download', 'minidump'];
const PROGRAMDATA_ALLOWED = ['microsoft\\windows\\wer\\reportarchive', 'microsoft\\windows\\wer\\reportqueue'];
const PROFILE_KEEP = new Set(['appdata', 'desktop', 'documents', 'downloads', 'pictures', 'videos', 'music', 'onedrive', 'favorites', 'contacts', 'links', 'saved games', 'searches', '3d objects']);
const APPDATA_KEEP = new Set(['local', 'locallow', 'roaming']);
const DEVICE_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/;
const SHORT_NAME = /~\d/;
const ANY_VOLUME_PROTECTED = new Set(['windows', 'program files', 'program files (x86)', 'program files (arm)', 'programdata']);
const MICROSOFT_SECRETS = /^(local|roaming|locallow)\\microsoft\\(protect|credentials|crypto|systemcertificates|vault)(\\|$)/;
const MICROSOFT_WINDOWS = /^(local|roaming|locallow)\\microsoft\\windows(\\|$)/;
const MICROSOFT_WINDOWS_CACHES = /^local\\microsoft\\windows\\(inetcache|explorer|wer)(\\|$)/;

export function normalizePath(input: string): string | null {
  if (typeof input !== 'string' || input.length === 0 || input.includes('\0')) return null;
  let value = input.replace(/\//g, '\\');
  const lower = value.toLowerCase();
  if (lower.startsWith('\\\\?\\unc\\')) value = '\\\\' + value.slice(8);
  else if (lower.startsWith('\\\\?\\') || lower.startsWith('\\\\.\\')) value = value.slice(4);

  let prefix = '';
  let rest = value;
  const unc = /^\\\\([^\\]+)\\([^\\]+)(.*)$/.exec(value);
  if (unc) {
    const host = unc[1].toLowerCase();
    const admin = /^([a-z])\$$/i.exec(unc[2]);
    if (admin && (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '.')) {
      prefix = `${admin[1].toLowerCase()}:`;
      rest = unc[3];
    } else {
      prefix = `\\\\${host}\\${unc[2].toLowerCase()}`;
      rest = unc[3];
    }
  } else {
    const drive = /^([a-z]):(.*)$/i.exec(value);
    if (!drive) return null;
    if (!drive[2].startsWith('\\') && drive[2].length > 0) return null;
    prefix = `${drive[1].toLowerCase()}:`;
    rest = drive[2];
  }

  const parts: string[] = [];
  for (const raw of rest.split('\\')) {
    if (raw === '' || raw === '.') continue;
    if (raw === '..') {
      parts.pop();
      continue;
    }
    const clean = raw.replace(/[. ]+$/, '').toLowerCase();
    if (clean === '') return null;
    if (clean.includes(':')) return null;
    parts.push(clean);
  }
  return parts.length ? `${prefix}\\${parts.join('\\')}` : `${prefix}\\`;
}

function inside(path: string, parent: string): boolean {
  return path.startsWith(parent.endsWith('\\') ? parent : `${parent}\\`);
}

function relation(path: string, target: string | null): 'same' | 'inside' | 'contains' | 'none' {
  if (!target) return 'none';
  if (path === target) return 'same';
  if (inside(path, target)) return 'inside';
  if (inside(target, path)) return 'contains';
  return 'none';
}

const refuse = (reason: string): GuardResult => ({ ok: false, reason });

export function checkDeletable(input: string, env: GuardEnv): GuardResult {
  const path = normalizePath(input);
  if (!path) return refuse('O caminho não pôde ser interpretado com segurança.');
  const parts = path.split('\\').filter(Boolean);
  if (parts.length <= 1) return refuse('A raiz de um disco nunca pode ser excluída.');

  const isLocalDrive = /^[a-z]:$/.test(parts[0]);
  if (!isLocalDrive && parts.length <= 3) return refuse('A raiz de um compartilhamento de rede não pode ser excluída.');
  if (!isLocalDrive && parts[1].endsWith('$')) return refuse('Compartilhamentos administrativos não são aceitos.');
  if (parts.some((part) => DEVICE_NAME.test(part))) return refuse('O nome usa um dispositivo reservado do Windows.');
  if (parts.slice(1).some((part) => SHORT_NAME.test(part) && !part.includes('.'))) return refuse('Nomes curtos do Windows não são aceitos. Use o caminho completo.');
  if (isLocalDrive && DRIVE_ROOT_ITEMS.has(parts[1])) return refuse('Item reservado do Windows.');
  if (parts.includes('$recycle.bin')) return refuse('Itens da Lixeira são geridos pelo próprio Windows.');

  const systemDrive = normalizePath(`${env.systemDrive}\\`)?.slice(0, 2);
  if (isLocalDrive && parts[0] !== systemDrive) {
    if (ANY_VOLUME_PROTECTED.has(parts[1])) return refuse('Pasta de sistema ou de programas em outro disco. Remova pelo próprio sistema ou pelo desinstalador.');
    if (parts[1] === 'users' && parts.length === 2) return refuse('Contém as pastas de todos os usuários.');
  }

  const windows = normalizePath(env.windows);
  const windowsRelation = relation(path, windows);
  if (windowsRelation === 'same' || windowsRelation === 'contains') return refuse('Contém a pasta do Windows.');
  if (windowsRelation === 'inside' && windows) {
    const relative = path.slice(windows.length + 1);
    const allowed = WINDOWS_ALLOWED.some((base) => inside(relative, base));
    if (!allowed) return refuse('Pasta protegida do Windows.');
  }

  for (const entry of env.programFiles) {
    const programFiles = normalizePath(entry);
    const related = relation(path, programFiles);
    if (related === 'same' || related === 'inside') return refuse('Programas instalados devem ser removidos pelo desinstalador.');
    if (related === 'contains') return refuse('Contém a pasta de programas instalados.');
  }

  const programData = normalizePath(env.programData);
  const dataRelation = relation(path, programData);
  if (dataRelation === 'same' || dataRelation === 'contains') return refuse('Contém dados de programas do sistema.');
  if (dataRelation === 'inside' && programData) {
    const relative = path.slice(programData.length + 1);
    if (!PROGRAMDATA_ALLOWED.some((base) => inside(relative, base))) return refuse('Dados de programas do sistema são protegidos.');
  }

  const userRoots = new Set([env.users, `${env.systemDrive}\\Users`, ...(env.otherUsers ?? [])].map((entry) => normalizePath(entry)));
  for (const users of userRoots) {
  const usersRelation = relation(path, users);
  if (usersRelation === 'same' || usersRelation === 'contains') return refuse('Contém as pastas de todos os usuários.');
  if (usersRelation === 'inside' && users) {
    const relative = path.slice(users.length + 1).split('\\');
    if (relative.length === 1) return refuse('Pasta de um perfil de usuário.');
    if (relative[0] === 'default' || relative[0] === 'default user' || relative[0] === 'all users') return refuse('Perfil padrão do Windows.');
    if (relative.length === 2) {
      if (PROFILE_KEEP.has(relative[1])) return refuse('Pasta padrão do perfil. O conteúdo dela pode ser limpo, a pasta não.');
      if (relative[1].startsWith('ntuser')) return refuse('Registro do perfil de usuário.');
    }
    if (relative[1] === 'appdata') {
      if (relative.length === 3 && APPDATA_KEEP.has(relative[2])) return refuse('Pasta de dados essencial do perfil.');
      const area = relative.slice(2).join('\\');
      if (/^(local|roaming|locallow)\\microsoft(\\windows)?$/.test(area)) return refuse('Dados do Windows no perfil.');
      if (/^local\\packages$/.test(area) || /^local\\microsoft\\windowsapps/.test(area)) return refuse('Aplicativos da Microsoft Store.');
      if (MICROSOFT_SECRETS.test(area)) return refuse('Chaves e credenciais do Windows.');
      if (MICROSOFT_WINDOWS.test(area) && !MICROSOFT_WINDOWS_CACHES.test(area)) return refuse('Dados do Windows no perfil.');
    }
  }
  }

  const profile = normalizePath(env.userProfile);
  const profileRelation = relation(path, profile);
  if (profileRelation === 'same' || profileRelation === 'contains') return refuse('Contém a sua pasta de usuário.');

  for (const entry of env.appPaths) {
    const appPath = normalizePath(entry);
    const related = relation(path, appPath);
    if (related !== 'none') return refuse('Arquivos do próprio DiskHunter.');
  }

  return { ok: true };
}

const SAFE_TO_OPEN = new Set(['txt', 'md', 'log', 'csv', 'json', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'rtf', 'epub', 'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'avif', 'heic', 'heif', 'tif', 'tiff', 'svg', 'mp4', 'mkv', 'webm', 'mov', 'avi', 'wmv', 'm4v', 'mpg', 'mpeg', 'ts', 'm2ts', 'flv', 'mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac', 'wma', 'opus', 'zip', '7z', 'rar', 'tar', 'gz', 'iso']);

export function canOpenDirectly(ext: string): boolean {
  return SAFE_TO_OPEN.has(ext.toLowerCase());
}

export const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'avif', 'ico']);
export const VIDEO_EXTS = new Set(['mp4', 'webm', 'm4v', 'mov', 'ogv']);
export const THUMB_EXTS = new Set(['heic', 'heif', 'tif', 'tiff', 'mkv', 'avi', 'wmv', 'mpg', 'mpeg', 'ts', 'm2ts', 'flv', 'cr2', 'cr3', 'nef', 'arw', 'dng', 'psd', 'pdf']);
