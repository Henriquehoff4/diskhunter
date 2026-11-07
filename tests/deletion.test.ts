import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DeletionService, type DeletionDeps } from '../src/main/deletion';
import { FLAG, type HistoryEntry, type NodeInfo } from '../src/shared/types';

const env = { systemDrive: 'C:', windows: 'C:\\Windows', programFiles: ['C:\\Program Files'], programData: 'C:\\ProgramData', users: 'C:\\Users', userProfile: 'C:\\Users\\ana', appPaths: ['C:\\app'] };
const MTIME = 1700000000;

function node(id: number, path: string, extra: Partial<NodeInfo> = {}): NodeInfo {
  return { id, path, name: path.split('\\').pop() as string, size: 100, alloc: 4096, rawSize: 100, mtime: MTIME, flags: 0, files: 1, ext: 'bin', cat: 0, ...extra } as NodeInfo;
}

let nodes: Map<number, NodeInfo>;
let trashed: string[];
let removed: string[];
let history: HistoryEntry[];
let deps: DeletionDeps;
let service: DeletionService;

beforeEach(() => {
  nodes = new Map();
  trashed = [];
  removed = [];
  history = [];
  deps = {
    describe: async (ids) => ids.map((id) => nodes.get(id) ?? ({ id, gone: true } as NodeInfo)),
    verifyDuplicate: vi.fn(async () => true),
    trash: async (path) => { trashed.push(path); },
    remove: async (path) => { removed.push(path); },
    forget: vi.fn(async () => undefined),
    log: (entry) => history.push(entry),
    guardEnv: () => env,
    realPath: async (path) => path,
    countFiles: async (path) => [...nodes.values()].find((n) => n.path === path)?.files ?? 0,
    stat: async (path) => {
      const info = [...nodes.values()].find((n) => n.path === path) as NodeInfo;
      return { size: info.rawSize, mtimeMs: info.mtime * 1000, isDirectory: (info.flags & FLAG.dir) !== 0, isLink: false };
    },
    now: () => 1,
  };
  service = new DeletionService(deps);
});

const run = (token: string, confirm = true) => service.run(token, async () => confirm, () => undefined);

