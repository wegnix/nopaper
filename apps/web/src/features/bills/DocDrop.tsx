import { PixelSpinner } from '@/components/brand/Brand';
import { useRef, useState, type DragEvent } from 'react';
import { FileUp } from 'lucide-react';
import { cn } from '@/lib/utils';

export function DocDrop({ onFile, busy, label, hint, compact }: { onFile: (f: File) => void; busy?: boolean; label: string; hint?: string; compact?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const drop = (e: DragEvent) => {
    e.preventDefault(); setOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) onFile(f);
  };
  return (
    <button
      type="button" disabled={busy}
      onClick={() => ref.current?.click()}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={drop}
      className={cn(
        'w-full flex items-center gap-3 rounded-xl border-2 border-dashed px-4 text-left transition-colors',
        compact ? 'py-3' : 'py-4',
        over ? 'border-accent bg-accent-soft' : 'border-line hover:border-line-strong hover:bg-surface-2/60',
      )}
    >
      <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent">
        {busy ? <PixelSpinner className="size-5" /> : <FileUp className="size-5" />}
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium">{busy ? 'Lendo o documento…' : label}</span>
        {hint && <span className="block text-xs text-faint">{hint}</span>}
      </span>
      <input
        ref={ref} type="file" hidden accept=".pdf,.png,.jpg,.jpeg,.webp,application/pdf,image/*"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ''; }}
      />
    </button>
  );
}
