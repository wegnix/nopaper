import { useQuery } from '@tanstack/react-query';
import { get } from '@/lib/api';
import { useSession } from '@/lib/session';

export interface SystemView {
  smtp: { host: string; port: number; secure: boolean; user: string; from: string; hasPassword: boolean };
  telegram: { hasToken: boolean; botUsername: string | null };
  backup: {
    enabled: boolean; hour: number; keepLocal: number; includeUploads: boolean; lastRunOn: string | null;
    remote: {
      mode: 'none' | 'sftp' | 'rclone'; rcloneTarget: string; keepDays: number; hasRcloneConfig: boolean;
      sftp: { host: string; port: number; user: string; path: string; hasPassword: boolean; hasPrivateKey: boolean };
    };
  };
}
export interface Run { id: string; trigger: string; status: 'running' | 'ok' | 'error'; fileName: string | null; sizeBytes: number | null; remoteStatus: 'none' | 'ok' | 'error'; error: string | null; startedAt: string; finishedAt: string | null }


export const when = (s: string) => new Date(s).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
export const secretHint = (has: boolean) => (has ? 'Guardada. Deixe em branco para manter.' : undefined);

export function useSystemSettings() {
  const isSuper = useSession((s) => !!s.user?.isSuperadmin);
  return useQuery({ enabled: isSuper, queryKey: ['system'], queryFn: () => get<SystemView>('/api/system/settings') });
}
