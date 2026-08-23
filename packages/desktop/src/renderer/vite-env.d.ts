/**
 * `import "./app.css"` is a Vite affordance, not a TypeScript one, and `vite/client` is what
 * declares it. Referenced here rather than through `compilerOptions.types` because that key
 * replaces the list wholesale, and this program still needs Node's types to resolve the
 * type-only re-exports in `engine/protocol.ts`.
 */
/// <reference types="vite/client" />
