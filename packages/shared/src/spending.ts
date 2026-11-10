import { z } from 'zod';
import { COLOR_KEYS, type ColorKey } from './colors.js';

/**
 * Categorias do cartão: próprias de cada espaço (nome e cor editáveis), separadas das categorias de contas a
 * pagar — a fatura inteira já entra em Contas a pagar com a categoria do cartão; estas detalham as compras.
 *
 * Todo espaço começa com `DEFAULT_CARD_CATEGORIES` (no estilo do "perfil de consumo" dos bancos). Cada uma
 * guarda a `ruleKey` da regra que a preenche sozinha (`classifySpending`, pelo nome da loja — o OFX não traz
 * o ramo/MCC). Renomear mantém a regra; categorias criadas pelo usuário só recebem compras pelo histórico
 * (a mesma loja vai para a categoria usada da última vez).
 */
export const DEFAULT_CARD_CATEGORIES = [
  { key: 'supermarket', label: 'Supermercado', color: 'green' },
  { key: 'food', label: 'Gastronomia e delivery', color: 'orange' },
  { key: 'fuel', label: 'Combustível', color: 'amber' },
  { key: 'transport', label: 'Veículos e transporte', color: 'navy' },
  { key: 'online', label: 'Compras online', color: 'yellow' },
  { key: 'subscriptions', label: 'Assinaturas e streaming', color: 'red' },
  { key: 'tech', label: 'Informática e software', color: 'cyan' },
  { key: 'health', label: 'Saúde e farmácia', color: 'emerald' },
  { key: 'beauty', label: 'Estética e cuidados pessoais', color: 'pink' },
  { key: 'clothing', label: 'Vestuário', color: 'fuchsia' },
  { key: 'home', label: 'Casa e lar', color: 'brown' },
  { key: 'construction', label: 'Construção e reforma', color: 'olive' },
  { key: 'leisure', label: 'Esportes, lazer e turismo', color: 'sky' },
  { key: 'education', label: 'Educação', color: 'indigo' },
  { key: 'insurance', label: 'Seguros', color: 'teal' },
  { key: 'fees', label: 'Tarifas, juros e IOF', color: 'wine' },
  { key: 'other', label: 'Diversos', color: 'slate' },
] as const satisfies ReadonlyArray<{ key: string; label: string; color: ColorKey }>;
export type SpendingType = (typeof DEFAULT_CARD_CATEGORIES)[number]['key'];
export const SPENDING_KEYS = DEFAULT_CARD_CATEGORIES.map((t) => t.key) as [SpendingType, ...SpendingType[]];

export const cardCategorySchema = z.object({
  label: z.string().trim().min(1, 'Informe o nome').max(64),
  color: z.enum(COLOR_KEYS).default('slate'),
});
export type CardCategoryInput = z.infer<typeof cardCategorySchema>;

/** Texto para as regras: maiúsculas, sem acento, só letras/números/"*"/espaço. */
const norm = (s: string) => ` ${s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9*&]+/g, ' ').trim()} `;

