import { z } from 'zod';
import { normalizeDocument } from './document.js';

/**
 * Notas fiscais eletrônicas (NF-e, modelo 55) recebidas pela distribuição da SEFAZ
 * (webservice NFeDistribuicaoDFe do Ambiente Nacional). Só leitura do XML, sem dependência:
 * os documentos da SEFAZ seguem o leiaute oficial e os campos usados aqui não se repetem
 * dentro do bloco em que são procurados.
 */

/** Código IBGE da UF (cUFAutor da consulta). */
export const UF_CODES: Record<string, number> = {
  RO: 11, AC: 12, AM: 13, RR: 14, PA: 15, AP: 16, TO: 17, MA: 21, PI: 22, CE: 23, RN: 24, PB: 25, PE: 26, AL: 27,
  SE: 28, BA: 29, MG: 31, ES: 32, RJ: 33, SP: 35, PR: 41, SC: 42, RS: 43, MS: 50, MT: 51, GO: 52, DF: 53,
};

/** Hora padrão da consulta diária (o usuário escolhe; consulta 1 vez por dia). */
export const FISCAL_DEFAULT_HOUR = 6;
/** Intervalo mínimo entre duas consultas e depois de um bloqueio (a SEFAZ pede 1 hora; 5 min de folga para o relógio). */
export const FISCAL_MIN_GAP_MS = 65 * 60 * 1000;
/** Lotes de até 50 documentos; teto de lotes numa consulta (o restante fica para o dia seguinte). */
export const FISCAL_MAX_BATCHES = 40;
export const FISCAL_CERT_MAX_BYTES = 64 * 1024;

export const FISCAL_DOC_STATUSES = ['new', 'done', 'dismissed'] as const;
export type FiscalDocStatus = (typeof FISCAL_DOC_STATUSES)[number];
/** authorized = autorizada; canceled = cancelada pelo emitente; denied = denegada. */
export type FiscalSituation = 'authorized' | 'canceled' | 'denied';
/** summary = só o resumo (o XML completo exige manifestação); full = XML completo. */
export type FiscalDocKind = 'summary' | 'full';

export interface NfeDuplicate { number: string | null; dueDate: string | null; amount: string }

export interface NfeData {
  key: string;
  number: string | null;
  series: string | null;
  /** AAAA-MM-DD (parte escrita da data, sem converter fuso). */
  issuedAt: string | null;
  /** 0 = entrada, 1 = saída (do ponto de vista de quem emitiu). */
  operation: '0' | '1' | null;
  nature: string | null;
  emitterDocument: string | null;
  emitterName: string | null;
  emitterTradeName: string | null;
  recipientDocument: string | null;
  total: string | null;
  duplicates: NfeDuplicate[];
  /** Códigos tPag (15 = boleto, 01 = dinheiro, 17 = PIX…). */
  paymentKinds: string[];
  itemCount: number;
  info: string | null;
}

export interface NfeSummary {
  key: string;
  emitterDocument: string | null;
  emitterName: string | null;
  issuedAt: string | null;
  operation: '0' | '1' | null;
  total: string | null;
  situation: FiscalSituation;
}

export interface NfeEvent {
  key: string;
  /** 110111 = cancelamento, 110110 = carta de correção, 2102xx = manifestação do destinatário. */
  type: string;
  description: string | null;
  at: string | null;
}

// ------------------------------------------------------------------ leitura do XML
const decode = (s: string) => s
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** Conteúdo do 1º bloco `<tag …>…</tag>` (com ou sem prefixo de namespace). */
export function xmlBlock(xml: string, tag: string): string | null {
  const m = new RegExp(`<(?:\\w+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${tag}>`).exec(xml);
  return m ? m[1]! : null;
}
export function xmlBlocks(xml: string, tag: string): string[] {
  return [...xml.matchAll(new RegExp(`<(?:\\w+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${tag}>`, 'g'))].map((m) => m[1]!);
}
/** Texto do 1º `<tag>` (decodificado, sem espaços nas pontas); null se não houver ou vier vazio. */
export function xmlText(xml: string | null | undefined, tag: string): string | null {
  if (!xml) return null;
  const b = xmlBlock(xml, tag);
  if (b == null || b.includes('<')) return null;
  const t = decode(b).trim();
  return t || null;
}
export function xmlAttr(xml: string, tag: string, attr: string): string | null {
  const m = new RegExp(`<(?:\\w+:)?${tag}\\s[^>]*\\b${attr}="([^"]*)"`).exec(xml);
  return m ? decode(m[1]!) : null;
}

