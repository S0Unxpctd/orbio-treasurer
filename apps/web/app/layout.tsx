import type { ReactNode } from 'react';

import './globals.css';

export const metadata = {
  title: 'Orbio Treasurer',
  description: 'A treasury for self-funded agents.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