describe('DeletionService', () => {
  it('move para a Lixeira só o que foi planejado e registra', async () => {
    nodes.set(1, node(1, 'D:\\a.bin'));
    const plan = await service.plan({ ids: [1] });
    expect(plan.allowed).toBe(1);
    const outcome = await run(plan.token);
    expect(outcome.moved).toBe(1);
    expect(trashed).toEqual(['D:\\a.bin']);
    expect(removed).toEqual([]);
    expect(deps.forget).toHaveBeenCalledWith([1]);
    expect(history[0]).toMatchObject({ action: 'trash', ok: true });
  });

  it('o token é de uso único e tokens inventados falham', async () => {
    nodes.set(1, node(1, 'D:\\a.bin'));
    const plan = await service.plan({ ids: [1] });
    await run(plan.token);
    await expect(run(plan.token)).rejects.toThrow(/expirou/);
    await expect(run('forjado')).rejects.toThrow(/expirou/);
    expect(trashed).toHaveLength(1);
  });

  it('um plano novo invalida o anterior', async () => {
    nodes.set(1, node(1, 'D:\\a.bin'));
    const first = await service.plan({ ids: [1] });
    await service.plan({ ids: [1] });
    await expect(run(first.token)).rejects.toThrow(/expirou/);
  });

  it('recusa protegidos, links, nomes inválidos, sumidos e itens dentro de pasta selecionada', async () => {
    nodes.set(1, node(1, 'C:\\Windows\\win.ini'));
    nodes.set(2, node(2, 'D:\\link', { flags: FLAG.link | FLAG.dir }));
    nodes.set(3, node(3, 'D:\\torto', { lossy: true } as Partial<NodeInfo>));
    nodes.set(4, node(4, 'D:\\pai', { flags: FLAG.dir }));
    nodes.set(5, node(5, 'D:\\pai\\filho.bin'));
    const plan = await service.plan({ ids: [1, 2, 3, 4, 5, 99] });
    expect(plan.entries.filter((e) => e.status === 'ok').map((e) => e.id)).toEqual([4]);
    const outcome = await run(plan.token);
    expect(outcome.moved).toBe(1);
    expect(trashed).toEqual(['D:\\pai']);
  });

  it('ignora ids inválidos e seleção vazia', async () => {
    await expect(service.plan({ ids: [] })).rejects.toThrow();
    await expect(service.plan({ ids: [0, -1, 1.5] })).rejects.toThrow();
  });

  it('não exclui se o arquivo mudou de tamanho, de data ou virou link', async () => {
    nodes.set(1, node(1, 'D:\\a.bin'));
    nodes.set(2, node(2, 'D:\\b.bin'));
    nodes.set(3, node(3, 'D:\\c.bin'));
    const realStat = deps.stat;
    deps.stat = async (path) => {
      const value = await realStat(path);
      if (path.endsWith('a.bin')) return { ...value, size: 999 };
      if (path.endsWith('b.bin')) return { ...value, mtimeMs: value.mtimeMs + 60000 };
      return { ...value, isLink: true };
    };
    const outcome = await run((await service.plan({ ids: [1, 2, 3] })).token);
    expect(outcome.moved).toBe(0);
    expect(outcome.failed).toHaveLength(3);
    expect(trashed).toEqual([]);
    expect(history.every((h) => !h.ok)).toBe(true);
  });

  it('recusa na hora se o caminho real passou a apontar para área protegida', async () => {
    nodes.set(1, node(1, 'D:\\inocente'));
    deps.realPath = async () => 'C:\\Windows\\System32';
    const outcome = await run((await service.plan({ ids: [1] })).token);
    expect(outcome.moved).toBe(0);
    expect(trashed).toEqual([]);
  });

  it('duplicata só sai depois de conferir a cópia mantida', async () => {
    nodes.set(1, node(1, 'D:\\copia.bin'));
    nodes.set(2, node(2, 'D:\\original.bin'));
    (deps.verifyDuplicate as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);
    const refused = await run((await service.plan({ ids: [1], keep: { 1: 2 } })).token);
    expect(deps.verifyDuplicate).toHaveBeenCalledWith(2, 1);
    expect(refused.moved).toBe(0);
    const ok = await run((await service.plan({ ids: [1], keep: { 1: 2 } })).token);
    expect(ok.moved).toBe(1);
  });

  it('nunca remove as duas pontas de uma duplicata', async () => {
    nodes.set(1, node(1, 'D:\\a.bin'));
    nodes.set(2, node(2, 'D:\\b.bin'));
    const plan = await service.plan({ ids: [1, 2], keep: { 1: 2, 2: 1 } });
    expect(plan.allowed).toBe(0);
  });

  it('recusa pasta com conteúdo não lido', async () => {
    nodes.set(1, node(1, 'D:\\meio-lida', { flags: FLAG.dir, incomplete: true }));
    const plan = await service.plan({ ids: [1] });
    expect(plan.allowed).toBe(0);
    expect(plan.entries[0].reason).toMatch(/não leu/);
  });

  it('recusa duplicata quando a cópia mantida está dentro de pasta selecionada', async () => {
    nodes.set(1, node(1, 'D:\\Y\\f.bin'));
    nodes.set(2, node(2, 'D:\\X\\f.bin'));
    nodes.set(3, node(3, 'D:\\X', { flags: FLAG.dir, files: 1 }));
    for (const order of [[1, 3], [3, 1]]) {
      const plan = await service.plan({ ids: order, keep: { 1: 2 } });
      expect(plan.entries.find((e) => e.id === 1)?.status).toBe('refused');
    }
  });

  it('recusa se a cópia mantida virou link ou é o mesmo arquivo', async () => {
    nodes.set(1, node(1, 'D:\\a.bin'));
    nodes.set(2, node(2, 'D:\\b.bin'));
    const realStat = deps.stat;
    deps.stat = async (path) => ({ ...(await realStat(path)), isLink: path.endsWith('b.bin') });
    expect((await run((await service.plan({ ids: [1], keep: { 1: 2 } })).token)).moved).toBe(0);
    deps.stat = async (path) => ({ ...(await realStat(path)), fileKey: 'igual' });
    expect((await run((await service.plan({ ids: [1], keep: { 1: 2 } })).token)).moved).toBe(0);
    expect(trashed).toEqual([]);
  });

  it('confere a integridade depois da comparação demorada', async () => {
    nodes.set(1, node(1, 'D:\\a.bin'));
    nodes.set(2, node(2, 'D:\\b.bin'));
    deps.verifyDuplicate = vi.fn(async () => {
      deps.realPath = async () => 'C:\\Windows\\System32\\x';
      return true;
    });
    expect((await run((await service.plan({ ids: [1], keep: { 1: 2 } })).token)).moved).toBe(0);
    expect(trashed).toEqual([]);
  });

  it('exclusão permanente recusa pasta que mudou', async () => {
    nodes.set(1, node(1, 'D:\\pasta', { flags: FLAG.dir, files: 3 }));
    deps.countFiles = async () => 4;
    expect((await run((await service.plan({ ids: [1], permanent: true })).token)).moved).toBe(0);
    expect(removed).toEqual([]);
  });

  it('exclusão permanente exige confirmação nativa e nunca usa a Lixeira', async () => {
    nodes.set(1, node(1, 'D:\\a.bin'));
    const denied = await run((await service.plan({ ids: [1], permanent: true })).token, false);
    expect(denied).toMatchObject({ moved: 0, cancelled: true });
    expect(removed).toEqual([]);
    const accepted = await run((await service.plan({ ids: [1], permanent: true })).token, true);
    expect(accepted.moved).toBe(1);
    expect(removed).toEqual(['D:\\a.bin']);
    expect(trashed).toEqual([]);
  });

  it('falha da Lixeira não vira exclusão permanente', async () => {
    nodes.set(1, node(1, 'D:\\a.bin'));
    deps.trash = async () => { throw new Error('Failed to create FileOp'); };
    const outcome = await run((await service.plan({ ids: [1] })).token);
    expect(outcome.moved).toBe(0);
    expect(outcome.failed[0].reason).toMatch(/Lixeira/);
    expect(removed).toEqual([]);
  });

  it('cancelar interrompe os próximos itens', async () => {
    for (let id = 1; id <= 40; id += 1) nodes.set(id, node(id, `D:\\f${id}.bin`));
    const plan = await service.plan({ ids: [...nodes.keys()] });
    deps.trash = async (path) => { trashed.push(path); service.cancel(); };
    const outcome = await run(plan.token);
    expect(outcome.cancelled).toBe(true);
    expect(trashed.length).toBeLessThan(40);
  });
});
