import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // Use 127.0.0.1 explicitly — on Windows, Node resolves `localhost` to
      // ::1 first, but uvicorn only binds IPv4 by default, so the proxy
      // gets ECONNREFUSED.
      "/slack": "http://127.0.0.1:8000",
      "/drafts": "http://127.0.0.1:8000",
      "/health": "http://127.0.0.1:8000",
      "/ws": { target: "ws://127.0.0.1:8000", ws: true },
    },
  },
});