/** Regras na ordem: a primeira que casar vale (marketplace antes de "MERCADO", seguro antes de "AUTO"…). */
const RULES: Array<[SpendingType, RegExp]> = [
  ['fees', /\b(IOF|ANUIDADE|ENCARGO|JUROS|MULTA|TARIFA|SEGURO FATURA|AVAL EMERG)/],
  ['online', /\b(MERCADO ?LIVRE|MERCADOLIVRE|MERCADO ?PAGO|MERCADO\*|MP\*|AMAZON(?! ?(PRIME|WEB))|AMZN|SHOPEE|ALIEXPRESS|SHEIN|TEMU|MAGALU|MAGAZINE ?LUIZA|AMERICANAS|SUBMARINO|CASAS ?BAHIA|PONTO ?FRIO|CARREFOUR ?COM|PAG ?\*|PAGSEGURO|PICPAY|EBANX|HOTMART|KIWIFY|EDUZZ)/],
  ['insurance', /\b(SEGURO|SEGURADORA|SEGUR\*|ALLIANZ|TOKIO ?MARINE|PORTO ?SEGURO|SULAMERICA|MAPFRE|LIBERTY|HDI|AZUL ?SEG|YOUSE|ZURICH|ITAU ?SEG|BRADESCO ?SEG|CAIXA ?SEG)/],
  ['subscriptions', /\b(NETFLIX|SPOTIFY|DEEZER|DISNEY|HBO|MAX ?COM|PRIME ?VIDEO|AMAZON ?PRIME|GLOBOPLAY|BRASIL ?PARAL|PARAMOUNT|YOUTUBE|APPLE ?COM|APPLE\.COM|ITUNES|GOOGLE ?\*|GOOGLE ?PLAY|GOOGLE ?ONE|PLAYSTATION|XBOX|STEAM|NINTENDO|CRUNCHYROLL|TELECINE|STAR ?PLUS|DROPBOX|ICLOUD|CLARO|VIVO|TIM |OI )/],
  ['tech', /\b(ANTHROPIC|CLAUDE|OPENAI|CHATGPT|GITHUB|MICROSOFT|MSFT|ADOBE|CANVA|NOTION|AWS|AMAZON ?WEB|DIGITALOCEAN|HOSTINGER|HOSTGATOR|LOCAWEB|REGISTRO ?BR|GODADDY|CLOUDFLARE|KABUM|PICHAU|TERABYTE|DELL|LENOVO|SAMSUNG|INFORMATICA|ELETRONIC|ZOOM|SLACK|JETBRAINS)/],
  ['fuel', /\b(POSTO|AUTO ?POSTO|SHELL|IPIRANGA|PETROBRAS|BR ?MANIA|RAIZEN|ABASTEC|COMBUST|GASOLINA|ALE ?COMB|AM ?PM)/],
  ['transport', /\b(UBER|99 ?APP|99 ?POP|99\*|CABIFY|ESTACION|ESTAPAR|PARKING|PEDAGIO|SEM ?PARAR|CONECTCAR|VELOE|TAG ?PASS|MOVE ?MAIS|AUTO ?PECAS|AUTOPECAS|PNEU|OFICINA|MECANICA|LAVA ?JATO|LOCALIZA|MOVIDA|UNIDAS|DETRAN|METRO|ONIBUS|BILHETE|CLICKBUS|BUSER)/],
  ['food', /\b(IFOOD|RAPPI|AIQFOME|ZE ?DELIVERY|RESTAUR|GASTRONOM|LANCH|PIZZ|BURGER|BURGUER|MCDONALD|MC ?DONALD|BK ?BRASIL|SUBWAY|OUTBACK|MADERO|HABIB|SPOLETO|SUSHI|TEMAKI|CHURRASC|BAR |BOTEQUIM|CHOPP|CERVEJ|CAFE|CAFETERIA|STARBUCKS|PADARIA|PANIFIC|CONFEIT|DOCERIA|SORVET|ACAI|BISTRO|COZINHA|ESPETO|PASTEL|EMPORIO DO PAO)/],
  ['supermarket', /\b(SUPERMERC|SUPER ?MERCADO|HIPERMERC|MERCADO|MERCADOS|MERCEARIA|ATACAD|ASSAI|CARREFOUR|PAO ?DE ?ACUCAR|EXTRA |DIA ?BRASIL|SONDA|ZAFFARI|CONDOR|ANGELONI|MUFFATO|SAVEGNAGO|HORTIFRUTI|SACOLAO|QUITANDA|ACOUGUE|CASA ?DE ?CARNES|EMPORIO|OXXO|MINUTO ?PA)/],
  ['health', /\b(DROGA|FARMA|RAIA|PANVEL|PAGUE ?MENOS|NISSEI|PACHECO|HOSPITAL|CLINICA|LABORAT|ODONTO|DENTIST|MEDIC|SAUDE|UNIMED|AMIL|HAPVIDA|FLEURY|LAB |OTICA|PSICOL|FISIOTER|VETERIN|PET ?SHOP|PETZ|COBASI)/],
  ['beauty', /\b(SALAO|CABELEIR|BARBEAR|BARBER|ESTETIC|BOTICARIO|NATURA|SEPHORA|PERFUM|COSMET|DEPIL|MANICURE|SPA |BELEZA|AVON|EUDORA|QUEM ?DISSE)/],
  ['clothing', /\b(RENNER|RIACHUELO|C ?& ?A |CEA |ZARA|HERING|MARISA|PERNAMBUCANAS|CALCAD|SAPAT|MODA|CONFEC|NETSHOES|CENTAURO ?ROUPA|YOUCOM|MALWEE|AREZZO|SCHUTZ|NIKE|ADIDAS|DAFITI|VESTU|LINGERIE|UNIFORM)/],
  ['construction', /\b(LEROY|TELHA ?NORTE|C ?& ?C|CASA ?DO ?CONSTRUTOR|MAT(ERIAIS)? ?(DE )?CONSTR|CONSTRU|MADEIR|FERRAG|TINTAS|ELETRICA|HIDRAUL|VIDRACAR|MARMOR|CIMENT|SODIMAC|OBRAMAX|JUNTOS ?SOMOS)/],
  ['home', /\b(TOK ?STOK|ETNA|CAMICADO|MOBLY|MADEIRAMADEIRA|MOVEIS|COLCHO|ELETRO|UTILIDADES|DECORA|CAMA ?MESA|ZELO|HAVAN|CONDOMIN|ADM ?COND|ADMINISTRADORA|IMOBILIAR|ALUGUEL|LAVANDERIA|CHAVEIRO|JARDIN|FLORICULT|ENERGIA|SABESP|COPEL|ENEL|CEMIG|GAS ?NATURAL|COMGAS|ULTRAGAZ|ADM\b)/],
  ['leisure', /\b(HOTEL|POUSADA|RESORT|AIRBNB|BOOKING|DECOLAR|HURB|CVC|LATAM|GOL ?LINHAS|AZUL ?LINHAS|VOEAZUL|SMILES|CINEMA|CINEMARK|KINOPLEX|INGRESSO|SYMPLA|EVENTIM|TICKET|PARQUE|AGUAS ?QUENTES|TERMAS|THERMAS|CLUBE|ACADEMIA|SMART ?FIT|SMARTFIT|BLUEFIT|TOTALPASS|GYMPASS|WELLHUB|CENTAURO|DECATHLON|ESPORTE|TURISMO|VIAGE|PASSAGE|TEATRO|SHOW|MUSEU|ZOO)/],
  ['education', /\b(ESCOLA|COLEGIO|FACULD|UNIVERS|CURSO|IDIOMA|INGLES|UDEMY|ALURA|COURSERA|DUOLINGO|LIVRAR|SARAIVA|CULTURA|PAPELAR|KALUNGA|EDUCA|ENSINO|MENSALIDADE)/],
];

/** Tipo de estabelecimento pelo nome (regras); sem regra = Diversos. */
export function classifySpending(description: string): SpendingType {
  const t = norm(description);
  for (const [key, re] of RULES) if (re.test(t)) return key;
  return 'other';
}

