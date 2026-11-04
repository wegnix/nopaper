import type { z } from 'zod';
import { HttpError } from './errors.js';

export function parse<T extends z.ZodType>(schema: T, data: unknown): z.output<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    const issues = r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    throw new HttpError(422, issues[0] ? `${issues[0].path ? issues[0].path + ': ' : ''}${issues[0].message}` : 'Dados inválidos', 'validation', { issues });
  }
  return r.data;
}
