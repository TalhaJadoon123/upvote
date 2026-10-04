import { Suspense } from 'react';
import { AuthProvider } from '@/components/auth-provider';
import { Sidebar, TopNav } from '@/components/sidebar';
import { getOptionalUser } from '@/lib/auth';

/**
 * Authenticated app shell.
 *
 * `getOptionalUser` returns null for an anonymous request so the marketing site
 * and this layout can share a root layout without a Clerk key present.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getOptionalUser();

  return (
    <AuthProvider>
      <div className="flex min-h-screen">
        <Sidebar email={user?.email ?? undefined} plan={user?.plan} />
        <div className="flex min-w-0 flex-1 flex-col">
          <TopNav />
          <main className="flex-1 bg-background p-5 lg:p-8">
            <Suspense fallback={<div className="text-sm text-muted-foreground">Loading...</div>}>
              {children}
            </Suspense>
          </main>
        </div>
      </div>
    </AuthProvider>
  );
}