import { motion } from 'motion/react';
import { formatBRL } from '@nopaper/shared';

/**
 * Cenas do painel esquerdo do login: uma ilustração animada + frase. Cada acesso sorteia uma
 * (nunca repete a anterior). Valores são fictícios.
 */
export interface AuthScene { key: string; art: React.ReactNode; title: string; text: string }

const ease = [0.2, 0.8, 0.2, 1] as const;

// ------------------------------------------------------------------ 1. contas do mês (original)
const MONTH = [['Aluguel', '1800.00'], ['Energia', '190.00'], ['Internet', '120.00'], ['Escola', '1500.00'], ['Condomínio', '650.00']] as const;

function MonthReceipt() {
  return (
    <div className="relative w-[300px] select-none" aria-hidden>
      <motion.div
        initial={{ y: -40, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ duration: 0.6, ease }}
        className="perforated rounded-t-xl bg-[#fbfaf7] px-6 pt-6 pb-10 text-[#1b2030] shadow-[0_30px_60px_-30px_rgba(0,0,0,.6)]"
      >
        <p className="font-mono text-[11px] text-[#7b8194]">CONTAS DO MÊS</p>
        <div className="mt-4 flex flex-col gap-2.5 font-mono text-[13px]">
          {MONTH.map(([d, v], i) => (
            <motion.div key={d} className="flex justify-between gap-3" initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.35 + i * 0.09 }}>
              <span>{d}</span><span className="border-b border-dotted border-[#c6c9d2] flex-1 translate-y-[-4px]" /><span className="tnum">{formatBRL(v)}</span>
            </motion.div>
          ))}
        </div>
        <div className="mt-5 flex justify-between border-t border-dashed border-[#c6c9d2] pt-3 font-mono text-[13px] font-semibold">
          <span>TOTAL</span><span className="tnum">{formatBRL('4260.00')}</span>
        </div>
      </motion.div>
      <motion.div
        initial={{ scale: 2.2, opacity: 0, rotate: -24 }} animate={{ scale: 1, opacity: 1, rotate: -12 }}
        transition={{ delay: 1.05, type: 'spring', stiffness: 260, damping: 14 }}
        className="absolute right-2 top-24 rounded-lg border-[3px] border-[var(--np-accent)] px-3 py-1 font-display text-2xl font-bold text-[var(--np-accent)] mix-blend-multiply"
      >
        PAGO
      </motion.div>
    </div>
  );
}

// ------------------------------------------------------------------ 2. cupom térmico da fatura do cartão
const CARD = [['Mercado', '486.30', '1/1'], ['Farmácia', '92.40', '1/1'], ['Posto', '250.00', '1/1'], ['Notebook', '412.50', '3/10'], ['Streaming', '55.90', '1/1']] as const;
const BARS = [3, 1, 2, 1, 1, 3, 1, 2, 2, 1, 3, 1, 1, 2, 1, 3, 2, 1, 1, 2, 3, 1, 2, 1, 1, 3, 1, 2];

function CardSlip() {
  return (
    <div className="relative w-[270px] select-none" aria-hidden>
      {/* boca da "impressora" */}
      <div className="relative z-10 mx-[-14px] h-3 rounded-full bg-[#0b0820] shadow-[0_6px_14px_-4px_rgba(0,0,0,.8)]" />
      <motion.div
        initial={{ clipPath: 'inset(0 0 100% 0)' }} animate={{ clipPath: 'inset(0 0 0% 0)' }}
        transition={{ duration: 1.5, ease: 'linear' }}
        className="perforated -mt-1.5 bg-[#f3efe4] px-5 pt-5 pb-9 font-mono text-[12px] text-[#2a2620] shadow-[0_30px_60px_-30px_rgba(0,0,0,.6)] [background-image:repeating-linear-gradient(0deg,transparent_0_23px,rgba(0,0,0,.025)_23px_24px)]"
      >
        <p className="text-center text-[13px] font-bold tracking-[0.2em]">FATURA · CARTÃO</p>
        <p className="mt-0.5 text-center text-[10px] text-[#8a8373]">fecha dia 05 · vence dia 12</p>
        <div className="my-3 border-t border-dashed border-[#bdb5a3]" />
        <div className="flex flex-col gap-1.5">
          {CARD.map(([d, v, p]) => (
            <div key={d} className="flex items-baseline gap-2">
              <span className="flex-1 truncate">{d.toUpperCase()}</span>
              <span className="text-[10px] text-[#8a8373]">{p}</span>
              <span className="tnum w-[76px] text-right">{formatBRL(v)}</span>
            </div>
          ))}
        </div>
        <div className="my-3 border-t border-dashed border-[#bdb5a3]" />
        <div className="flex justify-between text-[13px] font-bold"><span>TOTAL</span><span className="tnum">{formatBRL('1297.10')}</span></div>
        <div className="mt-4 flex h-9 items-stretch justify-center gap-[2px]">
          {BARS.map((w, i) => <span key={i} className="bg-[#2a2620]" style={{ width: w }} />)}
        </div>
        <p className="mt-1 text-center text-[9px] tracking-[0.3em] text-[#8a8373]">34191 79001 01043 51004</p>
      </motion.div>
      <motion.div
        initial={{ y: -30, opacity: 0, rotate: 8 }} animate={{ y: 0, opacity: 1, rotate: 6 }}
        transition={{ delay: 1.6, type: 'spring', stiffness: 220, damping: 13 }}
        className="absolute -right-14 bottom-10 rounded-md bg-[var(--np-accent)] px-3 py-1.5 font-display text-[15px] font-semibold text-white shadow-[0_10px_30px_-10px_var(--np-accent)]"
      >
        Fatura fechada ✓
      </motion.div>
    </div>
  );
}

