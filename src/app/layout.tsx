import type { Metadata, Viewport } from 'next';
import './globals.css';
import { ThemeProvider, THEME_SCRIPT } from '@/components/layout/theme-provider';

export const metadata: Metadata = {
  title: {
    default: 'CodeSentinel — Your repository’s autonomous code guardian',
    template: '%s · CodeSentinel',
  },
  description:
    'Open-source, GitHub-connected autonomous code guardian. Continuously analyses repositories, pull requests, dependencies, tests and security risk.',
  applicationName: 'CodeSentinel',
  icons: {
    icon: [{ url: '/icon.png', type: 'image/png' }],
    apple: [{ url: '/apple-icon.png', type: 'image/png' }],
  },
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#0e0e12' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Applies the stored theme before first paint (no flash). */}
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-[hsl(var(--primary))] focus:px-4 focus:py-2 focus:text-sm focus:text-[hsl(var(--primary-foreground))]"
        >
          Skip to content
        </a>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
