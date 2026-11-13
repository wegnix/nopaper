import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Download, ExternalLink, Printer } from 'lucide-react';
import { ATTACHMENT_SLOT_LABEL, type AttachmentSlot } from '@nopaper/shared';
import { Dialog } from '@/components/ui/dialog';
import { Button, Spinner } from '@/components/ui/base';
import { get, errMsg } from '@/lib/api';

/** Anexo de uma conta (attachmentId + slot) ou outro arquivo com URL assinada própria (`urlPath` + `label`). */
interface Target { attachmentId?: string; slot?: AttachmentSlot; urlPath?: string; label?: string; title: string }
const isAndroid = /Android/i.test(navigator.userAgent);

export function FileViewer({ target, onClose }: { target: Target | null; onClose: () => void }) {
  const [data, setData] = useState<{ url: string; downloadUrl: string; mime: string; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setData(null); setError(null);
    if (target) get<{ url: string; downloadUrl: string; mime: string; name: string }>(target.urlPath ?? `/api/attachments/${target.attachmentId}/url`).then(setData).catch((e) => setError(errMsg(e)));
  }, [target]);

  const isImage = !!data?.mime.startsWith('image/');
  const print = () => {
    // imagem: a cópia `.print-doc` abaixo é a única coisa que sai no papel (regra do index.css)
    if (isImage) { window.print(); return; }
    const iframe = document.getElementById('np-viewer') as HTMLIFrameElement | null;
    try { iframe?.contentWindow?.print(); } catch { window.open(data?.url, '_blank'); }
  };
  return (
    <Dialog
      open={!!target} onClose={onClose} size="xl"
      title={target ? `${target.label ?? (target.slot ? ATTACHMENT_SLOT_LABEL[target.slot] : 'Arquivo')} · ${target.title}` : ''}
      description={data?.name}
      className="sm:h-[92dvh]"
      footer={data && <>
        {!isAndroid && (data.mime === 'application/pdf' || isImage) && <Button variant="ghost" icon={<Printer className="size-4" />} onClick={print}>Imprimir</Button>}
        <Button variant="ghost" icon={<ExternalLink className="size-4" />} onClick={() => window.open(data.url, '_blank', 'noopener')}>Abrir em nova aba</Button>
        <Button variant="primary" icon={<Download className="size-4" />} onClick={() => { location.href = data.downloadUrl; }}>Baixar</Button>
      </>}
    >
      <div className="h-[70dvh] sm:h-[calc(92dvh-170px)] rounded-lg overflow-hidden border border-line bg-white grid place-items-center">
        {error && <p className="text-sm text-danger">{error}</p>}
        {!data && !error && <Spinner />}
        {data && (data.mime.startsWith('image/')
          ? <img src={data.url} alt={data.name} className="max-h-full max-w-full object-contain" />
          : isAndroid
            ? <div className="text-center text-sm text-[#333] p-6">A pré-visualização de PDF não funciona no Android.<br />Use “Abrir em nova aba” ou “Baixar”.</div>
            : <iframe id="np-viewer" title={data.name} src={data.url} className="h-full w-full" />)}
      </div>
      {data && isImage && createPortal(<div className="print-doc"><img src={data.url} alt="" style={{ display: 'block', maxWidth: '100%', maxHeight: '260mm', margin: '0 auto' }} /></div>, document.body)}
    </Dialog>
  );
}
export type { Target as FileViewerTarget };