/** CPF/CNPJ só com dígitos (CNPJ alfanumérico: letras maiúsculas mantidas). */
export const docKey = (v: string | null | undefined) => (v ? normalizeDocument(v) : '');
/** Mesma raiz de CNPJ (8 primeiros) — matriz e filiais. */
export const sameCnpjRoot = (a: string | null | undefined, b: string | null | undefined) => {
  const x = docKey(a); const y = docKey(b);
  return x.length === 14 && y.length === 14 && x.slice(0, 8) === y.slice(0, 8);
};

const datePart = (v: string | null) => (v && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);
const moneyText = (v: string | null) => {
  if (!v || !/^-?\d+(\.\d{1,2})?$/.test(v)) return null;
  const [i, d = ''] = v.split('.');
  return `${i}.${d.padEnd(2, '0')}`;
};
const op = (v: string | null) => (v === '0' || v === '1' ? v : null);
const person = (block: string | null) => xmlText(block, 'CNPJ') ?? xmlText(block, 'CPF');

/** Chave de acesso de 44 dígitos (a parte do CNPJ pode ser alfanumérica). */
export const isNfeKey = (v: string | null | undefined) => !!v && /^\d{6}[0-9A-Z]{14}\d{24}$/.test(v);

/** XML completo da NF-e (`nfeProc` ou só `NFe`). null se não for uma NF-e. */
export function parseNfe(xml: string): NfeData | null {
  const inf = xmlBlock(xml, 'infNFe');
  if (!inf) return null;
  const id = xmlAttr(xml, 'infNFe', 'Id');
  const key = (xmlText(xmlBlock(xml, 'protNFe'), 'chNFe') ?? id?.replace(/^NFe/, '') ?? '').toUpperCase();
  if (!isNfeKey(key)) return null;
  const ide = xmlBlock(inf, 'ide');
  const emit = xmlBlock(inf, 'emit');
  const dest = xmlBlock(inf, 'dest');
  const cobr = xmlBlock(inf, 'cobr');
  const duplicates: NfeDuplicate[] = [];
  for (const d of cobr ? xmlBlocks(cobr, 'dup') : []) {
    const amount = moneyText(xmlText(d, 'vDup'));
    if (amount && Number(amount) > 0) duplicates.push({ number: xmlText(d, 'nDup'), dueDate: datePart(xmlText(d, 'dVenc')), amount });
  }
  const pag = xmlBlock(inf, 'pag');
  const paymentKinds = [...new Set((pag ? xmlBlocks(pag, 'detPag') : []).map((p) => xmlText(p, 'tPag')).filter((x): x is string => !!x))];
  return {
    key,
    number: xmlText(ide, 'nNF'),
    series: xmlText(ide, 'serie'),
    issuedAt: datePart(xmlText(ide, 'dhEmi') ?? xmlText(ide, 'dEmi')),
    operation: op(xmlText(ide, 'tpNF')),
    nature: xmlText(ide, 'natOp'),
    emitterDocument: person(emit),
    emitterName: xmlText(emit, 'xNome'),
    emitterTradeName: xmlText(emit, 'xFant'),
    recipientDocument: person(dest),
    total: moneyText(xmlText(xmlBlock(inf, 'ICMSTot'), 'vNF')),
    duplicates,
    paymentKinds,
    itemCount: xmlBlocks(inf, 'det').length,
    info: xmlText(xmlBlock(inf, 'infAdic'), 'infCpl')?.slice(0, 2000) ?? null,
  };
}

