import type { Metadata } from 'next';
import { RootProvider } from 'fumadocs-ui/provider';
import 'fumadocs-ui/style.css';

export const metadata: Metadata = {
  title: { default: 'Upvote docs', template: '%s · Upvote docs' },
  description: 'Reddit growth on autopilot for developers.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="flex min-h-screen flex-col">
        <RootProvider>{children}</RootProvider>
      </body>
    </html>
  );
}