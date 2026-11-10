import { useQuery } from '@tanstack/react-query';
import { get } from './api';
import { useSession } from './session';
import type { CardCategory, Category, Folder } from './types';

export function useCategories() {
  const orgId = useSession((s) => s.orgId);
  return useQuery({ queryKey: ['categories', orgId], queryFn: () => get<{ items: Category[] }>('/api/categories').then((r) => r.items), staleTime: 60_000 });
}
export function useFolders() {
  const orgId = useSession((s) => s.orgId);
  return useQuery({ queryKey: ['folders', orgId], queryFn: () => get<{ items: Folder[] }>('/api/folders').then((r) => r.items), staleTime: 60_000 });
}
/** Categorias das compras no cartão (próprias, separadas das de contas). */
export function useCardCategories(enabled = true) {
  const orgId = useSession((s) => s.orgId);
  return useQuery({ enabled, queryKey: ['bills', orgId, 'card-categories'], queryFn: () => get<{ items: CardCategory[] }>('/api/card-categories').then((r) => r.items), staleTime: 60_000 });
}