/** Resumo (`resNFe`): o que a SEFAZ entrega antes da manifestação. */
export function parseNfeSummary(xml: string): NfeSummary | null {
  const r = xmlBlock(xml, 'resNFe');
  if (r == null) return null;
  const key = (xmlText(r, 'chNFe') ?? '').toUpperCase();
  if (!isNfeKey(key)) return null;
  const sit = xmlText(r, 'cSitNFe');
  return {
    key,
    emitterDocument: person(r),
    emitterName: xmlText(r, 'xNome'),
    issuedAt: datePart(xmlText(r, 'dhEmi')),
    operation: op(xmlText(r, 'tpNF')),
    total: moneyText(xmlText(r, 'vNF')),
    situation: sit === '3' ? 'canceled' : sit === '2' ? 'denied' : 'authorized',
  };
}

/** Evento (`resEvento` ou `procEventoNFe`). */
export function parseNfeEvent(xml: string): NfeEvent | null {
  const r = xmlBlock(xml, 'resEvento') ?? xmlBlock(xml, 'infEvento');
  if (r == null) return null;
  const key = (xmlText(r, 'chNFe') ?? '').toUpperCase();
  const type = xmlText(r, 'tpEvento');
  if (!isNfeKey(key) || !type) return null;
  return { key, type, description: xmlText(r, 'xEvento') ?? xmlText(xmlBlock(r, 'detEvento'), 'descEvento'), at: datePart(xmlText(r, 'dhEvento')) };
}

export const NFE_EVENT_CANCEL = '110111';

// ------------------------------------------------------------------ retorno da distribuição
export interface DistDoc { nsu: string; schema: string; content: string }
export interface DistResponse {
  cStat: string | null;
  xMotivo: string | null;
  ultNSU: string | null;
  maxNSU: string | null;
  /** Conteúdo base64 (gzip) de cada documento. */
  docs: DistDoc[];
}

/** Lê o envelope SOAP de resposta do NFeDistribuicaoDFe (os documentos continuam compactados). */
export function parseDistResponse(xml: string): DistResponse {
  const ret = xmlBlock(xml, 'retDistDFeInt') ?? '';
  const docs: DistDoc[] = [];
  for (const m of ret.matchAll(/<(?:\w+:)?docZip\s([^>]*)>([^<]*)<\/(?:\w+:)?docZip>/g)) {
    const nsu = /NSU="(\d+)"/.exec(m[1]!)?.[1];
    const schema = /schema="([^"]+)"/.exec(m[1]!)?.[1];
    if (nsu && schema) docs.push({ nsu, schema, content: m[2]!.trim() });
  }
  return { cStat: xmlText(ret, 'cStat'), xMotivo: xmlText(ret, 'xMotivo'), ultNSU: xmlText(ret, 'ultNSU'), maxNSU: xmlText(ret, 'maxNSU'), docs };
}

/** Pedido de distribuição por NSU (SOAP 1.2). */
export function distRequestXml(o: { production: boolean; uf: number; document: string; lastNsu: string }) {
  const doc = docKey(o.document);
  const tag = doc.length === 11 ? 'CPF' : 'CNPJ';
  const nsu = o.lastNsu.replace(/\D/g, '').padStart(15, '0').slice(-15);
  return '<?xml version="1.0" encoding="utf-8"?>'
    + '<soap12:Envelope xmlns:soap12="http://www.w3.org/2003/05/soap-envelope"><soap12:Body>'
    + '<nfeDistDFeInteresse xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe"><nfeDadosMsg>'
    + `<distDFeInt xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.01"><tpAmb>${o.production ? 1 : 2}</tpAmb><cUFAutor>${o.uf}</cUFAutor>`
    + `<${tag}>${doc}</${tag}><distNSU><ultNSU>${nsu}</ultNSU></distNSU></distDFeInt>`
    + '</nfeDadosMsg></nfeDistDFeInteresse></soap12:Body></soap12:Envelope>';
}

/** 137 = nada novo; 138 = documentos encontrados; 656 = consumo indevido (bloqueio temporário). */
export const DIST_NONE = '137';
export const DIST_FOUND = '138';
export const DIST_BLOCKED = '656';

