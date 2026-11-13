import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Building2, Check, FileBadge, ImageUp, KeyRound, Lock, MapPin, MessageCircle, Phone, Plus, Trash2, AppWindow } from 'lucide-react';
import { BR_STATES, ORG_LOGO_MAX_BYTES, PDF_RULE_SOURCES, PDF_RULE_SOURCE_LABEL, describePdfRule, documentError, formatDocument, formatPhoneBR, formatZipBR, whatsappLink, type PdfRulePart, type PdfRuleSource } from '@nopaper/shared';
import { Button, Card, Field, IconButton, Segmented, Select, Input, Switch } from '@/components/ui/base';
import { DocumentField } from '@/components/ui/document-input';
import { get, put, errMsg } from '@/lib/api';
import { OrgAvatar } from '@/components/ui/org-avatar';
import { useConfirm, useFormState } from '@/components/ui/dialog';
import { useCan, useOrg, useSession } from '@/lib/session';
import { cn } from '@/lib/utils';

const DETAILS = ['stateRegistration', 'cityRegistration', 'phone', 'whatsapp', 'email', 'website', 'zipCode', 'street', 'streetNumber', 'complement', 'district', 'city', 'state'] as const;
type Detail = (typeof DETAILS)[number];
type Org = { id: string; name: string; legalName: string | null; kind: 'personal' | 'company'; document: string | null; timezone: string; logo: string | null; embedVisible?: boolean; isPrivate?: boolean } & Record<Detail, string | null>;

/**
 * Os 4 fusos oficiais do Brasil (sem horário de verão desde 2019). Cada um é gravado com uma zona
 * IANA de referência; as outras zonas brasileiras do mesmo fuso (`same`) caem nele ao abrir a tela.
 */
const BR_ZONES: Array<{ zone: string; utc: string; name: string; where: string; same: string[] }> = [
  { zone: 'America/Sao_Paulo', utc: 'UTC−3', name: 'Brasília', where: 'DF, Sul, Sudeste, Nordeste, GO, TO, PA e AP',
    same: ['America/Bahia', 'America/Fortaleza', 'America/Recife', 'America/Maceio', 'America/Belem', 'America/Araguaina', 'America/Santarem'] },
  { zone: 'America/Manaus', utc: 'UTC−4', name: 'Amazonas', where: 'AM (quase todo), MT, MS, RO e RR',
    same: ['America/Cuiaba', 'America/Campo_Grande', 'America/Porto_Velho', 'America/Boa_Vista'] },
  { zone: 'America/Rio_Branco', utc: 'UTC−5', name: 'Acre', where: 'AC e o sudoeste do AM', same: ['America/Eirunepe'] },
  { zone: 'America/Noronha', utc: 'UTC−2', name: 'Fernando de Noronha', where: 'Fernando de Noronha e ilhas oceânicas', same: [] },
];
/** Zona de referência do fuso (ou a própria, se for de fora do Brasil). */
const canonicalZone = (tz: string) => BR_ZONES.find((z) => z.zone === tz || z.same.includes(tz))?.zone ?? tz;
/** "08:25 de sexta, 13/11" no fuso dado. */
function nowIn(tz: string): string | null {
  try {
    const p = Object.fromEntries(new Intl.DateTimeFormat('pt-BR', { timeZone: tz, hour: '2-digit', minute: '2-digit', weekday: 'long', day: '2-digit', month: '2-digit' }).formatToParts(new Date()).map((x) => [x.type, x.value]));
    return `${p.hour}:${p.minute} de ${p.weekday}, ${p.day}/${p.month}`;
  } catch { return null; }
}

/**
 * Reduz a imagem escolhida para caber no menu (até 256 px no maior lado, PNG com transparência) e
 * devolve como data URL. Tenta tamanhos menores se o arquivo ainda ficar pesado.
 */
async function shrinkLogo(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    await new Promise<void>((ok, fail) => { img.onload = () => ok(); img.onerror = () => fail(new Error('Não consegui abrir essa imagem. Use PNG, JPG, WebP ou SVG.')); img.src = url; });
    const w = img.naturalWidth || 512, h = img.naturalHeight || 512;
    for (const max of [256, 192, 128, 96]) {
      const k = Math.min(1, max / Math.max(w, h));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
      const ctx = c.getContext('2d')!;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, c.width, c.height);
      const data = c.toDataURL('image/png');
      if ((data.length - data.indexOf(',') - 1) * 0.75 <= ORG_LOGO_MAX_BYTES) return data;
    }
    throw new Error('A imagem tem detalhes demais para virar logo. Tente uma versão mais simples.');
  } finally { URL.revokeObjectURL(url); }
}

