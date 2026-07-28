import type { Metadata } from 'next';
import './globals.css';
import { ErrorReporter } from './components/error-reporter';

export const metadata: Metadata = {
  title: 'Nirog Bhoomi Research OS',
  description: 'AI-native research knowledge management for the Nirog Bhoomi team.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <ErrorReporter />
        {children}
      </body>
    </html>
  );
}
