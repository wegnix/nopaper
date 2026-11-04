import { create } from 'zustand';

/**
 * Restauração de backup em andamento: a API responde 503 `maintenance` a tudo.
 * `owner` = esta aba iniciou a restauração (mostra o progresso completo).
 */
interface MaintenanceState {
  active: boolean;
  owner: boolean;
  start(owner?: boolean): void;
  stop(): void;
}
export const useMaintenance = create<MaintenanceState>((set, get) => ({
  active: false,
  owner: false,
  start(owner = false) { set({ active: true, owner: owner || get().owner }); },
  stop() { set({ active: false, owner: false }); },
}));
