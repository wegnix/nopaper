import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import './index.css';
import { useSession } from './lib/session';
import { bootSession, ApiError } from './lib/api';
import { useTheme } from './lib/theme';
import { afterLoginPath } from './lib/utils';
import { AppShell } from './components/layout/AppShell';
import { ConfirmProvider } from './components/ui/dialog';
import { LogoLoader } from './components/brand/Brand';
import { ForcePasswordPage, LoginPage } from './pages/Auth';
import { SignPage } from './pages/SignPage';
import { DashboardPage } from './pages/Dashboard';
import { BillsPage } from './features/bills/BillsPage';
import { CardsPage } from './features/cards/CardsPage';
import { BankPage } from './features/bank/BankPage';
import { AccountingPage } from '@/features/accounting/AccountingPage';
import { AccountantInboxPage } from '@/features/accounting/Exchange';
import { PayrollPage } from './features/payroll/PayrollPage';
import { ImportPage } from './features/import/ImportPage';
import { ReportsPage } from './features/reports/ReportsPage';
import { SettingsLayout, SettingsIndex } from './features/settings/SettingsLayout';
import { AlertsPage } from './features/settings/Alerts';
import { BackupsPage } from './features/platform/Backups';
import { NotificationsPage } from './features/platform/Notifications';
import { UsersPage } from './features/platform/Users';
import { SecurityPage } from './features/platform/Security';
import { UpdatesPage } from './features/platform/Updates';
import { RestoreOverlay } from './features/settings/Restore';
import { ProfilePage } from './features/settings/Profile';
import { MembersPage } from './features/settings/Members';
import { GroupsPage } from './features/settings/Groups';
import { IntegrationsPage } from './features/settings/Integrations';
import { OrgPage } from './features/settings/Org';
import { AuditPage, PlatformAuditPage } from './features/settings/Audit';

const qc = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 2,
      refetchOnWindowFocus: true,
    },
  },
});

/** Abrindo o app: carregando a sessão, ou esperando o servidor voltar (sem mandar para o login). */
function ConnectingScreen() {
  const connecting = useSession((s) => s.connecting);
  return (
    <div className="grid h-dvh place-items-center">
      <div className="flex flex-col items-center gap-3 text-sm text-muted">
        <LogoLoader size={112} label="Abrindo o NoPaper" />
        {connecting && <p>Conectando ao servidor… tentando de novo automaticamente.</p>}
      </div>
    </div>
  );
}

function RequireAuth({ children }: { children: React.ReactNode }) {
  const status = useSession((s) => s.status);
  const mustChange = useSession((s) => !!s.user?.mustChangePassword);
  const loc = useLocation();
  if (status === 'loading') return <ConnectingScreen />;
  if (status === 'anon') return <Navigate to="/login" replace state={{ from: loc.pathname + loc.search }} />;
  if (mustChange) return <ForcePasswordPage />;
  return <>{children}</>;
}

/** Já entrou e está em /login: segue para a página pedida pelo link do e-mail (ou o Início). */
function AfterLogin() {
  return <Navigate to={afterLoginPath(useLocation().state)} replace />;
}

function App() {
  const status = useSession((s) => s.status);
  const theme = useTheme((s) => s.theme);
  useEffect(() => { bootSession(); }, []);
  // saiu (manual, inatividade, sessão expirada): descarta os dados em cache da conta anterior
  useEffect(() => { if (status === 'anon') qc.clear(); }, [status]);
  return (
    <>
      <Routes>
        <Route path="/login" element={status === 'authed' ? <AfterLogin /> : <LoginPage />} />
        <Route path="/cadastro" element={<Navigate to="/login" replace />} />
        <Route path="/assinar/:token" element={<SignPage />} />
        <Route element={<RequireAuth><AppShell /></RequireAuth>}>
          <Route index element={<DashboardPage />} />
          <Route path="pagar" element={<BillsPage type="payable" />} />
          <Route path="receber" element={<BillsPage type="receivable" />} />
          <Route path="cartoes" element={<CardsPage />} />
          <Route path="bancos" element={<BankPage />} />
          <Route path="folha" element={<PayrollPage />} />
          <Route path="contador" element={<AccountingPage />} />
          <Route path="recebidos" element={<AccountantInboxPage />} />
          <Route path="relatorios" element={<ReportsPage />} />
          <Route path="importar" element={<ImportPage />} />
          <Route path="config" element={<SettingsLayout />}>
            <Route index element={<SettingsIndex />} />
            <Route path="perfil" element={<ProfilePage />} />
            <Route path="organizacao" element={<OrgPage />} />
            <Route path="membros" element={<MembersPage />} />
            <Route path="grupos" element={<GroupsPage />} />
            <Route path="alertas" element={<AlertsPage />} />
            <Route path="integracoes" element={<IntegrationsPage />} />
            <Route path="auditoria" element={<AuditPage />} />
            <Route path="plataforma/usuarios" element={<UsersPage />} />
            <Route path="plataforma/backups" element={<BackupsPage />} />
            <Route path="plataforma/notificacoes" element={<NotificationsPage />} />
            <Route path="plataforma/seguranca" element={<SecurityPage />} />
            <Route path="plataforma/atualizacoes" element={<UpdatesPage />} />
            <Route path="plataforma/auditoria" element={<PlatformAuditPage />} />
            <Route path="sistema" element={<Navigate to="/config/plataforma/backups" replace />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
      <RestoreOverlay />
      <Toaster theme={theme} position="top-right" richColors closeButton mobileOffset={{ top: 'calc(env(safe-area-inset-top) + 12px)', left: 12, right: 12 }} toastOptions={{ style: { fontFamily: 'var(--font-sans)' } }} />
    </>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={qc}>
      <ConfirmProvider>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </ConfirmProvider>
    </QueryClientProvider>
  </StrictMode>,
);

// PWA: só em produção (no dev o Vite serve módulos que não devem ir para o cache)
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => null); });
}
