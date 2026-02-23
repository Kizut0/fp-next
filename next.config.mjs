/** @type {import('next').NextConfig} */
const nextConfig = {
  /* config options here */
  reactCompiler: true,
  async rewrites() {
    return [
      {
        source: "/auth/:path*",
        destination: "/api/auth/:path*",
      },
    ];
  },
};

export default nextConfig;
