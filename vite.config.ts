// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - TanStack devtools (dev-only, first), tanstackStart, viteReact, tailwindcss, tsConfigPaths,
//     nitro (build-only using cloudflare as a default target), VITE_* env injection, @ path alias,
//     React/TanStack dedupe, error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { execSync } from "node:child_process";
import { defineConfig } from "@lovable.dev/vite-tanstack-config";
import { liveVoiceDev } from "./live-vite-plugin";

// Stamp the build with its git identity for /api/public/version. Missing git → nulls, never a guess.
function buildIdentity() {
  const git = (cmd: string) => {
    try {
      return execSync(`git ${cmd}`, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    } catch {
      return null;
    }
  };
  const commit = git("rev-parse HEAD");
  const status = commit ? git("status --porcelain --untracked-files=no") : null;
  return {
    commit,
    tree: commit ? git("rev-parse HEAD^{tree}") : null,
    dirty: status === null ? null : status.length > 0,
    builtAt: new Date().toISOString(),
  };
}

export default defineConfig({
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },
  vite: {
    plugins: [liveVoiceDev()],
    define: { __JACKBOY_BUILD__: JSON.stringify(buildIdentity()) },
  },
});