function LogoField({ org, canEdit, onChange }: { org: Org; canEdit: boolean; onChange: (logo: string | null) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const send = async (logo: string | null) => {
    setBusy(true);
    try {
      const r = await put<{ logo: string | null }>('/api/org/logo', { logo });
      onChange(r.logo);
      toast.success(r.logo ? 'Logo atualizada' : 'Logo removida');
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };
  const pick = async (file: File | undefined | null) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) { toast.error('Escolha um arquivo de imagem (PNG, JPG, WebP ou SVG).'); return; }
    try { await send(await shrinkLogo(file)); } catch (e) { toast.error(e instanceof Error ? e.message : 'Não consegui usar essa imagem.'); }
  };
  return (
    <div className="flex items-center gap-4">
      <button type="button" disabled={!canEdit || busy} onClick={() => input.current?.click()} aria-label={org.logo ? 'Trocar a logo' : 'Enviar uma logo'}
        onDragOver={(e) => { if (canEdit) { e.preventDefault(); setOver(true); } }} onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); if (canEdit) void pick(e.dataTransfer.files[0]); }}
        className={cn('group relative shrink-0 rounded-2xl outline-none transition focus-visible:ring-3 focus-visible:ring-accent/30 disabled:cursor-default', over && 'ring-3 ring-accent/40', busy && 'opacity-60')}>
        <OrgAvatar name={org.name} logo={org.logo} className="size-24 rounded-2xl text-4xl" />
        {canEdit && <span className="absolute inset-0 grid place-items-center rounded-2xl bg-black/45 text-white opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"><ImageUp className="size-6" /></span>}
      </button>
      <div className="min-w-0">
        <p className="text-[13px] font-medium text-muted">Logo do espaço</p>
        <p className="mt-0.5 text-xs leading-relaxed text-faint">Aparece no menu, no lugar da inicial. PNG, JPG, WebP ou SVG; de preferência quadrada.</p>
        {canEdit && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Button size="sm" loading={busy} icon={<ImageUp className="size-4" />} onClick={() => input.current?.click()}>{org.logo ? 'Trocar' : 'Enviar imagem'}</Button>
            {org.logo && <Button size="sm" variant="ghost" className="text-danger hover:text-danger" disabled={busy} icon={<Trash2 className="size-4" />} onClick={() => send(null)}>Remover</Button>}
          </div>
        )}
        <input ref={input} type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" className="hidden" onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = ''; }} />
      </div>
    </div>
  );
}

interface PdfRule { id?: string; name: string; source: PdfRuleSource; part: PdfRulePart; length: number; value: string; hasValue?: boolean; preview?: string | null }
const NEW_RULE: PdfRule = { name: '', source: 'org_document', part: 'first', length: 4, value: '' };

/**
 * Regras de senha de PDF: faturas que chegam protegidas (Copel: 4 primeiros dígitos do CPF/CNPJ)
 * são abertas sozinhas ao anexar. Cada mudança grava na hora; o valor guardado (outro CPF/CNPJ ou
 * senha fixa) nunca volta para a tela.
 */
