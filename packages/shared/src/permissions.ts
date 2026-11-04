/**
 * Catálogo de permissões por organização ("espaço").
 * Grupos recebem uma lista destas chaves; grupos com `isAdmin` passam em qualquer checagem.
 * O dono da organização (membership.isOwner) também tem todas.
 *
 * `requires`: permissões que não fazem sentido sozinhas (ex.: apagar sem ver). A tela marca
 * as dependências automaticamente e a API completa a lista ao salvar (`withRequired`).
 *
 * Criar espaços NÃO está aqui: é uma permissão da conta na plataforma (users.can_create_orgs),
 * porque acontece fora de qualquer espaço. Fica em Plataforma → Usuários.
 */
interface PermDef { group: string; label: string; hint?: string; requires?: readonly string[] }

export const PERMISSIONS = {
  'payable.view': { group: 'Contas a pagar', label: 'Ver contas a pagar', hint: 'Lista, anexos e totais.' },
  'payable.create': { group: 'Contas a pagar', label: 'Cadastrar contas a pagar', hint: 'Inclui anexar boleto e nota ao cadastrar.', requires: ['payable.view'] },
  'payable.edit': { group: 'Contas a pagar', label: 'Editar contas a pagar', hint: 'Dados, recorrência e anexos.', requires: ['payable.view'] },
  'payable.pay': { group: 'Contas a pagar', label: 'Dar baixa (pagar e reverter)', hint: 'Inclui o comprovante de pagamento e o pagamento em massa.', requires: ['payable.view'] },
  'payable.delete': { group: 'Contas a pagar', label: 'Apagar contas a pagar', requires: ['payable.view'] },

  'receivable.view': { group: 'Contas a receber', label: 'Ver contas a receber', hint: 'Lista, anexos e totais.' },
  'receivable.create': { group: 'Contas a receber', label: 'Cadastrar contas a receber', hint: 'Inclui anexar boleto e nota ao cadastrar.', requires: ['receivable.view'] },
  'receivable.edit': { group: 'Contas a receber', label: 'Editar contas a receber', hint: 'Dados, recorrência e anexos.', requires: ['receivable.view'] },
  'receivable.pay': { group: 'Contas a receber', label: 'Dar baixa (receber e reverter)', hint: 'Inclui o comprovante e a baixa em massa.', requires: ['receivable.view'] },
  'receivable.delete': { group: 'Contas a receber', label: 'Apagar contas a receber', requires: ['receivable.view'] },

  'bills.view_restricted': { group: 'Financeiro', label: 'Ver e mexer em categorias restritas', hint: 'Sem esta, as contas dessas categorias ficam invisíveis.' },
  'bills.categories': { group: 'Financeiro', label: 'Gerenciar categorias' },
  'bills.folders': { group: 'Financeiro', label: 'Gerenciar pastas' },
  'bills.export': { group: 'Financeiro', label: 'Exportar planilhas e ZIP para a contabilidade' },
  'bills.import': { group: 'Financeiro', label: 'Importar planilhas', hint: 'Também precisa poder cadastrar o tipo de conta importado.' },

  'cards.view': { group: 'Cartões', label: 'Ver cartões e faturas' },
  'cards.manage': { group: 'Cartões', label: 'Cadastrar, editar e apagar cartões', requires: ['cards.view'] },
  'cards.edit': { group: 'Cartões', label: 'Lançar, editar e apagar compras', hint: 'Pagar a fatura usa “Dar baixa” de contas a pagar.', requires: ['cards.view'] },

  'reports.view': { group: 'Relatórios', label: 'Ver relatórios e o gráfico anual do início' },

  'alerts.manage': { group: 'Espaço', label: 'Configurar alertas (Telegram / e-mail)' },
  'org.settings': { group: 'Espaço', label: 'Editar dados do espaço', hint: 'Nome, CPF/CNPJ, tipo e fuso horário.' },
  'members.manage': { group: 'Espaço', label: 'Gerenciar membros', hint: 'Adicionar, ativar/desativar e trocar grupos — só com grupos cujas permissões a própria pessoa já tem.' },
  'groups.manage': { group: 'Espaço', label: 'Gerenciar grupos e permissões', hint: 'Só concede permissões que a própria pessoa já tem.' },
  'audit.view': { group: 'Espaço', label: 'Ver auditoria' },
} as const satisfies Record<string, PermDef>;

export type Permission = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

export function isPermission(v: string): v is Permission {
  return v in PERMISSIONS;
}

export const permissionRequires = (p: Permission): Permission[] => [...((PERMISSIONS[p] as PermDef).requires ?? [])] as Permission[];

/** Completa a lista com as dependências (ex.: apagar → ver). */
export function withRequired(perms: Iterable<Permission>): Permission[] {
  const out = new Set<Permission>(perms);
  for (const p of [...out]) for (const r of permissionRequires(p)) out.add(r);
  return ALL_PERMISSIONS.filter((p) => out.has(p));
}

export type BillAction = 'view' | 'create' | 'edit' | 'pay' | 'delete';
export const billPerm = (type: 'payable' | 'receivable', action: BillAction) => `${type}.${action}` as Permission;

/** Permissões de um grupo "Operador" padrão criado junto com a organização. */
export const DEFAULT_OPERATOR_PERMISSIONS: Permission[] = [
  'payable.view', 'payable.create', 'payable.edit', 'payable.pay', 'payable.delete',
  'receivable.view', 'receivable.create', 'receivable.edit', 'receivable.pay', 'receivable.delete',
  'cards.view', 'cards.manage', 'cards.edit', 'reports.view',
];

/** Permissões de um grupo "Leitura" padrão. */
export const DEFAULT_READONLY_PERMISSIONS: Permission[] = [
  'payable.view', 'receivable.view', 'cards.view', 'reports.view',
];
