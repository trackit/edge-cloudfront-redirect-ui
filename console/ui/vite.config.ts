import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The API's own dev server — `npm run dev -w console/api`.
const API_DEV_SERVER = process.env.API_DEV_SERVER ?? "http://localhost:3000";

export default defineConfig({
  plugins: [react()],
  server: {
    // 5173 is often taken by another Vite app — use a distinct port here.
    // strictPort: false lets Vite pick the next free port if 5180 is busy too.
    port: 5180,
    strictPort: false,
    proxy: {
      // The client calls `/api/...` relative by default, so it is same-origin in
      // the browser and no CORS is involved. Here that path is forwarded to the
      // local API with the prefix stripped, since the API serves `/health`, not
      // `/api/health`. In production the same relative path expects an `/api/*`
      // route on whatever fronts the SPA.
      "/api": {
        target: API_DEV_SERVER,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
});
