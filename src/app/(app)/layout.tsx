import { AppShell } from '@/components/layout/app-shell';
import { getCurrentUser } from '@/lib/auth/current-user';
import { listRepositoriesForUser } from '@/lib/repositories';

export const dynamic = 'force-dynamic';

/**
 * Authenticated shell. Overview renders the public landing when there is no
 * session; other pages still send visitors to sign-in.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  if (!user) {
    return <>{children}</>;
  }

  const repos = await listRepositoriesForUser(user.id);
  const active = repos[0];

  return (
    <AppShell user={user} repoLabel={active?.fullName}>
      {children}
    </AppShell>
  );
}
