import { defineConfig } from "vite";
export default defineConfig({
  server: {
    port: 5173,
    // Not frontend code: watching them (huge datasets, venvs, build output) stalls the dev server.
    watch: {
      ignored: ["**/train/**", "**/worker/**", "**/service/target/**", "**/data/**", "**/outputs/**", "**/.venv/**"],
    },
    proxy: {
      // Simulation service (Rust); listed first so it wins over "/api".
      "/api/scenes": `http://127.0.0.1:${process.env.SIM_PORT || 3002}`,
      "/api/simulations": `http://127.0.0.1:${process.env.SIM_PORT || 3002}`,
      "/api/optimizations": `http://127.0.0.1:${process.env.SIM_PORT || 3002}`,
      "/api/jobs": `http://127.0.0.1:${process.env.SIM_PORT || 3002}`,
      "/api/model-version": `http://127.0.0.1:${process.env.SIM_PORT || 3002}`,
      "/api/cache": `http://127.0.0.1:${process.env.SIM_PORT || 3002}`,
      "/api/maintenance": `http://127.0.0.1:${process.env.SIM_PORT || 3002}`,
      "/api/capacity": `http://127.0.0.1:${process.env.SIM_PORT || 3002}`,
      "/api": `http://127.0.0.1:${process.env.API_PORT || 3001}`,
    },
  },
});
