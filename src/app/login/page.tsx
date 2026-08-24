import { redirect } from 'next/navigation';
import { Landing } from '@/components/marketing/landing';
import { getCurrentUser } from '@/lib/auth/current-user';

export const dynamic = 'force-dynamic';

const ERROR_MESSAGES: Record<string, string> = {
  oauth_not_configured:
    'GitHub OAuth is not configured on this instance. Add GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET, or continue with the demo workspace.',
  state_mismatch: 'Sign-in verification failed (state mismatch). Please try again.',
  missing_code: 'GitHub did not return an authorisation code. Please try again.',
  oauth_start_failed: 'Could not start GitHub sign-in. Check the server logs and your OAuth configuration.',
  oauth_failed: 'We could not complete GitHub sign-in. Please try again.',
  demo_failed: 'The demo workspace could not be started. Check the server logs.',
  access_denied: 'GitHub authorisation was cancelled.',
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const user = await getCurrentUser();
  if (user && !user.isDemo) redirect('/');

  const { error } = await searchParams;
  const message = error ? (ERROR_MESSAGES[error] ?? 'Sign-in failed. Please try again.') : null;

  return <Landing error={message} />;
}
