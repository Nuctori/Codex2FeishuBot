import * as esbuild from 'esbuild';

const shared = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external: [
    // SDK must stay external: it resolves its own CLI assets at runtime.
    '@anthropic-ai/claude-agent-sdk',
    '@openai/codex-sdk',
    // discord.js optional native deps
    'bufferutil', 'utf-8-validate', 'zlib-sync', 'erlpack',
    // Node.js built-ins
    'fs', 'path', 'os', 'crypto', 'http', 'https', 'net', 'tls',
    'stream', 'events', 'url', 'util', 'child_process', 'worker_threads',
    'node:*',
  ],
  banner: {
    js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
  },
};

await esbuild.build({
  ...shared,
  entryPoints: ['src/main.ts'],
  outfile: 'dist/daemon.mjs',
});

await esbuild.build({
  ...shared,
  entryPoints: ['src/windows-watchdog.ts'],
  outfile: 'dist/windows-watchdog.mjs',
});

console.log('Built dist/daemon.mjs');
console.log('Built dist/windows-watchdog.mjs');
