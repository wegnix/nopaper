import { create } from 'zustand';

/** Menu lateral recolhido (só ícones) no desktop; lembrado por navegador. */
const KEY = 'np:sidebar';
const read = () => { try { return localStorage.getItem(KEY) === 'collapsed'; } catch { return false; } };

export const useSidebar = create<{ collapsed: boolean; toggle(): void }>((set, get) => ({
  collapsed: read(),
  toggle() {
    const collapsed = !get().collapsed;
    try { localStorage.setItem(KEY, collapsed ? 'collapsed' : 'expanded'); } catch { /* ignore */ }
    set({ collapsed });
  },
}));
