import { defineConfig } from "vite";
import basicSsl from "@vitejs/plugin-basic-ssl";
import { resolve } from "node:path";

export default defineConfig({
  base: "./",
  plugins: [basicSsl()],
  build: {
    rollupOptions: {
      input: {
        index: resolve(__dirname, "index.html"),       // simple landing page (optional)
        send: resolve(__dirname, "send/index.html"),
        receive: resolve(__dirname, "receive/index.html"),
      },
    },
  },
  server: { host: true },
});