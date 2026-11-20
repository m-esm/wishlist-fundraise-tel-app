import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/** Everything under the repository-root `src/` is server code and must never reach the browser. */
const serverRoot = fileURLToPath(new URL("../src", import.meta.url));
const serverPackages = /^(?:@aws-sdk\/|@grammyjs\/|ioredis$|grammy$|drizzle-orm$|postgres$)/;

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    {
      name: "client-boundary",
      enforce: "pre",
      resolveId(source, importer) {
        const from = importer ?? "the client entry";
        if (source.startsWith("node:")) this.error(`Node built-in "${source}" imported by ${from}`);
        if (serverPackages.test(source)) this.error(`Server package "${source}" imported by ${from}`);
      },
      load(id) {
        const file = id.split("?")[0]!;
        if (file === serverRoot || file.startsWith(`${serverRoot}/`)) {
          this.error(`Server module included in client bundle: ${id}`);
        }
      },
    },
  ],
});
