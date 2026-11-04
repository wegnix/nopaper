import { create } from 'zustand';

type Theme = 'light' | 'dark';
export const useTheme = create<{ theme: Theme; toggle(): void; set(t: Theme): void }>((set, get) => ({
  theme: (document.documentElement.dataset.theme as Theme) || 'dark',
  set(t) {
    document.documentElement.dataset.theme = t;
    document.querySelector('meta[name=theme-color]')?.setAttribute('content', t === 'dark' ? '#0b0f19' : '#eef0f6');
    try { localStorage.setItem('np:theme', t); } catch { /* ignore */ }
    set({ theme: t });
  },
  toggle() { get().set(get().theme === 'dark' ? 'light' : 'dark'); },
}));
