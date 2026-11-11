import { sql } from 'drizzle-orm';
import {
  pgTable, uuid, text, varchar, boolean, timestamp, date, numeric, integer, smallint,
  jsonb, bigserial, bigint, primaryKey, uniqueIndex, index, type AnyPgColumn,
} from 'drizzle-orm/pg-core';

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date());
const id = () => uuid('id').primaryKey().default(sql`gen_random_uuid()`);

// ------------------------------------------------------------------ identidade
export const users = pgTable('users', {
  id: id(),
  email: varchar('email', { length: 255 }).notNull(),
  /** Nome de usuário para login (minúsculo, único). */
  username: varchar('username', { length: 32 }).notNull(),
  name: varchar('name', { length: 120 }).notNull(),
  passwordHash: text('password_hash').notNull(),
  /** Senha provisória (definida pelo .env ou por um administrador): obriga a trocar no próximo login. */
  mustChangePassword: boolean('must_change_password').notNull().default(false),
  isSuperadmin: boolean('is_superadmin').notNull().default(false),
  /** Pode criar espaços novos (superadmin sempre pode). Definido em Plataforma → Usuários. */
  canCreateOrgs: boolean('can_create_orgs').notNull().default(false),
  active: boolean('active').notNull().default(true),
  /**
   * Conta removida: a linha fica (o nome continua aparecendo no que a pessoa lançou e na auditoria),
   * mas sem acesso, fora das listas, e com e-mail/usuário trocados para liberar os originais.
   */
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  telegramChatId: varchar('telegram_chat_id', { length: 64 }),
  preferences: jsonb('preferences').$type<Record<string, unknown>>().notNull().default({}),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex('users_email_uq').on(sql`lower(${t.email})`), uniqueIndex('users_username_uq').on(sql`lower(${t.username})`)]);

