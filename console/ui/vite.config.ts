import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Standalone visual prototype. Runs independently of the monorepo workspaces.
export default defineConfig({
  plugins: [react()],
  server: {
    // 5173 is often taken by another Vite app — use a distinct port here.
    // strictPort: false lets Vite pick the next free port if 5180 is busy too.
    port: 5180,
    strictPort: false,
    open: true,
  },
});
