export class HttpError extends Error {
  constructor(public statusCode: number, message: string, public code?: string, public extra?: Record<string, unknown>) {
    super(message);
  }
}
export const badRequest = (msg: string, code?: string, extra?: Record<string, unknown>) => new HttpError(400, msg, code, extra);
export const unauthorized = (msg = 'Não autenticado') => new HttpError(401, msg, 'unauthorized');
export const forbidden = (msg = 'Sem permissão para esta ação') => new HttpError(403, msg, 'forbidden');
export const notFound = (msg = 'Não encontrado') => new HttpError(404, msg, 'not_found');
export const conflict = (msg: string) => new HttpError(409, msg, 'conflict');
