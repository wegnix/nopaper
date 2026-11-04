import { and, eq } from 'drizzle-orm';
import { db, schema } from '../db/client.js';

export async function getSystemSetting<T>(key: string): Promise<T | null> {
  const [r] = await db.select().from(schema.systemSettings).where(eq(schema.systemSettings.key, key));
  return (r?.value as T) ?? null;
}
export async function setSystemSetting(key: string, value: unknown) {
  await db.insert(schema.systemSettings).values({ key, value }).onConflictDoUpdate({ target: schema.systemSettings.key, set: { value, updatedAt: new Date() } });
}
export async function getOrgSetting<T>(orgId: string, key: string): Promise<T | null> {
  const [r] = await db.select().from(schema.orgSettings).where(and(eq(schema.orgSettings.orgId, orgId), eq(schema.orgSettings.key, key)));
  return (r?.value as T) ?? null;
}
export async function setOrgSetting(orgId: string, key: string, value: unknown) {
  await db.insert(schema.orgSettings).values({ orgId, key, value })
    .onConflictDoUpdate({ target: [schema.orgSettings.orgId, schema.orgSettings.key], set: { value, updatedAt: new Date() } });
}