function PdfPasswordsCard({ canEdit }: { canEdit: boolean }) {
  const orgId = useSession((s) => s.orgId);
  const q = useQuery({ queryKey: ['pdf-passwords', orgId], enabled: canEdit, queryFn: () => get<{ orgHasDocument: boolean; rules: PdfRule[] }>('/api/org/pdf-passwords') });
  const [rules, setRules] = useState<PdfRule[]>([]);
  const [draft, setDraft] = useState<PdfRule | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (q.data) setRules(q.data.rules.map((r) => ({ ...r, value: '' }))); }, [q.data]);
  if (!canEdit) return null;
  const save = async (next: PdfRule[], msg: string) => {
    setBusy(true);
    try {
      const r = await put<{ rules: PdfRule[] }>('/api/org/pdf-passwords', { rules: next.map(({ id, name, source, part, length, value }) => ({ id, name, source, part, length, value })) });
      setRules(r.rules.map((x) => ({ ...x, value: '' }))); setDraft(null); toast.success(msg);
      return true;
    } catch (e) { toast.error(errMsg(e)); return false; } finally { setBusy(false); }
  };
  const d = draft;
  const draftOk = !!d && d.name.trim().length > 0 && (d.source === 'org_document' || d.value.trim().length > 0);
  return (
    <Card className="p-5 xl:col-span-2">
      <div className="flex flex-wrap items-start gap-3">
        <div className="mr-auto min-w-0">
          <h2 className="flex items-center gap-2 font-display text-lg font-semibold"><span className="grid size-7 place-items-center rounded-lg bg-accent-soft text-accent"><KeyRound className="size-4" /></span>Senhas de PDF</h2>
          <p className="mt-1 max-w-3xl text-sm text-muted">Faturas que chegam em PDF protegido (a Copel usa os 4 primeiros dígitos do CPF/CNPJ) são abertas sozinhas ao anexar: o NoPaper tenta cada regra, lê o documento e guarda a cópia sem senha.</p>
        </div>
        {!d && <Button size="sm" icon={<Plus className="size-4" />} disabled={rules.length >= 30} onClick={() => setDraft({ ...NEW_RULE })}>Nova regra</Button>}
      </div>
      {q.data && !q.data.orgHasDocument && rules.some((r) => r.source === 'org_document') && (
        <p className="mt-3 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-sm">Preencha o CPF/CNPJ do espaço acima: sem ele, as regras que usam esse documento não produzem senha.</p>
      )}
      {rules.length > 0 && (
        <ul className="mt-4 flex flex-wrap gap-2">
          {rules.map((r) => (
            <li key={r.id} className="flex min-w-0 max-w-full items-center gap-2.5 rounded-xl border border-line bg-surface-2/50 py-1.5 pl-3 pr-1.5">
              <KeyRound className="size-4 shrink-0 text-accent" />
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">{r.name}</span>
                <span className="block text-xs text-muted sm:truncate">{describePdfRule(r)}{r.preview ? <> → <b className="font-mono font-medium text-ink">{r.preview}</b></> : r.source !== 'org_document' && <span className="text-faint"> · guardado cifrado</span>}</span>
              </span>
              <IconButton label={`Apagar a regra ${r.name}`} tone="danger" disabled={busy} onClick={() => save(rules.filter((x) => x.id !== r.id), 'Regra apagada')}><Trash2 className="size-4" /></IconButton>
            </li>
          ))}
        </ul>
      )}
      {!rules.length && !d && <p className="mt-4 text-sm text-faint">Nenhuma regra ainda. Sem regras, um PDF com senha é anexado como veio e pede a senha toda vez que for aberto.</p>}
      {d && (
        <div className="mt-4 rounded-xl border border-accent/40 bg-accent-soft/30 p-4">
          {/* tudo numa linha só, cada campo do tamanho do que vai nele; no celular empilha */}
          <div className="flex flex-wrap items-end gap-x-3 gap-y-3.5">
            <Field label="Nome da regra" required className="w-full sm:w-40"><Input autoFocus maxLength={60} value={d.name} placeholder="Ex.: Copel" onChange={(e) => setDraft({ ...d, name: e.target.value })} /></Field>
            <Field label="A senha vem de" className="w-full sm:w-48">
              <Select value={d.source} onChange={(e) => setDraft({ ...d, source: e.target.value as PdfRuleSource, value: '' })}>
                {PDF_RULE_SOURCES.map((s) => <option key={s} value={s}>{PDF_RULE_SOURCE_LABEL[s]}</option>)}
              </Select>
            </Field>
            {d.source === 'other_document' && <Field label="CPF/CNPJ" required className="w-full sm:w-44"><Input inputMode="numeric" autoComplete="off" maxLength={18} className="tnum" placeholder="Só os números" value={d.value} onChange={(e) => setDraft({ ...d, value: formatDocument(e.target.value) })} /></Field>}
            {d.source === 'fixed' && <Field label="Senha" required className="w-full sm:w-44"><Input autoComplete="off" maxLength={64} value={d.value} onChange={(e) => setDraft({ ...d, value: e.target.value })} /></Field>}
            {d.source !== 'fixed' && <>
              <Field label="Parte" className="w-[calc(50%-6px)] sm:w-[7.5rem]">
                <Select value={d.part} onChange={(e) => setDraft({ ...d, part: e.target.value as PdfRulePart })}>
                  <option value="first">Primeiros</option><option value="last">Últimos</option><option value="all">Todos</option>
                </Select>
              </Field>
              {d.part !== 'all' && (
                <Field label="Dígitos" className="w-[calc(50%-6px)] sm:w-20">
                  <Select value={d.length} onChange={(e) => setDraft({ ...d, length: Number(e.target.value) })}>
                    {Array.from({ length: 14 }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n}</option>)}
                  </Select>
                </Field>
              )}
            </>}
            <div className="flex w-full justify-end gap-2 sm:ml-auto sm:w-auto">
              <Button variant="ghost" disabled={busy} onClick={() => setDraft(null)}>Cancelar</Button>
              <Button variant="primary" loading={busy} disabled={!draftOk} onClick={() => save([...rules, d], 'Regra criada')}>Criar regra</Button>
            </div>
          </div>
          <p className="mt-3 text-xs text-muted">
            A senha será <b className="font-medium text-ink">{describePdfRule(d)}</b>
            {d.source === 'org_document' && q.data?.orgHasDocument === false ? ' (preencha o CPF/CNPJ do espaço).' : '.'}
            {d.source === 'other_document' && ' Use para conta em nome de outra pessoa; o documento fica guardado cifrado.'}
            {d.source === 'fixed' && ' Fica guardada cifrada e não aparece mais na tela.'}
          </p>
        </div>
      )}
    </Card>
  );
}

