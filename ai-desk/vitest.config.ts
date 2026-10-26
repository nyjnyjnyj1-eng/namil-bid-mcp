import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

// 시험은 Node에서 돌립니다. Cloudflare 전용 모듈은 흉내 낸 것으로 바꾸고, .html은 글로 읽습니다.
export default defineConfig({
  resolve: {
    alias: { "cloudflare:workers": new URL("./test/stubs/cloudflare-workers.ts", import.meta.url).pathname },
  },
  plugins: [
    {
      name: "html-as-text",
      enforce: "pre",
      load(id) {
        if (id.endsWith(".html")) return `export default ${JSON.stringify(readFileSync(id, "utf8"))};`;
      },
    },
  ],
  test: { include: ["test/**/*.test.ts"] },
});
