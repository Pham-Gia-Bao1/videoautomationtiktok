import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Studio — Podcast Studio',
  description: 'Create multi-speaker podcasts from a script.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