// ------------------------------------------------------------------ configuração e telas
export const fiscalSettingsSchema = z.object({
  /** Consulta automática diária ligada. */
  enabled: z.boolean(),
  queryHour: z.number().int().min(0).max(23).default(FISCAL_DEFAULT_HOUR),
  /** Só entram na lista as notas emitidas a partir deste dia (as anteriores ficam guardadas, fora da lista). null = todas. */
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inválida').nullable().default(null),
  uf: z.string().refine((v) => v in UF_CODES, 'Escolha o estado (UF)'),
  categoryId: z.string().uuid().nullable().default(null),
  folderId: z.string().uuid().nullable().default(null),
});
export type FiscalSettingsInput = z.input<typeof fiscalSettingsSchema>;

export const fiscalLaunchSchema = z.object({
  description: z.string().trim().min(1, 'Informe a descrição').max(255),
  categoryId: z.string().uuid('Escolha a categoria'),
  folderId: z.string().uuid().nullish(),
  relatedPerson: z.string().trim().max(128).nullish(),
  notes: z.string().trim().max(2000).nullish(),
  installments: z.array(z.object({
    dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Informe o vencimento de cada parcela'),
    amount: z.union([z.string(), z.number()]),
  })).min(1, 'Informe ao menos uma parcela').max(120),
});
export type FiscalLaunchInput = z.input<typeof fiscalLaunchSchema>;

export interface FiscalCertificateInfo {
  subject: string;
  document: string | null;
  notBefore: string;
  notAfter: string;
  fingerprint: string;
  uploadedAt: string | null;
  uploadedByName: string | null;
}

export interface FiscalConfigView {
  enabled: boolean;
  queryHour: number;
  startDate: string | null;
  uf: string | null;
  categoryId: string | null;
  folderId: string | null;
  certificate: FiscalCertificateInfo | null;
  lastQueryAt: string | null;
  lastStatus: string | null;
  lastMessage: string | null;
  /** Consulta automática desligada sozinha (ex.: a SEFAZ respondeu consumo indevido). */
  pausedAt: string | null;
  pausedReason: string | null;
  /** Antes disso, nem o botão "Consultar agora" consulta (regra da SEFAZ + folga). */
  nextAllowedAt: string | null;
  lastNsu: string;
  newCount: number;
  /** Notas já recebidas (a lista continua visível mesmo sem certificado). */
  docCount: number;
  /** Notas emitidas antes de `startDate` (guardadas, fora da lista). */
  olderCount: number;
}

export interface FiscalDocumentRow {
  id: string;
  key: string;
  kind: FiscalDocKind;
  status: FiscalDocStatus;
  situation: FiscalSituation;
  /** recipient = a nota é para este espaço; other = o espaço aparece por outro motivo (transporte, autorizado…). */
  role: 'recipient' | 'other';
  number: string | null;
  series: string | null;
  issuedAt: string | null;
  emitterDocument: string | null;
  emitterName: string | null;
  total: string | null;
  duplicates: NfeDuplicate[];
  paymentKinds: string[];
  nature: string | null;
  billIds: string[];
  handledByName: string | null;
  handledAt: string | null;
  receivedAt: string;
}

export const NFE_PAYMENT_LABELS: Record<string, string> = {
  '01': 'Dinheiro', '02': 'Cheque', '03': 'Cartão de crédito', '04': 'Cartão de débito', '05': 'Crédito loja',
  '10': 'Vale alimentação', '11': 'Vale refeição', '12': 'Vale presente', '13': 'Vale combustível', '14': 'Duplicata mercantil',
  '15': 'Boleto', '16': 'Depósito', '17': 'PIX', '18': 'Transferência', '19': 'Fidelidade', '90': 'Sem pagamento', '99': 'Outros',
};

/** Descrição sugerida da conta: "Fornecedor — NF 123". */
export function nfeBillDescription(d: { emitterName: string | null; number: string | null }) {
  const name = (d.emitterName ?? 'Fornecedor').replace(/\s+/g, ' ').trim().slice(0, 200);
  return d.number ? `${name} — NF ${d.number}` : name;
}
