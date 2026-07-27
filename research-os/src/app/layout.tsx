import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Nirog Bhoomi Research OS',
  description: 'AI-native research knowledge management for the Nirog Bhoomi team.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
