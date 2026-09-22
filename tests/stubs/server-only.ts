// Test stub for the `server-only` package. In Next.js builds it throws
// when a server module is bundled for the client; under vitest there is
// no bundler boundary, so it is aliased to this no-op. Tests exercise
// domain services directly — the client/server guard itself is verified
// by the production build.
export {};
