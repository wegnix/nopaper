import { useCallback, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { isColorKey, type OrgIdentity } from '@nopaper/shared';
import { get } from './api';
import { useSession } from './session';
import type { CardCategory, Category, Folder } from './types';

/** Cores que a pessoa escolheu só para ela (Contas → Cores): categoria → cor. */
export function useMyCategoryColors(): Record<string, string> {
  const raw = useSession((s) => s.user?.preferences?.categoryColors);
  return useMemo(() => (raw && typeof raw === 'object' ? (raw as Record<string, string>) : {}), [raw]);
}

/** Categorias do espaço, já com a cor que esta pessoa escolheu para si (a do espaço fica em `baseColor`). */
export function useCategories() {
  const orgId = useSession((s) => s.orgId);
  const mine = useMyCategoryColors();
  const select = useCallback((items: Category[]) => items.map((c) => {
    const own = mine[c.id];
    return isColorKey(own) && own !== c.color ? { ...c, color: own, baseColor: c.color } : c;
  }), [mine]);
  return useQuery({ queryKey: ['categories', orgId], queryFn: () => get<{ items: Category[] }>('/api/categories').then((r) => r.items), staleTime: 60_000, select });
}
/** Dados cadastrais do espaço (razão social, CNPJ, inscrições, endereço, contato) — usados nas impressões. */
export interface OrgDetails extends OrgIdentity { id: string; name: string; legalName: string | null; kind: 'personal' | 'company'; document: string | null; logo: string | null }
export function useOrgDetails() {
  const orgId = useSession((s) => s.orgId);
  return useQuery({ queryKey: ['org', orgId], queryFn: () => get<{ org: OrgDetails }>('/api/org').then((r) => r.org), staleTime: 60_000 });
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
