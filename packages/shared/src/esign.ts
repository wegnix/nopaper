import { z } from 'zod';

/**
 * Assinatura eletrônica do holerite pelo funcionário (link pessoal + CPF + assinatura desenhada).
 * Base legal: CLT art. 464 (recibo de salário) e MP 2.200-2/2001, art. 10, §2º (assinatura
 * eletrônica aceita pelas partes) — por isso o termo de aceite, guardado uma vez por funcionário.
 */
export const ESIGN_TERM_VERSION = '1';

export interface EsignTermParties {
  /** Razão social da empresa (ou o nome do espaço, se não houver). */
  company: string;
  companyDocument: string | null;
  /** Inscrições, endereço e contato da empresa (Dados do espaço), para identificar a empresa no documento. */
  companyRegistrations?: string | null;
  companyAddress?: string | null;
  companyContact?: string | null;
  /** Logo da empresa (data URL de Dados do espaço), para o cabeçalho do documento. */
  companyLogo?: string | null;
  employeeName: string;
  employeeDocument: string;
}

/** Texto do termo de aceite (documento próprio, assinado uma vez por funcionário). Parágrafos. */
export const esignTermText = (p: EsignTermParties): string[] => [
  `Eu, ${p.employeeName}, CPF ${p.employeeDocument}, concordo em receber e assinar eletronicamente os meus recibos de pagamento de salário (holerites) da empresa ${p.company}${p.companyDocument ? `, CNPJ ${p.companyDocument}` : ''}, por meio do sistema NoPaper, no lugar do recibo impresso.`,
  'Reconheço que a assinatura feita no sistema — com a confirmação do meu CPF, o desenho da minha assinatura e o registro de data, hora e aparelho — tem a mesma validade da assinatura no recibo em papel, conforme o art. 10, § 2º, da Medida Provisória nº 2.200-2/2001.',
  'Sei que recebo uma via de cada holerite assinado, que posso baixar e guardar, e que a empresa guarda a outra via.',
  'Este termo vale para os próximos holerites, até eu pedir à empresa, por escrito, para voltar ao recibo em papel.',
];
export const ESIGN_TERM_TITLE = 'Termo de aceite de assinatura eletrônica de holerites';
/** Declaração confirmada ao assinar o termo. */
export const ESIGN_TERM_DECLARATION = 'Declaro que li e aceito este termo de assinatura eletrônica de holerites.';
/** Valor de `competence` das linhas de termo (não é um mês). */
export const ESIGN_TERM_COMPETENCE = 'TERMO';
export const ESIGN_KINDS = ['payslip', 'term'] as const;
export type EsignKind = (typeof ESIGN_KINDS)[number];

/** Declaração que o funcionário confirma em cada holerite. */
export const esignDeclaration = (competenceLabel: string, net: string) =>
  `Declaro que conferi este holerite de ${competenceLabel} e que recebi o valor líquido de ${net} nele indicado.`;

export const ESIGN_STATUSES = ['pending', 'signed'] as const;
export type EsignStatus = (typeof ESIGN_STATUSES)[number];

/** Tentativas erradas de CPF antes de travar o link por um tempo. */
export const ESIGN_MAX_ATTEMPTS = 5;
export const ESIGN_LOCK_MINUTES = 15;

export const esignOpenSchema = z.object({ cpf: z.string().trim().min(11, 'Informe o CPF').max(20) });
export const esignSubmitSchema = z.object({
  key: z.string().min(10).max(200),
  /** "Li e confirmo o recebimento". */
  confirm: z.literal(true, { message: 'Marque que você conferiu o holerite' }),
  /** Assinatura desenhada: PNG em data URL. */
  signature: z.string().startsWith('data:image/png;base64,', 'Desenhe a sua assinatura').max(600_000, 'Assinatura grande demais: limpe e desenhe de novo'),
});
export const esignSendAccountantSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(200),
  /** Com mais de um contador no espaço: o id de um deles, ou "all" (todos). */
  recipientId: z.string().uuid().or(z.literal('all')).nullish(),
});

/** Linha da lista de assinaturas do mês (tela da folha). */
export interface PayslipSignatureRow {
  id: string;
  kind: EsignKind;
  employeeId: string | null;
  employeeName: string;
  phone: string | null;
  competence: string;
  net: string;
  status: EsignStatus;
  createdAt: string;
  viewedAt: string | null;
  signedAt: string | null;
  sentToAccountantAt: string | null;
}

/** O que a página pública mostra antes do CPF (nada sensível). */
export interface EsignPublicInfo { kind: EsignKind; company: string; firstName: string; competence: string; status: EsignStatus }
/** Depois do CPF conferido. */
export interface EsignOpened {
  key: string;
  kind: EsignKind;
  company: string;
  employeeName: string;
  competence: string;
  net: string;
  totalEarnings: string;
  totalDeductions: string;
  items: Array<{ name: string; ref: string | null; kind: 'earning' | 'deduction'; amount: string }>;
  status: EsignStatus;
  signedAt: string | null;
  /** Holerite: o termo de aceite ainda não foi assinado (assina-se antes, em `termToken`). */
  termPending: boolean;
  termToken: string | null;
  /** Termo: o texto. */
  term: string[];
}
