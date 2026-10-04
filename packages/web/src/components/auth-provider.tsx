'use client';

import { ClerkProvider } from '@clerk/nextjs';
import type { ReactNode } from 'react';

export function AuthProvider({ children }: { children: ReactNode }) {
  return (
    <ClerkProvider
      publishableKey={process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ?? ''}
      appearance={{
        elements: {
          primaryButton: 'bg-primary text-primary-foreground',
        },
      }}
    >
      {children}
    </ClerkProvider>
  );
}