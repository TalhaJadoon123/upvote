import type { Metadata, Viewport } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import './globals.css';

const sans = Inter({ subsets: ['latin'], variable: '--font-sans', display: 'swap' });
const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-mono', display: 'swap' });

export const metadata: Metadata = {
  title: {
    default: 'Upvote — Reddit growth on autopilot for developers',
    template: '%s · Upvote',
  },
  description:
    'Upvote turns your commits, releases and learnings into authentic Reddit posts in your voice. Ship code. We\'ll write the post.',
  keywords: ['reddit growth', 'indie hackers', 'launch posts', 'developer marketing', 'micro saas'],
  openGraph: {
    title: 'Upvote — Ship code. We\'ll write the post.',
    description:
      'Reddit is the top growth channel for micro-SaaS. Upvote watches your GitHub and drafts posts that sound like you, then posts them at the hour each subreddit actually responds.',
    type: 'website',
  },
  twitter: { card: 'summary_large_image' },
  icons: { icon: '/icon.svg' },
};

export const viewport: Viewport = {
  themeColor: '#09090b',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className={`${sans.variable} ${mono.variable}`}>
      <body className="min-h-screen bg-background font-sans">
        {/* Deliberately no ClerkProvider here: the marketing site must render
            for logged-out visitors without a Clerk key configured. Auth is
            mounted per-route group in (app). */}
        {children}
      </body>
    </html>
  );
}