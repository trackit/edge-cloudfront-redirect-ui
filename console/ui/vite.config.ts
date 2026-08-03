import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    // 5173 is often taken by another Vite app — use a distinct port here.
    // strictPort: false lets Vite pick the next free port if 5180 is busy too.
    port: 5180,
    strictPort: false,
  },
});
