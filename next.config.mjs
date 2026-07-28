/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: false },
  serverExternalPackages: ['pdf-parse', 'pg'],
  // The gpt-actions.yaml route reads openapi/gpt-actions.yaml from disk at
  // request time rather than importing it, so Vercel's build-time file
  // tracing wouldn't otherwise know to bundle it into that function.
  outputFileTracingIncludes: {
    '/gpt-actions.yaml': ['./openapi/gpt-actions.yaml'],
  },
};

export default nextConfig;
