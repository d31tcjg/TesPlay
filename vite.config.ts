import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: { "/api": "http://127.0.0.1:4174" },
  },
  build: {
    target: "es2020",
    rollupOptions: { output: { manualChunks(id) {
      if (/node_modules\/(mpg123-decoder|@wasm-audio-decoders|@eshaz|simple-yenc)\//.test(id)) return 'mpeg-audio-decoder';
      if (id.includes('/node_modules/mediabunny/')) return 'media-demux';
    } } },
  },
});
