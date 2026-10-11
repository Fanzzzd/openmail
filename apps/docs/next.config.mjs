import { createMDX } from "fumadocs-mdx/next";

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  // Plain static files: search uses the prebuilt index from app/api/search/route.ts.
  output: "export",
  reactStrictMode: true,
};

export default withMDX(config);
