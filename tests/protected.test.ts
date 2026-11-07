import { describe, expect, it } from 'vitest';
import { canOpenDirectly, checkDeletable, normalizePath, type GuardEnv } from '../src/shared/protected';

const env: GuardEnv = {
  systemDrive: 'C:',
  windows: 'C:\\Windows',
  programFiles: ['C:\\Program Files', 'C:\\Program Files (x86)'],
  programData: 'C:\\ProgramData',
  users: 'C:\\Users',
  userProfile: 'C:\\Users\\ana',
  appPaths: ['C:\\Users\\ana\\AppData\\Roaming\\DiskHunter', 'C:\\Users\\ana\\AppData\\Local\\Programs\\DiskHunter'],
};
const allowed = (path: string) => checkDeletable(path, env).ok;

describe('normalizePath', () => {
  it('resolve prefixos, barras, pontos e espaços finais', () => {
    expect(normalizePath('\\\\?\\C:\\Windows\\')).toBe('c:\\windows');
    expect(normalizePath('C:/Users/Ana/../Ana/./Docs. ')).toBe('c:\\users\\ana\\docs');
    expect(normalizePath('\\\\localhost\\c$\\Windows')).toBe('c:\\windows');
    expect(normalizePath('\\\\?\\UNC\\Srv\\Share\\A')).toBe('\\\\srv\\share\\a');
  });
  it('rejeita o que não é caminho absoluto seguro', () => {
    for (const bad of ['', 'relativo\\a', 'C:semBarra', 'C:\\a\0b', 'C:\\a\\arq.txt:stream']) expect(normalizePath(bad)).toBeNull();
  });
});

describe('checkDeletable', () => {
  it.each([
    'C:\\', 'D:\\', 'C:\\Windows', 'c:/WINDOWS/System32', 'C:\\Windows\\System32\\drivers\\etc\\hosts', 'C:\\Windows.\\System32',
    'C:\\Program Files', 'C:\\Program Files\\App', 'C:\\Program Files (x86)\\App\\a.dll', 'C:\\ProgramData', 'C:\\ProgramData\\App',
    'C:\\Users', 'C:\\Users\\ana', 'C:\\Users\\outra', 'C:\\Users\\ana\\Documents', 'C:\\Users\\ana\\Downloads', 'C:\\Users\\ana\\AppData', 'C:\\Users\\ana\\AppData\\Local',
    'C:\\Users\\ana\\NTUSER.DAT', 'C:\\Users\\Default\\x', 'C:\\Users\\ana\\AppData\\Local\\Microsoft\\Windows', 'C:\\pagefile.sys', 'D:\\System Volume Information', 'D:\\$Recycle.Bin\\S-1\\x',
    'C:\\Users\\ana\\AppData\\Roaming\\Microsoft\\Protect\\S-1', 'C:\\Users\\ana\\AppData\\Roaming\\Microsoft\\Credentials', 'C:\\Users\\ana\\AppData\\Local\\Microsoft\\Credentials\\x', 'C:\\Users\\ana\\AppData\\Roaming\\Microsoft\\Crypto', 'C:\\Users\\ana\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu',
    'C:\\Windows.old', 'D:\\Windows.old\\x', 'D:\\Windows', 'D:\\Windows\\System32', 'D:\\Program Files\\App', 'D:\\ProgramData\\x', 'D:\\Users', 'C:\\Program Files (Arm)\\App'.replace('C:', 'E:'), '\\\\MEUPC\\c$\\Windows\\win.ini', '\\\\127.0.0.2\\C$\\x\\y', '\\\\srv\\admin$\\a\\b', 'C:\\pasta\\APPDAT~1\\x',
    'C:\\Users\\ana\\AppData\\Roaming\\DiskHunter\\settings.json', '\\\\srv\\share', '\\\\srv\\share\\pasta', 'C:\\pasta\\nul.txt', 'C:\\PROGRA~1\\App', '\\\\?\\C:\\Windows\\win.ini', '\\\\127.0.0.1\\C$\\Windows\\win.ini',
  ])('recusa %s', (path) => {
    expect(allowed(path)).toBe(false);
  });
  it.each([
    'D:\\Jogos\\velho', 'D:\\arquivo.iso', 'C:\\Windows\\Temp\\x.log', 'C:\\Windows\\SoftwareDistribution\\Download\\pacote', 'C:\\Users\\ana\\Downloads\\setup.exe',
    'C:\\Users\\ana\\AppData\\Local\\Microsoft\\Windows\\INetCache\\IE', 'C:\\Users\\ana\\AppData\\Local\\Microsoft\\Edge\\User Data\\Default\\Cache', 'D:\\Users\\backup\\arq.bin', 'C:\\Users\\ana\\AppData\\Local\\Temp\\abc', 'C:\\Users\\ana\\Documents\\nota.txt', 'C:\\ProgramData\\Microsoft\\Windows\\WER\\ReportArchive\\r1', '\\\\srv\\share\\pasta\\arq.bin',
  ])('permite %s', (path) => {
    expect(allowed(path)).toBe(true);
  });
  it('protege C:\\Users mesmo com o perfil em outro disco', () => {
    const moved = { ...env, users: 'D:\\Profiles', userProfile: 'D:\\Profiles\\ana' };
    expect(checkDeletable('C:\\Users', moved).ok).toBe(false);
    expect(checkDeletable('C:\\Users\\outra', moved).ok).toBe(false);
    expect(checkDeletable('D:\\Profiles\\ana\\Documents', moved).ok).toBe(false);
  });
  it('não confunde nomes parecidos com pastas protegidas', () => {
    expect(allowed('C:\\WindowsOld2\\a')).toBe(true);
    expect(allowed('C:\\Program Files Backup\\a')).toBe(true);
  });
});

describe('canOpenDirectly', () => {
  it('nunca executa programas e scripts', () => {
    for (const ext of ['exe', 'EXE', 'bat', 'ps1', 'lnk', 'msi', 'js', 'hta', 'chm', 'msc', 'appref-ms', 'settingcontent-ms', 'py', 'desconhecida', '']) expect(canOpenDirectly(ext)).toBe(false);
    for (const ext of ['pdf', 'mp4', 'txt', 'png']) expect(canOpenDirectly(ext)).toBe(true);
  });
});
