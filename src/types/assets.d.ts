/**
 * Asset imports.
 *
 * Metro turns an image import into a numeric asset id, so TypeScript only
 * needs to know the module exists and default-exports that id. Declared here
 * once so screens can `require()` PNGs without a per-file `// @ts-expect-error`.
 */
declare module "*.png" {
  const source: number;
  export default source;
}

declare module "*.jpg" {
  const source: number;
  export default source;
}

declare module "*.svg" {
  const source: number;
  export default source;
}
