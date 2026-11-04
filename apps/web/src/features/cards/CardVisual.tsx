import { CARD_BRAND_LABEL, CARD_COLOR_PRESETS, formatBRL, isCardColorKey, toCents, type CardBrand } from '@nopaper/shared';
import { CreditCard, Pencil, Wifi } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Card } from '@/lib/types';

/** Marca da bandeira desenhada em SVG (versões simplificadas, só para reconhecer o cartão). */
function BrandMark({ brand }: { brand: string }) {
  const label = CARD_BRAND_LABEL[(brand as CardBrand)] ?? brand;
  switch (brand) {
    case 'mastercard': return (
      <svg viewBox="0 0 40 24" className="h-6" role="img" aria-label={label}><circle cx="15" cy="12" r="10" fill="#eb001b" /><circle cx="25" cy="12" r="10" fill="#f79e1b" fillOpacity=".9" /></svg>
    );
    case 'visa': return (
      <svg viewBox="0 0 60 20" className="h-5" role="img" aria-label={label}>
        <text x="30" y="17" textAnchor="middle" fill="#fff" fontFamily="Arial, Helvetica, sans-serif" fontSize="20" fontWeight="900" fontStyle="italic" letterSpacing="-0.5">VISA</text>
      </svg>
    );
    case 'elo': return (
      <svg viewBox="0 0 56 24" className="h-6" role="img" aria-label={label}>
        <circle cx="10" cy="12" r="9.5" fill="#000" fillOpacity=".55" />
        <circle cx="10" cy="5.6" r="2.6" fill="#ffcb05" /><circle cx="4.6" cy="15.2" r="2.6" fill="#00a4e0" /><circle cx="15.4" cy="15.2" r="2.6" fill="#ef4123" />
        <text x="23" y="18" fill="#fff" fontFamily="Arial, Helvetica, sans-serif" fontSize="18" fontWeight="800">elo</text>
      </svg>
    );
    case 'amex': return (
      <svg viewBox="0 0 44 28" className="h-7" role="img" aria-label={label}>
        <rect width="44" height="28" rx="4" fill="#1f72cd" />
        <text x="22" y="12.5" textAnchor="middle" fill="#fff" fontFamily="Arial, Helvetica, sans-serif" fontSize="7.4" fontWeight="900" letterSpacing=".3">AMERICAN</text>
        <text x="22" y="21.5" textAnchor="middle" fill="#fff" fontFamily="Arial, Helvetica, sans-serif" fontSize="7.4" fontWeight="900" letterSpacing=".3">EXPRESS</text>
      </svg>
    );
    case 'hipercard': return (
      <svg viewBox="0 0 64 22" className="h-6" role="img" aria-label={label}>
        <rect width="64" height="22" rx="5" fill="#b3131b" />
        <text x="32" y="15.5" textAnchor="middle" fill="#fff" fontFamily="Arial, Helvetica, sans-serif" fontSize="12" fontWeight="800" fontStyle="italic">Hipercard</text>
      </svg>
    );
    default: return <CreditCard className="size-6 opacity-90" role="img" aria-label={label} />;
  }
}

/**
 * Cartão "físico" — gradiente da cor escolhida, número mascarado e uso do limite.
 * `editable`: o cartão selecionado mostra "Editar" ao passar o mouse (o clique nele abre a edição).
 */
export function CardVisual({ card, selected, editable, onClick }: { card: Card; selected?: boolean; editable?: boolean; onClick?: () => void }) {
  const p = CARD_COLOR_PRESETS[isCardColorKey(card.color) ? card.color : 'indigo'];
  const pct = card.limitAmount ? Math.min(100, (toCents(card.limitUsed) / Math.max(1, toCents(card.limitAmount))) * 100) : null;
  return (
    <button
      type="button" onClick={onClick} title={selected && editable ? 'Editar cartão' : undefined}
      className={cn(
        'group relative w-[300px] shrink-0 text-left transition-transform duration-300 focus-visible:outline-none',
        selected ? '-translate-y-1' : 'opacity-75 hover:opacity-100 hover:-translate-y-0.5',
        !card.active && 'grayscale',
      )}
    >
      <div
        className={cn('relative aspect-[1.586] overflow-hidden rounded-2xl p-5 text-white shadow-[0_20px_40px_-20px_rgba(0,0,0,.6)]', selected && 'ring-2 ring-accent ring-offset-2 ring-offset-bg')}
        style={{ background: `linear-gradient(135deg, ${p.dark} 0%, ${p.base} 55%, ${p.light} 140%)` }}
      >
        <div className="absolute -right-10 -top-16 size-48 rounded-full bg-white/10" />
        <div className="absolute -right-20 top-10 size-56 rounded-full bg-white/[.06]" />
        {selected && editable && (
          <span className="absolute inset-0 z-10 grid place-items-center bg-black/35 opacity-0 backdrop-blur-[1px] transition-opacity duration-200 group-hover:opacity-100 group-focus-visible:opacity-100">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-white/90 px-3 py-1.5 text-sm font-medium text-[#1b2030] shadow"><Pencil className="size-4" /> Editar cartão</span>
          </span>
        )}
        <div className="relative flex h-full flex-col justify-between">
          <div className="flex items-start justify-between">
            <span className="font-display text-lg font-semibold leading-tight drop-shadow">{card.name}</span>
            <Wifi className="size-5 rotate-90 opacity-70" />
          </div>
          <div className="flex items-center gap-3">
            <span className="h-7 w-10 rounded-md bg-gradient-to-br from-[#f6e27a] to-[#c9a227] opacity-90" />
            <span className="font-mono text-[15px] tracking-[0.18em] opacity-90">•••• {card.last4 ?? '••••'}</span>
          </div>
          <div className="flex items-end justify-between gap-3">
            {/* titular em destaque, como no cartão físico — distingue cartões iguais de pessoas diferentes */}
            <span className="min-w-0 leading-tight">
              {card.holder && <span className="block truncate text-[13px] font-semibold uppercase tracking-[0.08em] drop-shadow" title={card.holder}>{card.holder}</span>}
              <span className="block text-[11px] opacity-80">{card.holder ? `fecha dia ${card.closingDay} · vence dia ${card.dueDay}` : <>fecha dia {card.closingDay}<br />vence dia {card.dueDay}</>}</span>
            </span>
            <span className="shrink-0"><BrandMark brand={card.brand} /></span>
          </div>
        </div>
      </div>
      <div className="mt-3 px-1">
        <div className="flex justify-between text-xs"><span className="text-muted">Fatura atual</span><span className="tnum font-medium">{formatBRL(card.currentTotal)}</span></div>
        {pct !== null && (
          <>
            <div className="mt-2 h-1.5 rounded-full bg-surface-2 overflow-hidden"><div className={cn('h-full rounded-full transition-[width] duration-700', pct > 90 ? 'bg-danger' : pct > 70 ? 'bg-warn' : 'bg-accent')} style={{ width: `${pct}%` }} /></div>
            <p className="mt-1 text-[11px] text-faint tnum">{formatBRL(card.limitUsed)} de {formatBRL(card.limitAmount)} do limite</p>
          </>
        )}
      </div>
    </button>
  );
}