type Form = Pick<Org, 'name' | 'kind' | 'timezone'> & { legalName: string; document: string } & Record<Detail, string>;
const toForm = (o: Org): Form => ({
  name: o.name, kind: o.kind, timezone: canonicalZone(o.timezone), legalName: o.legalName ?? '', document: o.document ?? '',
  ...(Object.fromEntries(DETAILS.map((k) => [k, o[k] ?? ''])) as Record<Detail, string>),
});
const BLANK: Form = toForm({ id: '', name: '', kind: 'company', timezone: 'America/Sao_Paulo', legalName: null, document: null, logo: null, ...(Object.fromEntries(DETAILS.map((k) => [k, null])) as Record<Detail, null>) });

/**
 * Só em instalações que aceitam ser exibidas dentro de outro sistema: escolhe se ESTE espaço aparece
 * lá. Grava na hora. É um filtro do que aparece no modo embutido, não uma permissão: quem é membro
 * continua vendo o espaço ao abrir o NoPaper direto.
 */
function EmbedCard({ org, canEdit, onChange }: { org: Org; canEdit: boolean; onChange: (v: boolean) => void }) {
  const enabled = useSession((s) => s.embedEnabled);
  const [busy, setBusy] = useState(false);
  if (!enabled) return null;
  const toggle = async (visible: boolean) => {
    setBusy(true);
    try {
      const r = await put<{ embedVisible: boolean }>('/api/org/embed', { visible });
      onChange(r.embedVisible);
      toast.success(r.embedVisible ? 'Espaço habilitado na exibição integrada' : 'Espaço desabilitado na exibição integrada');
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <Card className="p-5 xl:col-span-2">
      <h2 className="flex items-center gap-2 font-display text-lg font-semibold"><span className="grid size-7 place-items-center rounded-lg bg-accent-soft text-accent"><AppWindow className="size-4" /></span>Exibição integrada</h2>
      <p className="mt-1 max-w-3xl text-sm text-muted">Esta instalação pode ser incorporada a outro sistema da organização. Na exibição integrada, só os espaços habilitados ficam disponíveis.</p>
      <div className="mt-4 rounded-xl border border-line bg-surface-2/50 px-4 py-3">
        <Switch checked={!!org.embedVisible} disabled={!canEdit || busy} onChange={toggle} label="Habilitar este espaço na exibição integrada"
          hint={org.embedVisible ? 'Habilitado: os membros acessam este espaço pelo outro sistema, cada um com as próprias permissões.' : 'Desabilitado: este espaço só fica disponível no acesso direto ao NoPaper.'} />
      </div>
    </Card>
  );
}

/**
 * Espaço privado: tira o espaço do alcance da Plataforma (membros, senha de quem participa, nome nas
 * listas). Só o dono liga e desliga; grava na hora. O que NÃO protege (backup, servidor) fica escrito
 * no próprio cartão.
 */
function PrivateCard({ org, onChange }: { org: Org; onChange: (v: boolean) => void }) {
  const isOwner = !!useOrg()?.isOwner;
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const on = !!org.isPrivate;
  const toggle = async (next: boolean) => {
    if (next && !(await confirm({
      title: `Tornar “${org.name}” privado?`, confirmLabel: 'Tornar privado',
      body: 'Os administradores da plataforma deixam de ver este espaço e de mexer em quem participa dele. Quem participa passa a depender da própria senha: ela não poderá mais ser redefinida pela plataforma.',
    }))) return;
    setBusy(true);
    try {
      const r = await put<{ isPrivate: boolean }>('/api/org/private', { private: next });
      onChange(r.isPrivate);
      toast.success(r.isPrivate ? 'Este espaço agora é privado' : 'Este espaço deixou de ser privado');
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <Card className="p-5 xl:col-span-2">
      <h2 className="flex items-center gap-2 font-display text-lg font-semibold"><span className="grid size-7 place-items-center rounded-lg bg-accent-soft text-accent"><Lock className="size-4" /></span>Espaço privado</h2>
      <p className="mt-1 max-w-3xl text-sm text-muted">Deixa este espaço fora do alcance da administração da plataforma: só quem administra o espaço decide quem participa.</p>
      <div className="mt-4 rounded-xl border border-line bg-surface-2/50 px-4 py-3">
        <Switch checked={on} disabled={!isOwner || busy} onChange={toggle} label="Tornar este espaço privado"
          hint={on ? 'Privado: os administradores da plataforma não veem este espaço, não incluem nem tiram membros e não definem senha para quem participa dele.'
            : 'Aberto: um administrador da plataforma consegue se incluir neste espaço, ou incluir outras pessoas.'} />
      </div>
      {!isOwner && <p className="mt-2 text-xs text-faint">Só o dono do espaço pode mudar isto.</p>}
      <ul className="mt-3 flex max-w-3xl list-disc flex-col gap-1 pl-5 text-xs leading-relaxed text-muted">
        <li>Quem já é membro continua sendo: confira a lista em Membros.</li>
        <li>Quem participa de um espaço privado troca a própria senha em Meu perfil. Se esquecer a senha, só quem tem acesso ao servidor consegue redefinir.</li>
        <li>O backup da instalação continua levando os dados de todos os espaços, inclusive os privados. Quem baixa o arquivo de backup ou acessa o servidor alcança esses dados.</li>
      </ul>
    </Card>
  );
}

/** Cartão de uma parte do cadastro: título com ícone e os campos numa grade de 12 colunas. */
function Section({ icon, title, hint, children, top }: { icon: React.ReactNode; title: string; hint?: string; children: React.ReactNode; top?: React.ReactNode }) {
  return (
    <Card className="flex flex-col p-5">
      <h2 className="flex items-center gap-2 font-display text-lg font-semibold"><span className="grid size-7 place-items-center rounded-lg bg-accent-soft text-accent">{icon}</span>{title}</h2>
      {hint && <p className="mt-1 text-sm text-muted">{hint}</p>}
      {top && <div className="mt-4">{top}</div>}
      <div className="mt-4 grid grid-cols-2 content-start gap-x-3 gap-y-4 sm:grid-cols-12">{children}</div>
    </Card>
  );
}

export function OrgPage() {
  const qc = useQueryClient();
  const orgId = useSession((s) => s.orgId);
  const canEdit = useCan()('org.settings');
  const q = useQuery({ queryKey: ['org', orgId], queryFn: () => get<{ org: Org }>('/api/org').then((r) => r.org) });
  const [org, setOrg] = useState<Org | null>(null);
  const [f, setF, form] = useFormState<Form>(BLANK);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (q.data) { setOrg(q.data); form.load(toForm(q.data)); } }, [q.data, form.load]); // eslint-disable-line react-hooks/exhaustive-deps
  // relógio do fuso escolhido: confere na hora se é o certo (atualiza a cada meio minuto)
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 30_000); return () => clearInterval(t); }, []);
  if (!org) return null;
  const company = f.kind === 'company';
  const docErr = documentError(f.document);
  const zone = BR_ZONES.find((z) => z.zone === f.timezone);
  const set = <K extends keyof Form>(k: K) => (v: Form[K]) => setF((p) => ({ ...p, [k]: v }));
  const text = (k: Detail | 'name' | 'legalName', max: number, extra?: React.InputHTMLAttributes<HTMLInputElement>) =>
    <Input maxLength={max} value={f[k]} onChange={(e) => set(k)(e.target.value)} {...extra} />;
  const phone = (k: 'phone' | 'whatsapp', className?: string) =>
    <Input type="tel" inputMode="tel" autoComplete="off" maxLength={32} className={cn('tnum', className)} value={f[k]}
      onChange={(e) => set(k)(e.target.value)} onBlur={() => setF((p) => ({ ...p, [k]: p[k] ? formatPhoneBR(p[k]) : '' }))} />;
  /** Espelha no menu (nome, perfil, logo) sem esperar a sessão renovar. */
  const patchSession = (patch: { name?: string; kind?: Org['kind']; logo?: string | null; embedVisible?: boolean }) => {
    const s = useSession.getState();
    useSession.setState({ orgs: s.orgs.map((o) => (o.id === org.id ? { ...o, ...patch } : o)) });
  };
  const save = async () => {
    setBusy(true);
    try {
      // dados de empresa só vão no perfil Empresa; no Pessoal ficam como estão no banco
      const details = company ? Object.fromEntries(DETAILS.map((k) => [k, f[k]])) : {};
      const r = await put<{ org: Org }>('/api/org', { name: f.name, legalName: company ? f.legalName : null, kind: f.kind, document: f.document, timezone: f.timezone, ...details });
      setOrg(r.org); form.load(toForm(r.org));
      qc.setQueryData(['org', orgId], r.org); // as impressões usam estes dados
      patchSession({ name: r.org.name, kind: r.org.kind });
      toast.success('Espaço atualizado');
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };
  const wa = whatsappLink(f.whatsapp);
  return (
    <fieldset disabled={!canEdit} className="flex min-w-0 flex-col gap-4">
      <div className="grid gap-4 xl:grid-cols-2">
        <Section icon={<Building2 className="size-4" />} title="Dados do espaço" hint="Como este espaço se chama e aparece no NoPaper."
          top={<LogoField org={{ ...org, name: f.name || org.name }} canEdit={canEdit} onChange={(logo) => { setOrg({ ...org, logo }); patchSession({ logo }); }} />}>
          <Field label={company ? 'Nome fantasia' : 'Nome'} required className="col-span-2 sm:col-span-7" hint={company ? 'Como a empresa aparece no sistema.' : undefined}>{text('name', 120)}</Field>
          <Field label="Perfil" className="col-span-2 sm:col-span-5">
            <Segmented value={f.kind} onChange={set('kind')} options={[{ value: 'personal', label: 'Pessoal' }, { value: 'company', label: 'Empresa' }]} />
          </Field>
          <p className="col-span-full -mt-2 text-xs leading-relaxed text-faint">
            {company ? 'Empresa: Contas a pagar e a receber, folha de pagamento e os dados cadastrais abaixo.' : 'Pessoal: Despesas e Receitas, sem folha de pagamento.'}
          </p>
          {company && (
            <Field label="Razão social" className="col-span-2 sm:col-span-12" hint="Nome oficial da empresa (o do CNPJ). Vai no termo de aceite e no comprovante de assinatura dos holerites.">
              {text('legalName', 160, { placeholder: 'Ex.: Exemplo e Exemplo LTDA' })}
            </Field>
          )}
        </Section>

        <Section icon={<FileBadge className="size-4" />} title={company ? 'Documentos e fuso horário' : 'Documento e fuso horário'}>
          <DocumentField label={company ? 'CNPJ (ou CPF)' : 'CPF (ou CNPJ, se MEI)'} className="col-span-2 sm:col-span-6" placeholder={company ? '00.000.000/0000-00' : '000.000.000-00'} value={f.document} onChange={set('document')} />
          <Field label="Fuso horário" className="col-span-2 sm:col-span-6"
            hint={<>Agora: <b className="font-medium text-muted tnum">{nowIn(f.timezone) ?? '—'}</b> — é o “hoje” dos vencimentos e alertas.</>}>
            <Select value={f.timezone} onChange={(e) => set('timezone')(e.target.value)} disabled={!canEdit}>
              {!zone && <option value={f.timezone}>{f.timezone}</option>}
              {BR_ZONES.map((z) => <option key={z.zone} value={z.zone}>{z.name} ({z.utc})</option>)}
            </Select>
          </Field>
          {company && <>
            <Field label="Inscrição estadual" className="sm:col-span-6">{text('stateRegistration', 32, { className: 'tnum', placeholder: 'Número ou “Isento”' })}</Field>
            <Field label="Inscrição municipal" className="sm:col-span-6">{text('cityRegistration', 32, { className: 'tnum', placeholder: 'Não informada' })}</Field>
          </>}
        </Section>

        {company && <>
          <Section icon={<Phone className="size-4" />} title="Contato">
            <Field label="Telefone" className="col-span-2 sm:col-span-6">{phone('phone')}</Field>
            <Field label="WhatsApp" className="col-span-2 sm:col-span-6">
              <div className="flex gap-2">
                {phone('whatsapp', 'min-w-0 flex-1')}
                {wa && <a href={wa} target="_blank" rel="noreferrer" aria-label="Abrir conversa no WhatsApp" title="Abrir conversa no WhatsApp" className="grid size-10 shrink-0 place-items-center rounded-lg border border-line text-ok hover:bg-ok/10 pointer-coarse:size-11"><MessageCircle className="size-4" /></a>}
              </div>
            </Field>
            <Field label="E-mail" className="col-span-2 sm:col-span-6">{text('email', 160, { type: 'email', inputMode: 'email', autoComplete: 'off' })}</Field>
            <Field label="Site" className="col-span-2 sm:col-span-6">{text('website', 160, { inputMode: 'url', autoComplete: 'off' })}</Field>
          </Section>

          <Section icon={<MapPin className="size-4" />} title="Endereço">
            <Field label="CEP" className="sm:col-span-4"><Input inputMode="numeric" autoComplete="off" maxLength={9} className="tnum" placeholder="00000-000" value={f.zipCode} onChange={(e) => set('zipCode')(formatZipBR(e.target.value))} /></Field>
            <Field label="Rua / avenida" className="col-span-2 sm:col-span-6">{text('street', 160)}</Field>
            <Field label="Número" className="max-sm:row-start-1 max-sm:col-start-2 sm:col-span-2">{text('streetNumber', 20, { className: 'tnum' })}</Field>
            <Field label="Complemento" className="sm:col-span-4">{text('complement', 80, { placeholder: 'Sala, loja…' })}</Field>
            <Field label="Bairro" className="sm:col-span-8">{text('district', 80)}</Field>
            <Field label="Cidade" className="sm:col-span-9">{text('city', 80)}</Field>
            <Field label="UF" className="sm:col-span-3">
              <Select value={f.state} onChange={(e) => set('state')(e.target.value)} disabled={!canEdit}>
                <option value="">—</option>
                {BR_STATES.map((uf) => <option key={uf} value={uf}>{uf}</option>)}
              </Select>
            </Field>
          </Section>
        </>}
      </div>

      {canEdit && (
        <Card className="flex items-center justify-end gap-3 px-5 py-3">
          <span className={cn('mr-auto inline-flex items-center gap-1.5 text-xs', form.dirty ? 'text-warn' : 'text-faint')} aria-live="polite">
            {form.dirty ? <><span className="size-1.5 rounded-full bg-warn" />Alterações não salvas</> : <><Check className="size-3.5" />Tudo salvo</>}
          </span>
          {form.dirty && <Button variant="ghost" disabled={busy} onClick={() => form.load(toForm(org))}>Desfazer</Button>}
          <Button variant="primary" loading={busy} disabled={!form.dirty || !!docErr || f.name.trim().length < 2} onClick={save}>Salvar</Button>
        </Card>
      )}
      <div className="grid gap-4 xl:grid-cols-2">
        <PdfPasswordsCard canEdit={canEdit} />
        <EmbedCard org={org} canEdit={canEdit} onChange={(embedVisible) => { setOrg({ ...org, embedVisible }); patchSession({ embedVisible }); }} />
        <PrivateCard org={org} onChange={(isPrivate) => setOrg({ ...org, isPrivate })} />
      </div>
    </fieldset>
  );
}
