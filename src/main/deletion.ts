import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { checkDeletable, type GuardEnv } from '../shared/protected';
import { FLAG, type DeleteOutcome, type DeletePlan, type DeleteProgress, type DeleteRequest, type HistoryEntry, type NodeInfo, type PlanEntry } from '../shared/types';

export interface DeletionDeps {
  describe(ids: number[]): Promise<NodeInfo[]>;
  verifyDuplicate(keep: number, other: number): Promise<boolean>;
  trash(path: string): Promise<void>;
  remove(path: string): Promise<void>;
  forget(ids: number[]): Promise<void>;
  log(entry: HistoryEntry): void;
  guardEnv(): GuardEnv;
  realPath(path: string): Promise<string>;
  stat(path: string): Promise<{ size: number; mtimeMs: number; isDirectory: boolean; isLink: boolean; fileKey?: string }>;
  countFiles(path: string): Promise<number>;
  now(): number;
}

export const nodeFileDeps = {
  realPath: (path: string) => fs.realpath(path),
  stat: async (path: string) => {
    const info = await fs.lstat(path);
    const key = await fs.lstat(path, { bigint: true });
    return { size: info.size, mtimeMs: info.mtimeMs, isDirectory: info.isDirectory(), isLink: info.isSymbolicLink(), fileKey: `${key.dev}:${key.ino}` };
  },
  countFiles: async (path: string) => {
    let total = 0;
    const pending = [path];
    while (pending.length > 0) {
      const current = pending.pop() as string;
      for (const entry of await fs.readdir(current, { withFileTypes: true })) {
        if (entry.isDirectory()) pending.push(`${current}\\${entry.name}`);
        else if (entry.isFile()) total += 1;
      }
    }
    return total;
  },
  remove: (path: string) => fs.rm(path, { recursive: true, force: false, maxRetries: 0 }),
};

interface StoredPlan {
  plan: DeletePlan;
  infos: Map<number, NodeInfo>;
  keep: Record<number, number>;
}

const MAX_ITEMS = 20000;
const CONCURRENCY = 4;

export class DeletionService {
  private plans = new Map<string, StoredPlan>();
  private cancelled = false;
  private running = false;

  constructor(private deps: DeletionDeps) {}

  async plan(request: DeleteRequest): Promise<DeletePlan> {
    const ids = [...new Set(request.ids)].filter((id) => Number.isInteger(id) && id > 0);
    if (ids.length === 0 || ids.length > MAX_ITEMS) throw new Error('A seleção está vazia ou grande demais.');
    const keep = request.keep ?? {};
    const keeperIds = [...new Set(Object.values(keep))].filter((id) => Number.isInteger(id) && !ids.includes(id));
    const infos = await this.deps.describe([...ids, ...keeperIds]);
    const map = new Map(infos.map((info) => [info.id, info]));
    const selected = new Set(ids);
    const env = this.deps.guardEnv();
    const entries: PlanEntry[] = [];
    let bytes = 0;

    const orderedAncestors = infos.filter((info) => selected.has(info.id) && !info.gone && (info.flags & FLAG.dir) !== 0).map((info) => info.path.toLowerCase());

    for (const id of ids) {
      const info = map.get(id);
      if (!info || info.gone) {
        entries.push({ id, path: '', name: `Item ${id}`, bytes: 0, isDir: false, files: 0, status: 'refused', reason: 'Já não existe na análise.' });
        continue;
      }
      const isDir = (info.flags & FLAG.dir) !== 0;
      const entry: PlanEntry = { id, path: info.path, name: info.name, bytes: info.alloc, isDir, files: isDir ? info.files : 1, status: 'ok' };
      const reason = this.refusal(info, env, keep[id], map, selected, orderedAncestors);
      if (reason) {
        entry.status = 'refused';
        entry.reason = reason;
      } else {
        bytes += info.alloc;
      }
      entries.push(entry);
    }

    const token = randomUUID();
    const plan: DeletePlan = {
      token,
      permanent: Boolean(request.permanent),
      entries,
      bytes,
      allowed: entries.filter((e) => e.status === 'ok').length,
      refused: entries.filter((e) => e.status === 'refused').length,
    };
    this.plans.clear();
    this.plans.set(token, { plan, infos: map, keep });
    return plan;
  }

  private refusal(info: NodeInfo, env: GuardEnv, keeper: number | undefined, nodes: Map<number, NodeInfo>, selected: Set<number>, dirs: string[]): string | null {
    if (info.lossy) return 'O nome tem caracteres inválidos. Exclua pelo Explorador de Arquivos.';
    if ((info.flags & FLAG.link) !== 0) return 'É um link para outra pasta. Remova pelo Explorador de Arquivos.';
    const guard = checkDeletable(info.path, env);
    if (!guard.ok) return guard.reason;
    if (info.incomplete) return 'A análise não leu tudo dentro desta pasta, então o conteúdo real é desconhecido. Exclua pelo Explorador de Arquivos.';
    if (keeper !== undefined) {
      if (selected.has(keeper)) return 'A cópia que deveria ficar também está selecionada.';
      const kept = nodes.get(keeper);
      if (!kept || kept.gone || (kept.flags & (FLAG.dir | FLAG.link)) !== 0) return 'A cópia que deveria ficar não está mais disponível.';
      const keptPath = kept.path.toLowerCase();
      if (dirs.some((dir) => keptPath.startsWith(`${dir}\\`))) return 'A cópia que deveria ficar está dentro de uma pasta selecionada.';
    }
    const lower = info.path.toLowerCase();
    if (dirs.some((dir) => lower !== dir && lower.startsWith(`${dir}\\`))) return 'Já incluído na pasta selecionada acima dele.';
    return null;
  }

