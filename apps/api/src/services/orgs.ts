import { DEFAULT_OPERATOR_PERMISSIONS, DEFAULT_READONLY_PERMISSIONS, type ColorKey, type OrgKind } from '@nopaper/shared';
import type { DBOrTx } from '../db/client.js';
import { schema } from '../db/client.js';
import { seedCardCategories } from './cardCategories.js';

type Kind = 'payable' | 'receivable' | 'both';
type DefaultFolder = { label: string; name: string; color: ColorKey };
type DefaultCategory = [label: string, color: ColorKey, restricted?: boolean];

/**
 * Estrutura padrão de todo espaço novo, conforme o perfil: Pessoal = base; Empresa = base + extras.
 * Cores: cada pasta e cada categoria de contas a pagar com uma cor diferente (nenhuma repetida,
 * e as pastas não repetem cores das categorias), para se distinguirem na lista.
 */
const BASE_FOLDERS: DefaultFolder[] = [
  { label: 'FCNF', name: 'Contas FIXA com NF', color: 'indigo' },
  { label: 'FSNF', name: 'Contas FIXA sem NF', color: 'amber' },
  { label: 'VCNF', name: 'Contas VARIAVEL com NF', color: 'teal' },
  { label: 'VSNF', name: 'Contas VARIAVEL sem NF', color: 'pink' },
];
const COMPANY_FOLDERS: DefaultFolder[] = [
  { label: 'FUNCIONARIO', name: 'Contas de FUNCIONARIO', color: 'navy' },
  { label: 'BANCO', name: 'Contas de BANCO', color: 'gold' },
];
const BASE_PAYABLE_CATEGORIES: DefaultCategory[] = [
  ['Cartão', 'fuchsia'], ['Consórcios', 'lime'], ['Educação', 'cyan'], ['Fixa', 'blue'], ['Imposto', 'red'],
  ['Outros', 'slate'], ['Saúde', 'emerald'], ['Serviços', 'orange'], ['Variável', 'purple'],
];
/** "Cartão" também está na lista da empresa, mas já vem na base. */
const COMPANY_PAYABLE_CATEGORIES: DefaultCategory[] = [
  ['Bônus', 'sky'], ['Comissão', 'coral'], ['Férias', 'yellow'], ['Frota', 'violet'], ['Marketing', 'rose'],
  ['Pró-Labore', 'wine', true], ['Salário', 'green'], ['Segurança do Trabalho', 'olive'], ['Ticket Refeição', 'brown'],
];
export const DEFAULT_FOLDERS: Record<OrgKind, DefaultFolder[]> = {
  personal: BASE_FOLDERS,
  company: [...BASE_FOLDERS, ...COMPANY_FOLDERS],
};
export const DEFAULT_PAYABLE_CATEGORIES: Record<OrgKind, DefaultCategory[]> = {
  personal: BASE_PAYABLE_CATEGORIES,
  company: [...BASE_PAYABLE_CATEGORIES, ...COMPANY_PAYABLE_CATEGORIES],
};
/** Contas a receber precisam de ao menos uma categoria; nomes que não colidem com os de contas a pagar. */
const DEFAULT_RECEIVABLE_CATEGORIES: Record<OrgKind, DefaultCategory[]> = {
  company: [['Vendas', 'emerald'], ['Serviços prestados', 'sky'], ['Outras receitas', 'yellow']],
  personal: [['Aluguel', 'sky']],
};

/** Cria organização com grupos, pastas e categorias padrão do perfil; o usuário vira dono. */
export async function createOrganization(tx: DBOrTx, opts: { name: string; kind: OrgKind; document?: string | null; ownerId: string }) {
  const [org] = await tx.insert(schema.organizations).values({ name: opts.name, kind: opts.kind, document: opts.document ?? null }).returning();
  const [m] = await tx.insert(schema.memberships).values({ orgId: org.id, userId: opts.ownerId, isOwner: true }).returning();
  const [admin] = await tx.insert(schema.groups).values([
    { orgId: org.id, name: 'Administradores', description: 'Acesso total à organização', isAdmin: true, permissions: [] },
    { orgId: org.id, name: 'Operadores', description: 'Lançam e pagam contas, sem administração', permissions: DEFAULT_OPERATOR_PERMISSIONS },
    { orgId: org.id, name: 'Leitura', description: 'Apenas visualização', permissions: DEFAULT_READONLY_PERMISSIONS },
  ]).returning();
  await tx.insert(schema.membershipGroups).values({ membershipId: m.id, groupId: admin.id });
  const cats: Array<[DefaultCategory, Kind]> = [
    ...DEFAULT_PAYABLE_CATEGORIES[opts.kind].map((c) => [c, 'payable'] as [DefaultCategory, Kind]),
    ...DEFAULT_RECEIVABLE_CATEGORIES[opts.kind].map((c) => [c, 'receivable'] as [DefaultCategory, Kind]),
  ];
  await tx.insert(schema.categories).values(cats.map(([[label, color, restricted], kind]) => ({
    orgId: org.id, label, color, kind, isRestricted: !!restricted, isSystem: false, createdBy: opts.ownerId,
  })));
  await tx.insert(schema.folders).values(DEFAULT_FOLDERS[opts.kind].map((f) => ({ orgId: org.id, ...f, createdBy: opts.ownerId })));
  await seedCardCategories(tx, org.id, opts.ownerId);
  return org;
}
