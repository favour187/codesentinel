import { redirect } from 'next/navigation';
import { AppShell } from '@/components/layout/app-shell';
import { getCurrentUser } from '@/lib/auth/current-user';
import { listRepositoriesForUser } from '@/lib/repositories';

export const dynamic = 'force-dynamic';

/**
 * Authenticated shell. Every page inside (app) requires a session; unauthorised
 * visitors are redirected to /login rather than seeing an empty dashboard.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  if (!user) redirect('/login');

  const repos = await listRepositoriesForUser(user.id);
  const active = repos[0];

  return (
    <AppShell user={user} repoLabel={active?.fullName}>
      {children}
    </AppShell>
  );
}