export const sessions = pgTable('sessions', {
  id: id(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  refreshHash: varchar('refresh_hash', { length: 128 }).notNull(),
  /** Hash anterior, aceito por alguns segundos após a rotação (duas abas / resposta perdida). */
  prevRefreshHash: varchar('prev_refresh_hash', { length: 128 }),
  prev2RefreshHash: varchar('prev2_refresh_hash', { length: 128 }),
  rotatedAt: timestamp('rotated_at', { withTimezone: true }),
  /** Última interação real da pessoa (heartbeat do front); base do logoff por inatividade. */
  lastActivityAt: timestamp('last_activity_at', { withTimezone: true }).notNull().defaultNow(),
  userAgent: varchar('user_agent', { length: 255 }),
  ip: varchar('ip', { length: 64 }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: createdAt(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('sessions_user_idx').on(t.userId)]);

// ------------------------------------------------------------------ organizações (multi-tenant)
export const organizations = pgTable('organizations', {
  id: id(),
  name: varchar('name', { length: 120 }).notNull(),
  kind: varchar('kind', { length: 16 }).notNull().default('company'), // personal | company
  document: varchar('document', { length: 32 }),
  timezone: varchar('timezone', { length: 64 }).notNull().default('America/Sao_Paulo'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const memberships = pgTable('memberships', {
  id: id(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  isOwner: boolean('is_owner').notNull().default(false),
  active: boolean('active').notNull().default(true),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('memberships_org_user_uq').on(t.orgId, t.userId), index('memberships_user_idx').on(t.userId)]);

export const groups = pgTable('groups', {
  id: id(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 64 }).notNull(),
  description: varchar('description', { length: 255 }),
  isAdmin: boolean('is_admin').notNull().default(false),
  permissions: text('permissions').array().notNull().default(sql`'{}'::text[]`),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex('groups_org_name_uq').on(t.orgId, t.name)]);

export const membershipGroups = pgTable('membership_groups', {
  membershipId: uuid('membership_id').notNull().references(() => memberships.id, { onDelete: 'cascade' }),
  groupId: uuid('group_id').notNull().references(() => groups.id, { onDelete: 'cascade' }),
}, (t) => [primaryKey({ columns: [t.membershipId, t.groupId] })]);

/** Configurações chave/valor por organização (alertas, preferências, etc). */
export const orgSettings = pgTable('org_settings', {
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  key: varchar('key', { length: 64 }).notNull(),
  value: jsonb('value').notNull(),
  updatedAt: updatedAt(),
}, (t) => [primaryKey({ columns: [t.orgId, t.key] })]);

/** Configurações globais da instalação (SMTP, Telegram bot, backups). */
export const systemSettings = pgTable('system_settings', {
  key: varchar('key', { length: 64 }).primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: updatedAt(),
});

// ------------------------------------------------------------------ financeiro
export const categories = pgTable('categories', {
  id: id(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  label: varchar('label', { length: 64 }).notNull(),
  color: varchar('color', { length: 16 }).notNull().default('slate'),
  kind: varchar('kind', { length: 16 }).notNull().default('both'), // payable | receivable | both
  isRestricted: boolean('is_restricted').notNull().default(false),
  isSystem: boolean('is_system').notNull().default(false),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex('categories_org_label_uq').on(t.orgId, sql`lower(${t.label})`)]);

export const folders = pgTable('folders', {
  id: id(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 64 }).notNull(),
  label: varchar('label', { length: 32 }).notNull(),
  color: varchar('color', { length: 16 }).notNull().default('slate'),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex('folders_org_name_uq').on(t.orgId, sql`lower(${t.name})`)]);

export const bills = pgTable('bills', {
  id: id(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  type: varchar('type', { length: 16 }).notNull(), // payable | receivable
  parentId: uuid('parent_id').references((): AnyPgColumn => bills.id, { onDelete: 'set null' }),
  description: varchar('description', { length: 255 }).notNull(),
  categoryId: uuid('category_id').notNull().references(() => categories.id, { onDelete: 'restrict' }),
  folderId: uuid('folder_id').references(() => folders.id, { onDelete: 'set null' }),
  cardId: uuid('card_id'),
  statementId: uuid('statement_id'),
  amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
  dueDate: date('due_date').notNull(),
  status: varchar('status', { length: 16 }).notNull().default('pending'), // pending | paid
  paidAt: date('paid_at'),
  paidAmount: numeric('paid_amount', { precision: 14, scale: 2 }),
  recurrenceType: varchar('recurrence_type', { length: 16 }).notNull().default('once'),
  installmentNumber: smallint('installment_number'),
  totalInstallments: smallint('total_installments'),
  isIndefinite: boolean('is_indefinite').notNull().default(false),
  /** Dia original da série (preserva o dia mesmo se uma ocorrência for editada). */
  recurrenceDay: smallint('recurrence_day'),
  relatedPerson: varchar('related_person', { length: 128 }),
  notes: text('notes'),
  barcode: varchar('barcode', { length: 120 }),
  pixKey: text('pix_key'),
  paymentMethod: varchar('payment_method', { length: 64 }),
  importBatchId: uuid('import_batch_id'),
  /** Conta gerada pela folha de pagamento (valor/vencimento vêm do lançamento). */
  payrollEntryId: uuid('payroll_entry_id'),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  index('bills_org_type_due_idx').on(t.orgId, t.type, t.dueDate),
  index('bills_org_status_idx').on(t.orgId, t.status),
  index('bills_parent_idx').on(t.parentId),
  index('bills_category_idx').on(t.categoryId),
  index('bills_folder_idx').on(t.folderId),
  index('bills_payroll_entry_idx').on(t.payrollEntryId).where(sql`${t.payrollEntryId} is not null`),
  index('bills_indefinite_idx').on(t.isIndefinite).where(sql`${t.isIndefinite} = true`),
]);

export const attachments = pgTable('attachments', {
  id: id(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  billId: uuid('bill_id').notNull().references(() => bills.id, { onDelete: 'cascade' }),
  slot: varchar('slot', { length: 16 }).notNull(), // boleto | invoice | payment_proof
  originalName: varchar('original_name', { length: 255 }).notNull(),
  mime: varchar('mime', { length: 100 }).notNull(),
  size: integer('size').notNull(),
  storageKey: varchar('storage_key', { length: 255 }).notNull(),
  sha256: varchar('sha256', { length: 64 }).notNull(),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('attachments_bill_slot_uq').on(t.billId, t.slot)]);

// ------------------------------------------------------------------ auditoria
export const auditLogs = pgTable('audit_logs', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  orgId: uuid('org_id'),
  userId: uuid('user_id'),
  userName: varchar('user_name', { length: 120 }),
  action: varchar('action', { length: 80 }).notNull(),
  entityType: varchar('entity_type', { length: 40 }),
  entityId: varchar('entity_id', { length: 120 }),
  description: text('description'),
  details: jsonb('details'),
  ip: varchar('ip', { length: 64 }),
  userAgent: varchar('user_agent', { length: 255 }),
  createdAt: createdAt(),
}, (t) => [index('audit_org_created_idx').on(t.orgId, t.createdAt), index('audit_org_id_idx').on(t.orgId, t.id)]);

// ------------------------------------------------------------------ cartões de crédito
export const cards = pgTable('cards', {
  id: id(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 64 }).notNull(),
  brand: varchar('brand', { length: 16 }).notNull().default('other'),
  last4: varchar('last4', { length: 4 }),
  color: varchar('color', { length: 16 }).notNull().default('indigo'),
  limitAmount: numeric('limit_amount', { precision: 14, scale: 2 }),
  closingDay: smallint('closing_day').notNull(),
  dueDay: smallint('due_day').notNull(),
  /** Categoria/pasta usadas na conta a pagar gerada para cada fatura. */
  billCategoryId: uuid('bill_category_id').notNull().references(() => categories.id, { onDelete: 'restrict' }),
  billFolderId: uuid('bill_folder_id').references(() => folders.id, { onDelete: 'set null' }),
  holder: varchar('holder', { length: 64 }),
  active: boolean('active').notNull().default(true),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index('cards_org_idx').on(t.orgId)]);

export const cardStatements = pgTable('card_statements', {
  id: id(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  cardId: uuid('card_id').notNull().references(() => cards.id, { onDelete: 'cascade' }),
  /** Mês de referência = mês do vencimento (YYYY-MM). */
  ref: varchar('ref', { length: 7 }).notNull(),
  closingDate: date('closing_date').notNull(),
  dueDate: date('due_date').notNull(),
  billId: uuid('bill_id').references(() => bills.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('card_statements_card_ref_uq').on(t.cardId, t.ref)]);

/** Categorias das compras no cartão (detalham a fatura; independentes das categorias de contas). */
export const cardCategories = pgTable('card_categories', {
  id: id(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  label: varchar('label', { length: 64 }).notNull(),
  color: varchar('color', { length: 16 }).notNull().default('slate'),
  /** Regra automática (SPENDING_KEYS) que manda compras para esta categoria; null = só pelo histórico. */
  ruleKey: varchar('rule_key', { length: 24 }),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index('card_categories_org_idx').on(t.orgId)]);

export const cardTransactions = pgTable('card_transactions', {
  id: id(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  cardId: uuid('card_id').notNull().references(() => cards.id, { onDelete: 'cascade' }),
  statementId: uuid('statement_id').notNull().references(() => cardStatements.id, { onDelete: 'cascade' }),
  /** Agrupa as parcelas de uma mesma compra. */
  groupId: uuid('group_id').notNull(),
  description: varchar('description', { length: 255 }).notNull(),
  /** Categoria do cartão (não a de contas a pagar); null só em lançamento antigo ainda não classificado. */
  categoryId: uuid('card_category_id').references(() => cardCategories.id, { onDelete: 'restrict' }),
  /** Positivo = compra; negativo = estorno/crédito. */
  amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
  /** Valor total da compra (todas as parcelas). */
  totalAmount: numeric('total_amount', { precision: 14, scale: 2 }).notNull(),
  purchaseDate: date('purchase_date').notNull(),
  installmentNumber: smallint('installment_number').notNull().default(1),
  totalInstallments: smallint('total_installments').notNull().default(1),
  notes: text('notes'),
  importBatchId: uuid('import_batch_id'),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  index('card_tx_statement_idx').on(t.statementId),
  index('card_tx_group_idx').on(t.groupId),
  index('card_tx_org_date_idx').on(t.orgId, t.purchaseDate),
  index('card_tx_category_idx').on(t.categoryId),
]);

// ------------------------------------------------------------------ folha de pagamento (espaço Empresa)
export const employees = pgTable('employees', {
  id: id(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 120 }).notNull(),
  document: varchar('document', { length: 32 }),
  role: varchar('role', { length: 64 }),
  admissionDate: date('admission_date'),
  terminationDate: date('termination_date'),
  active: boolean('active').notNull().default(true),
  pixKey: varchar('pix_key', { length: 140 }),
  /** Telefone/WhatsApp, formatado "(11) 91234-5678". */
  phone: varchar('phone', { length: 32 }),
  /** Código do vendedor no relatório de vendas (comissões). */
  sellerCode: varchar('seller_code', { length: 20 }),
  /** Matrícula no holerite do contador (importar holerites). */
  payslipCode: varchar('payslip_code', { length: 20 }),
  /** Tem holerite, mas não recebe pela empresa: valor a pagar e custo zerados, sem conta a pagar. */
  payslipOnly: boolean('payslip_only').notNull().default(false),
  bankInfo: varchar('bank_info', { length: 255 }),
  notes: text('notes'),
  /** Criado por uma importação da planilha (desfazer a importação remove se não tiver outros meses). */
  importBatchId: uuid('import_batch_id'),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex('employees_org_name_uq').on(t.orgId, sql`lower(${t.name})`),
  uniqueIndex('employees_org_seller_uq').on(t.orgId, t.sellerCode).where(sql`${t.sellerCode} is not null`),
  uniqueIndex('employees_org_payslip_uq').on(t.orgId, t.payslipCode).where(sql`${t.payslipCode} is not null`),
]);

/** Rubricas: holerite (proventos/descontos), fora do holerite (extras/descontos) e encargos da empresa. */
export const payrollRubrics = pgTable('payroll_rubrics', {
  id: id(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 64 }).notNull(),
  section: varchar('section', { length: 16 }).notNull(), // payslip | extra | employer
  kind: varchar('kind', { length: 16 }).notNull().default('earning'), // earning | deduction
  fixed: boolean('fixed').notNull().default(false),
  active: boolean('active').notNull().default(true),
  /** Provento do holerite que conta para FGTS, 13º e férias (false = pró-labore). */
  laborCharges: boolean('labor_charges').notNull().default(true),
  sortOrder: smallint('sort_order').notNull().default(0),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex('payroll_rubrics_org_name_uq').on(t.orgId, sql`lower(${t.name})`)]);

/** Folha de um mês (competência AAAA-MM). */
export const payrollPeriods = pgTable('payroll_periods', {
  id: id(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  ref: varchar('ref', { length: 7 }).notNull(),
  payDate: date('pay_date').notNull(),
  /** Gera as contas a pagar dos lançamentos (meses importados do histórico: não). */
  billsEnabled: boolean('bills_enabled').notNull().default(true),
  notes: text('notes'),
  importBatchId: uuid('import_batch_id'),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex('payroll_periods_org_ref_uq').on(t.orgId, t.ref)]);

export const payrollEntries = pgTable('payroll_entries', {
  id: id(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  periodId: uuid('period_id').notNull().references(() => payrollPeriods.id, { onDelete: 'cascade' }),
  employeeId: uuid('employee_id').notNull().references(() => employees.id, { onDelete: 'restrict' }),
  /** Líquido do holerite (digitado, ou a soma das rubricas do holerite). */
  payslipNet: numeric('payslip_net', { precision: 14, scale: 2 }).notNull().default('0'),
  /** Holerite detalhado: valor líquido digitado do holerite, para conferir com a soma das rubricas. */
  payslipNetDeclared: numeric('payslip_net_declared', { precision: 14, scale: 2 }),
  /** Calculados ao salvar (payrollTotals). */
  total: numeric('total', { precision: 14, scale: 2 }).notNull().default('0'),
  offPayroll: numeric('off_payroll', { precision: 14, scale: 2 }).notNull().default('0'),
  employerCost: numeric('employer_cost', { precision: 14, scale: 2 }).notNull().default('0'),
  companyCost: numeric('company_cost', { precision: 14, scale: 2 }).notNull().default('0'),
  notes: text('notes'),
  billId: uuid('bill_id').references(() => bills.id, { onDelete: 'set null' }),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex('payroll_entries_period_employee_uq').on(t.periodId, t.employeeId), index('payroll_entries_employee_idx').on(t.employeeId)]);

export const payrollEntryLines = pgTable('payroll_entry_lines', {
  id: id(),
  entryId: uuid('entry_id').notNull().references(() => payrollEntries.id, { onDelete: 'cascade' }),
  rubricId: uuid('rubric_id').notNull().references(() => payrollRubrics.id, { onDelete: 'restrict' }),
  amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
  note: varchar('note', { length: 120 }),
}, (t) => [index('payroll_lines_entry_idx').on(t.entryId), index('payroll_lines_rubric_idx').on(t.rubricId)]);

/**
 * Relatórios de vendas importados para as comissões (o mais recente de cada mês é o que vale).
 * Guarda o relatório lido e o resultado, para rever a tela depois sem enviar o PDF de novo.
 */
export const payrollCommissionImports = pgTable('payroll_commission_imports', {
  id: id(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  periodId: uuid('period_id').notNull().references(() => payrollPeriods.id, { onDelete: 'cascade' }),
  fileName: varchar('file_name', { length: 200 }).notNull(),
  dateFrom: date('date_from'),
  dateTo: date('date_to'),
  /** Vendedores e grupos do relatório (SalesSeller[]). */
  sellers: jsonb('sellers').notNull(),
  /** Resultado ao aplicar (applied/skipped/linked/missing). */
  result: jsonb('result').notNull(),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
}, (t) => [index('payroll_comm_imports_period_idx').on(t.periodId, t.createdAt)]);

// ------------------------------------------------------------------ contas bancárias e extratos (OFX)
export const bankAccounts = pgTable('bank_accounts', {
  id: id(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 80 }).notNull(),
  /** Código do banco com 3 dígitos (BANKID do OFX). */
  bankCode: varchar('bank_code', { length: 8 }),
  branch: varchar('branch', { length: 20 }),
  accountNumber: varchar('account_number', { length: 30 }),
  /** accountKey(banco, agência, conta): reconhece a conta do arquivo. */
  matchKey: varchar('match_key', { length: 80 }),
  kind: varchar('kind', { length: 16 }).notNull().default('checking'),
  color: varchar('color', { length: 16 }).notNull().default('sky'),
  active: boolean('active').notNull().default(true),
  notes: text('notes'),
  /** Saldo do último extrato importado (LEDGERBAL) e a data dele. */
  balance: numeric('balance', { precision: 14, scale: 2 }),
  balanceDate: date('balance_date'),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex('bank_accounts_org_key_uq').on(t.orgId, t.matchKey).where(sql`${t.matchKey} is not null`)]);

export const bankImports = pgTable('bank_imports', {
  id: id(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  accountId: uuid('account_id').notNull().references(() => bankAccounts.id, { onDelete: 'cascade' }),
  fileName: varchar('file_name', { length: 200 }).notNull(),
  dateFrom: date('date_from'),
  dateTo: date('date_to'),
  balance: numeric('balance', { precision: 14, scale: 2 }),
  balanceDate: date('balance_date'),
  /** Lançamentos no arquivo e quantos eram novos (o resto já tinha sido importado). */
  txCount: integer('tx_count').notNull().default(0),
  newCount: integer('new_count').notNull().default(0),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
}, (t) => [index('bank_imports_account_idx').on(t.accountId, t.createdAt)]);

/**
 * Lançamento do extrato. `status`: pending | linked (ligado a uma conta) | ignored.
 * `action` (ligado): paid = a conciliação deu baixa na conta; matched = a conta já estava paga;
 * created = a conta foi criada pelo extrato. Desfazer volta cada caso.
 */
export const bankTransactions = pgTable('bank_transactions', {
  id: id(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  accountId: uuid('account_id').notNull().references(() => bankAccounts.id, { onDelete: 'cascade' }),
  importId: uuid('import_id').references(() => bankImports.id, { onDelete: 'set null' }),
  fitId: varchar('fit_id', { length: 120 }).notNull(),
  postedAt: date('posted_at').notNull(),
  amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
  trnType: varchar('trn_type', { length: 16 }),
  memo: varchar('memo', { length: 255 }),
  name: varchar('name', { length: 255 }),
  refNum: varchar('ref_num', { length: 64 }),
  checkNum: varchar('check_num', { length: 64 }),
  status: varchar('status', { length: 16 }).notNull().default('pending'),
  action: varchar('action', { length: 16 }),
  billId: uuid('bill_id').references(() => bills.id, { onDelete: 'set null' }),
  reconciledBy: uuid('reconciled_by'),
  reconciledAt: timestamp('reconciled_at', { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex('bank_tx_account_fit_uq').on(t.accountId, t.fitId),
  index('bank_tx_account_date_idx').on(t.accountId, t.postedAt),
  index('bank_tx_bill_idx').on(t.billId),
]);

// ------------------------------------------------------------------ importações
export const importBatches = pgTable('import_batches', {
  id: id(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  /** payable | receivable | payroll | card (fatura OFX) */
  type: varchar('type', { length: 16 }).notNull(),
  fileName: varchar('file_name', { length: 200 }).notNull(),
  rowCount: integer('row_count').notNull(),
  totalAmount: numeric('total_amount', { precision: 14, scale: 2 }).notNull(),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
  undoneAt: timestamp('undone_at', { withTimezone: true }),
}, (t) => [index('import_batches_org_idx').on(t.orgId, t.createdAt)]);

// ------------------------------------------------------------------ alertas e backups
export const alertDeliveries = pgTable('alert_deliveries', {
  id: id(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  /** telegram | email */
  channel: varchar('channel', { length: 16 }).notNull(),
  target: varchar('target', { length: 200 }).notNull(),
  /** ok | error */
  status: varchar('status', { length: 8 }).notNull(),
  items: integer('items').notNull().default(0),
  test: boolean('test').notNull().default(false),
  error: text('error'),
  createdAt: createdAt(),
}, (t) => [index('alert_deliveries_org_idx').on(t.orgId, t.createdAt)]);

export const backupRuns = pgTable('backup_runs', {
  id: id(),
  /** schedule | manual */
  trigger: varchar('trigger', { length: 16 }).notNull(),
  /** running | ok | error */
  status: varchar('status', { length: 8 }).notNull(),
  fileName: varchar('file_name', { length: 200 }),
  sizeBytes: bigint('size_bytes', { mode: 'number' }),
  /** none | ok | error */
  remoteStatus: varchar('remote_status', { length: 8 }).notNull().default('none'),
  error: text('error'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
});

// ------------------------------------------------------------------ área do contador
/**
 * Documentos enviados pelo contador (holerites, guias de impostos, mensalidade, outros). O arquivo
 * fica em STORAGE_DIR como os anexos. Quem confere marca como lançado (com a conta a pagar criada,
 * se houver) ou dispensa.
 */
export const accountingDocuments = pgTable('accounting_documents', {
  id: id(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  /** to_client (contador → espaço) | to_accountant (espaço → contador) */
  direction: varchar('direction', { length: 16 }).notNull().default('to_client'),
  /** payslip | office_fee | das | darf | dae | state_tax | other | invoice */
  kind: varchar('kind', { length: 16 }).notNull(),
  /** Competência AAAA-MM. */
  competence: varchar('competence', { length: 7 }),
  note: varchar('note', { length: 500 }),
  originalName: varchar('original_name', { length: 255 }).notNull(),
  mime: varchar('mime', { length: 100 }).notNull(),
  size: integer('size').notNull(),
  storageKey: varchar('storage_key', { length: 255 }).notNull(),
  sha256: varchar('sha256', { length: 64 }).notNull(),
  /** Lido do arquivo no envio (valor, vencimento, código de barras; holerites: quantos). */
  detected: jsonb('detected'),
  /** new | done | dismissed */
  status: varchar('status', { length: 12 }).notNull().default('new'),
  billId: uuid('bill_id').references(() => bills.id, { onDelete: 'set null' }),
  handledBy: uuid('handled_by'),
  handledAt: timestamp('handled_at', { withTimezone: true }),
  handleNote: varchar('handle_note', { length: 500 }),
  uploadedBy: uuid('uploaded_by'),
  /**
   * Tirado da lista de quem confere (por quem confere, ou cancelado por quem enviou). Nada é apagado:
   * quem enviou continua vendo o registro e o arquivo no histórico dele.
   */
  hiddenAt: timestamp('hidden_at', { withTimezone: true }),
  hiddenBy: uuid('hidden_by'),
  /** Quem enviou tirou do próprio histórico. Com os dois lados fora, a linha e o arquivo são apagados. */
  uploaderRemovedAt: timestamp('uploader_removed_at', { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [index('accounting_docs_org_idx').on(t.orgId, t.status, t.createdAt)]);
