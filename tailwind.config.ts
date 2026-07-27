import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/app/**/*.{ts,tsx}', './src/components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#f0f9f4',
          100: '#dcf1e3',
          500: '#2f8f5b',
          600: '#237348',
          700: '#1c5c3a',
        },
      },
    },
  },
  plugins: [],
};

export default config;
