import type { FastifyRequest } from 'fastify';
import { and, eq, inArray, isNotNull, ne } from 'drizzle-orm';
import { accountLabel, sameAccountKey, formatDocument, normalizeDocument, personKey, sameCompany, type Payslip, type SpaceCheck } from '@nopaper/shared';
import { db, schema } from '../db/client.js';

/**
 * Proteção contra importar no espaço errado. Só olha para os OUTROS espaços de que a própria pessoa
 * participa — nunca revela a existência de um espaço a quem não é membro dele. Token de integração
 * não é membro de nada: para ele só vale a comparação com o próprio espaço.
 */
async function otherSpaces(req: FastifyRequest) {
  if (!req.user || req.integration) return [];
  return db.select({ id: schema.organizations.id, name: schema.organizations.name, document: schema.organizations.document })
    .from(schema.memberships).innerJoin(schema.organizations, eq(schema.organizations.id, schema.memberships.orgId))
    .where(and(eq(schema.memberships.userId, req.user.id), eq(schema.memberships.active, true), ne(schema.memberships.orgId, req.org!.id)));
}

const digits = (v: string | null | undefined) => (v ?? '').replace(/\D/g, '');
const firstName = (v: string) => personKey(v).split(' ')[0] ?? '';

/** Quantos holerites são de funcionários cadastrados: mesmo CPF, ou mesma matrícula com o mesmo primeiro nome. */
function slipsOf(slips: Payslip[], employees: Array<{ name: string; document: string | null; payslipCode: string | null }>) {
  return slips.filter((s) => employees.some((e) => {
    const a = digits(s.document), b = digits(e.document);
    if (a.length === 11 && a === b) return true;
    return !!s.code && e.payslipCode === s.code && firstName(e.name) === firstName(s.name);
  })).length;
}

/**
 * Holerites: o CNPJ impresso no PDF contra o CNPJ do espaço (matriz e filial contam como a mesma
 * empresa); sem CNPJ para comparar, os funcionários — nenhum holerite de quem está cadastrado aqui e
 * a maioria de quem está cadastrado em outro espaço da pessoa.
 */
export async function checkPayslipsSpace(req: FastifyRequest, report: { company: string | null; companyDocument: string | null; slips: Payslip[] }): Promise<SpaceCheck | null> {
  const [org] = await db.select({ document: schema.organizations.document }).from(schema.organizations).where(eq(schema.organizations.id, req.org!.id));
  const here = normalizeDocument(org?.document ?? '');
  const fileDoc = normalizeDocument(report.companyDocument ?? '');
  if (fileDoc && here && (fileDoc === here || sameCompany(fileDoc, here))) return null;
  const others = await otherSpaces(req);
  const company = report.company ? ` · ${report.company}` : '';
  if (fileDoc) {
    const found = `CNPJ ${formatDocument(fileDoc)}${company}`;
    const expected = here ? `${here.length === 14 ? 'CNPJ' : 'CPF'} ${formatDocument(here)}` : null;
    const o = others.find((x) => { const d = normalizeDocument(x.document ?? ''); return d === fileDoc || sameCompany(d, fileDoc); });
    if (o) return { kind: 'other_space', found, expected, match: 'o CNPJ do holerite é o deste outro espaço', space: { id: o.id, name: o.name } };
    if (here.length === 14) return { kind: 'mismatch', found, expected, match: null, space: null };
  }
  // sem CNPJ dos dois lados: decide pelos funcionários
  const cols = { name: schema.employees.name, document: schema.employees.document, payslipCode: schema.employees.payslipCode, orgId: schema.employees.orgId };
  const mine = await db.select(cols).from(schema.employees).where(eq(schema.employees.orgId, req.org!.id));
  if (slipsOf(report.slips, mine) > 0 || !others.length) return null;
  const theirs = await db.select(cols).from(schema.employees).where(inArray(schema.employees.orgId, others.map((o) => o.id)));
  let best: { o: (typeof others)[number]; n: number } | null = null;
  for (const o of others) {
    const n = slipsOf(report.slips, theirs.filter((e) => e.orgId === o.id));
    if (n > (best?.n ?? 0)) best = { o, n };
  }
  if (!best || best.n * 2 < report.slips.length) return null;
  return {
    kind: 'other_space', found: `${report.slips.length} holerite(s)${company}`, expected: null,
    match: `${best.n} de ${report.slips.length} holerites são de funcionários cadastrados neste outro espaço, e nenhum de funcionários daqui`, space: { id: best.o.id, name: best.o.name },
  };
}

/** Extrato: a conta do arquivo não existe aqui, mas está cadastrada em outro espaço da pessoa. */
export async function checkBankSpace(req: FastifyRequest, unknownKeys: string[]): Promise<SpaceCheck | null> {
  const keys = unknownKeys.filter(Boolean);
  if (!keys.length) return null;
  const others = await otherSpaces(req);
  if (!others.length) return null;
  const theirs = await db.select().from(schema.bankAccounts)
    .where(and(inArray(schema.bankAccounts.orgId, others.map((o) => o.id)), isNotNull(schema.bankAccounts.matchKey)));
  const hit = theirs.find((a) => keys.some((k) => sameAccountKey(a.matchKey, k)));
  if (!hit) return null;
  const o = others.find((x) => x.id === hit.orgId)!;
  return { kind: 'other_space', found: accountLabel(hit), expected: null, match: `esta conta está cadastrada lá como “${hit.name}”`, space: { id: o.id, name: o.name } };
}

/**
 * Fatura do cartão: a conta do arquivo (ACCTID) já foi importada em algum cartão? Devolve o cartão
 * deste espaço que a usa (para a tela avisar se o escolhido for outro) ou o aviso de outro espaço.
 */
export async function checkCardSpace(req: FastifyRequest, accountId: string | null): Promise<{ knownCard: { id: string; name: string } | null; spaceCheck: SpaceCheck | null }> {
  if (!accountId) return { knownCard: null, spaceCheck: null };
  const [mine] = await db.select({ id: schema.cards.id, name: schema.cards.name }).from(schema.cards)
    .where(and(eq(schema.cards.orgId, req.org!.id), eq(schema.cards.ofxAccount, accountId)));
  if (mine) return { knownCard: mine, spaceCheck: null };
  const others = await otherSpaces(req);
  if (!others.length) return { knownCard: null, spaceCheck: null };
  const [hit] = await db.select({ name: schema.cards.name, orgId: schema.cards.orgId }).from(schema.cards)
    .where(and(inArray(schema.cards.orgId, others.map((o) => o.id)), isNotNull(schema.cards.ofxAccount), eq(schema.cards.ofxAccount, accountId)));
  if (!hit) return { knownCard: null, spaceCheck: null };
  const o = others.find((x) => x.id === hit.orgId)!;
  return { knownCard: null, spaceCheck: { kind: 'other_space', found: `fatura do cartão final ${accountId.slice(-4)}`, expected: null, match: `as faturas deste cartão são importadas lá, no cartão “${hit.name}”`, space: { id: o.id, name: o.name } } };
}
