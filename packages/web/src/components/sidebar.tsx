'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';

const NAV = [
  { href: '/dashboard', label: 'Drafts' },
  { href: '/dashboard/calendar', label: 'Calendar' },
  { href: '/dashboard/analytics', label: 'Analytics' },
  { href: '/dashboard/voice', label: 'Voice' },
  { href: '/dashboard/settings', label: 'Settings' },
];

export function Sidebar({ email, plan }: { email?: string; plan?: string }) {
  const pathname = usePathname();

  return (
    <aside className="hidden w-56 shrink-0 border-r bg-card/40 lg:block">
      <div className="flex h-14 items-center gap-2 border-b px-4">
        <span className="text-base font-semibold tracking-tight">Upvote</span>
      </div>

      <nav className="flex flex-col gap-1 p-3 text-sm">
        {NAV.map((item) => {
          const active = pathname === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                'rounded-md px-3 py-2 transition-colors',
                active ? 'bg-accent font-medium text-accent-foreground' : 'text-muted-foreground hover:bg-accent/60',
              )}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="mt-auto border-t p-4 text-xs text-muted-foreground">
        {email && <div className="truncate">{email}</div>}
        {plan && <div className="mt-0.5 capitalize">{plan} plan</div>}
      </div>
    </aside>
  );
}

export function TopNav() {
  const pathname = usePathname();
  return (
    <header className="flex h-14 items-center justify-between border-b px-5 lg:hidden">
      <span className="font-semibold tracking-tight">Upvote</span>
      <nav className="flex gap-3 text-xs">
        {NAV.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className={cn(pathname === item.href ? 'font-medium' : 'text-muted-foreground')}
          >
            {item.label}
          </Link>
        ))}
      </nav>
    </header>
  );
}