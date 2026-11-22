'use strict';

/**
 * pnpm hook (read automatically by `pnpm install`): keeps compile-time and
 * test-only optional peers out of the dependency graph. Without it pnpm links
 * the dev dependency that satisfies such a peer to the production package
 * that declares it, so `pnpm install --prod` (Docker image) installs it:
 *
 * - `@nestjs/swagger` declares `typescript` (its CLI plugin, unused here):
 *   about 24 MB;
 * - `@darmawanweb/ais-its-nest` declares `testcontainers` and
 *   `@nestjs/testing` for its `./testing` subpath, which only the tests
 *   import: testcontainers brings dockerode, ssh2, archiver and tar-fs
 *   into the image.
 *
 * The tests still resolve them: they stay dev dependencies of this
 * repository, hoisted into pnpm's virtual store (`node_modules/.pnpm/node_modules`).
 */
const COMPILE_TIME_PEERS = {
  '@nestjs/swagger': ['typescript'],
  '@darmawanweb/ais-its-nest': ['testcontainers', '@nestjs/testing'],
};

/** `record` without the keys in `names`. */
function without(record, names) {
  if (record === undefined) return undefined;
  return Object.fromEntries(
    Object.entries(record).filter(([name]) => !names.includes(name)),
  );
}

function readPackage(manifest) {
  const peers = COMPILE_TIME_PEERS[manifest.name];
  if (peers === undefined) return manifest;
  return {
    ...manifest,
    peerDependencies: without(manifest.peerDependencies, peers),
    peerDependenciesMeta: without(manifest.peerDependenciesMeta, peers),
  };
}

module.exports = { hooks: { readPackage } };