  cancel(): void {
    this.cancelled = true;
  }

  async run(token: string, confirmPermanent: (plan: DeletePlan) => Promise<boolean>, onProgress: (progress: DeleteProgress) => void): Promise<DeleteOutcome> {
    const stored = this.plans.get(token);
    if (!stored) throw new Error('Esta confirmação expirou. Revise a seleção de novo.');
    if (this.running) throw new Error('Já existe uma exclusão em andamento.');
    this.plans.delete(token);
    const { plan, infos, keep } = stored;
    if (plan.permanent && !(await confirmPermanent(plan))) {
      return { moved: 0, bytes: 0, failed: [], cancelled: true, permanent: true };
    }

    this.running = true;
    this.cancelled = false;
    const queue = plan.entries.filter((entry) => entry.status === 'ok');
    const outcome: DeleteOutcome = { moved: 0, bytes: 0, failed: [], cancelled: false, permanent: plan.permanent };
    let done = 0;
    let cursor = 0;
    const removed: number[] = [];

    const worker = async () => {
      while (cursor < queue.length && !this.cancelled) {
        const entry = queue[cursor++];
        onProgress({ done, total: queue.length, current: entry.path });
        const info = infos.get(entry.id) as NodeInfo;
        try {
          const problem = await this.precheck(info, keep[entry.id] === undefined ? undefined : infos.get(keep[entry.id]), plan.permanent);
          if (problem) throw new Error(problem);
          if (plan.permanent) await this.deps.remove(entry.path);
          else await this.deps.trash(entry.path);
          outcome.moved += 1;
          outcome.bytes += entry.bytes;
          removed.push(entry.id);
          this.deps.log({ time: this.deps.now(), action: plan.permanent ? 'permanent' : 'trash', path: entry.path, bytes: entry.bytes, ok: true });
        } catch (error) {
          const reason = friendly(error);
          outcome.failed.push({ id: entry.id, path: entry.path, reason });
          this.deps.log({ time: this.deps.now(), action: plan.permanent ? 'permanent' : 'trash', path: entry.path, bytes: entry.bytes, ok: false, reason });
        }
        done += 1;
        onProgress({ done, total: queue.length, current: entry.path });
      }
    };

    try {
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
      outcome.cancelled = this.cancelled;
      if (removed.length > 0) await this.deps.forget(removed);
    } finally {
      this.running = false;
    }
    return outcome;
  }

  private async precheck(info: NodeInfo, keeper: NodeInfo | undefined, permanent: boolean): Promise<string | null> {
    if (keeper) {
      const same = await this.deps.verifyDuplicate(keeper.id, info.id);
      if (!same) return 'A cópia mantida já não é idêntica. Nada foi excluído.';
    }
    let real: string;
    try {
      real = await this.deps.realPath(info.path);
    } catch {
      return 'O item não existe mais neste caminho.';
    }
    const guard = checkDeletable(real, this.deps.guardEnv());
    if (!guard.ok) return guard.reason;

    const stat = await this.deps.stat(info.path);
    if (stat.isLink) return 'O item virou um link desde a análise.';
    const isDir = (info.flags & FLAG.dir) !== 0;
    if (stat.isDirectory !== isDir) return 'O item mudou de tipo desde a análise.';
    if (!isDir) {
      if (stat.size !== info.rawSize) return 'O arquivo mudou de tamanho desde a análise. Analise de novo.';
      if (Math.abs(stat.mtimeMs / 1000 - info.mtime) > 2) return 'O arquivo foi alterado desde a análise. Analise de novo.';
    }
    if (isDir && permanent && (await this.deps.countFiles(info.path)) !== info.files) return 'A pasta mudou desde a análise. Analise de novo.';
    if (keeper) {
      try {
        const keptStat = await this.deps.stat(keeper.path);
        if (keptStat.isLink || keptStat.isDirectory) return 'A cópia mantida virou um link desde a análise. Nada foi excluído.';
        const keptReal = await this.deps.realPath(keeper.path);
        if (keptReal.toLowerCase() === real.toLowerCase()) return 'A cópia mantida aponta para o mesmo arquivo. Nada foi excluído.';
        if (stat.fileKey && stat.fileKey === keptStat.fileKey) return 'A cópia mantida é o mesmo arquivo no disco. Nada foi excluído.';
      } catch {
        return 'A cópia mantida não está mais acessível. Nada foi excluído.';
      }
    }
    return null;
  }
}

function friendly(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/EBUSY|in use|being used|sharing violation/i.test(message)) return 'Está em uso por outro programa.';
  if (/EPERM|EACCES|access is denied|acesso negado/i.test(message)) return 'Sem permissão. Tente abrir o DiskHunter como administrador.';
  if (/Failed to (parse path|create FileOp)|recycle|trash/i.test(message)) return 'A Lixeira não aceitou este item. Ele não foi alterado.';
  if (/ENOENT/.test(message)) return 'O item não existe mais neste caminho.';
  return message.length > 160 ? `${message.slice(0, 157)}...` : message;
}
