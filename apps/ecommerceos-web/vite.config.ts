import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5190,
    proxy: {
      "/v1": "http://localhost:8900",
      "/health": "http://localhost:8900",
    },
  },
});
