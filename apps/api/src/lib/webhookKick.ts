/**
 * Aviso "aconteceu algo" para a entrega de webhooks, sem a auditoria depender do serviço:
 * quem entrega se registra aqui; várias mudanças seguidas viram uma entrega só (espera de 1,5 s).
 */
let handler: (() => Promise<unknown>) | null = null;
let timer: NodeJS.Timeout | null = null;

export function onWebhookKick(fn: () => Promise<unknown>) { handler = fn; }

export function kickWebhooks() {
  if (!handler || timer) return;
  timer = setTimeout(() => { timer = null; void handler?.().catch(() => { /* o job de 1 em 1 min tenta de novo */ }); }, 1500);
  timer.unref();
}
