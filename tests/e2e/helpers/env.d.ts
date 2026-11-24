/// <reference types="vite/client" />

declare module 'node:fs' {
  export function readFileSync(path: string, encoding: 'utf8'): string;
  const fs: { readFileSync: typeof readFileSync };
  export default fs;
}

declare module 'node:path' {
  export function dirname(p: string): string;
  export function join(...paths: string[]): string;
  export function resolve(...paths: string[]): string;
  const path: { dirname: typeof dirname; join: typeof join; resolve: typeof resolve };
  export default path;
}

declare module 'node:url' {
  export function fileURLToPath(url: string): string;
}