// ------------------------------------------------------------------ 3. fechamento da empresa (vidro escuro)
const COMPANY = [['Salários', '18400.00', 100, '#8b7dff'], ['Pró-Labore', '9000.00', 100, '#c4b5fd'], ['Impostos', '6230.75', 100, '#f472b6'], ['Fornecedores', '12780.00', 62, '#38bdf8'], ['Frota', '3150.00', 40, '#34d399']] as const;

function CompanyClose() {
  return (
    <div className="relative w-[320px] select-none" aria-hidden>
      <motion.div
        initial={{ y: 30, opacity: 0, rotateX: 18 }} animate={{ y: 0, opacity: 1, rotateX: 0 }} transition={{ duration: 0.7, ease }}
        style={{ transformPerspective: 900 }}
        className="rounded-2xl border border-white/15 bg-white/[.07] p-5 shadow-[0_30px_80px_-30px_rgba(0,0,0,.9)] backdrop-blur-md"
      >
        <div className="flex items-center justify-between">
          <p className="text-[11px] font-semibold tracking-[0.18em] text-white/60">FECHAMENTO · NOVEMBRO</p>
        </div>
        <div className="mt-4 flex flex-col gap-3">
          {COMPANY.map(([d, v, pct, c], i) => (
            <motion.div key={d} initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.4 + i * 0.1 }}>
              <div className="flex items-center gap-2 text-[13px]">
                <span className="size-2 rounded-full" style={{ background: c }} />
                <span className="flex-1 text-white/90">{d}</span>
                <span className="tnum text-white">{formatBRL(v)}</span>
              </div>
              <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-white/10">
                <motion.div className="h-full rounded-full" style={{ background: c }} initial={{ width: 0 }} animate={{ width: `${pct}%` }} transition={{ delay: 0.7 + i * 0.1, duration: 0.8, ease }} />
              </div>
            </motion.div>
          ))}
        </div>
        <div className="mt-5 flex items-end justify-between border-t border-white/10 pt-3">
          <div>
            <p className="text-[10px] text-white/50">pago no mês</p>
            <p className="font-display text-2xl font-semibold tnum">{formatBRL('42814.35')}</p>
          </div>
          <p className="text-right text-[11px] text-white/60">2 contas<br />a vencer</p>
        </div>
      </motion.div>
      <motion.div
        initial={{ scale: 0, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
        transition={{ delay: 1.5, type: 'spring', stiffness: 300, damping: 15 }}
        className="absolute -right-7 -top-7 grid size-16 place-items-center rounded-full bg-[var(--np-ok)] font-display text-[13px] font-bold leading-tight text-[#062a1c] shadow-[0_12px_30px_-10px_rgba(61,220,151,.7)]"
      >
        EM<br />DIA
      </motion.div>
    </div>
  );
}

export const AUTH_SCENES: AuthScene[] = [
  { key: 'mes', art: <MonthReceipt />, title: 'Suas contas em ordem, sem uma folha de papel.', text: 'Boletos, PIX, notas e comprovantes no mesmo lugar, com lembrete antes do vencimento.' },
  { key: 'cartao', art: <CardSlip />, title: 'A fatura do cartão se monta sozinha.', text: 'Cada compra entra na fatura certa, à vista ou parcelada, e vira uma conta a pagar no dia do vencimento.' },
  { key: 'empresa', art: <CompanyClose />, title: 'Da casa à empresa, cada conta no seu lugar.', text: 'Espaços separados, pessoas convidadas e permissões para cada uma: todo mundo vê só o que precisa.' },
];

const LAST_KEY = 'np:login-scene';
let chosen: AuthScene | null = null;

/**
 * Cena deste acesso: sorteada uma vez por carregamento da página (fora do React, para o StrictMode
 * não sortear duas vezes), sem repetir a do acesso anterior.
 */
export function useAuthScene(): AuthScene {
  if (!chosen) {
    let last: string | null = null;
    try { last = localStorage.getItem(LAST_KEY); } catch { /* modo privado */ }
    const pool = AUTH_SCENES.filter((s) => s.key !== last);
    chosen = pool[Math.floor(Math.random() * pool.length)];
    try { localStorage.setItem(LAST_KEY, chosen.key); } catch { /* ignore */ }
  }
  return chosen;
}
