export function Logo({ className = '', textClassName = '' }: { className?: string; textClassName?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <svg viewBox="0 0 32 32" className="size-7 shrink-0" aria-hidden>
        <rect width="32" height="32" rx="9" fill="var(--np-accent)" />
        <path d="M10 8h8.5l4.5 4.5V23a1 1 0 0 1-1 1H10a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z" fill="#fff" />
        <path d="M18.5 8v4.5H23" fill="none" stroke="var(--np-accent)" strokeWidth="1.5" />
        <path d="M12 17h8M12 20.5h5" stroke="var(--np-accent)" strokeWidth="1.8" strokeLinecap="round" />
        <path d="M7 25 25 7" stroke="var(--np-bg)" strokeWidth="2.6" strokeLinecap="round" />
      </svg>
      <span className={`font-display text-[19px] font-semibold tracking-tight whitespace-nowrap ${textClassName}`}>NoPaper</span>
    </span>
  );
}
