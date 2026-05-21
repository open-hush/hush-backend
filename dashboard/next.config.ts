import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  // typedRoutes requires `next build` to generate types; turn back on when
  // routes are stable and CI runs build before typecheck.
  typedRoutes: false,
};

export default config;
