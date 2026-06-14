/** @type {import('next').NextConfig} */
const nextConfig = {
  // Pure static marketing site → export to plain HTML/CSS/JS so it can be
  // hosted on any static host (Vercel, 阿里云 OSS, Nginx) without a Node server.
  output: "export",
  images: { unoptimized: true },
  reactStrictMode: true,
};

export default nextConfig;
