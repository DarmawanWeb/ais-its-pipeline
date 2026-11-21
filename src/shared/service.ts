import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import * as z from 'zod';

const PackageJsonSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  /** Human name of the repository. */
  displayName: z.string().min(1),
  description: z.string().min(1),
});

/** Root of the package (`src/shared` and `dist/shared` are two levels below it). */
const PACKAGE_ROOT = new URL('../../', import.meta.url);

/** The repository's package.json. */
function readPackageJson(): z.output<typeof PackageJsonSchema> {
  const url = new URL('package.json', PACKAGE_ROOT);
  return PackageJsonSchema.parse(JSON.parse(readFileSync(url, 'utf8')));
}

const packageJson = readPackageJson();

/**
 * Identity of the repository and its two processes (docs/PLATFORM_SPEC.md
 * §1, §3, §6, §13.2): one image, two entrypoints. The `SERVICE_NAME` of each
 * process is the producer name of its events (`ais-ingestor` publishes
 * `ais.raw.received.v1`, `ais-processor` publishes `ais.position.recorded.v1`).
 */
export const SERVICE = Object.freeze({
  /** Package, repository and image name. */
  packageName: packageJson.name,
  /** Human name (package.json `displayName`). */
  title: packageJson.displayName,
  description: packageJson.description,
  /** The release version: package.json is its single source. */
  version: packageJson.version,
  /** Absolute path of the package root (data files ship next to `dist/`). */
  root: fileURLToPath(PACKAGE_ROOT),
  /** Stateless ingestion process (no database). */
  ingestor: Object.freeze({ name: 'ais-ingestor', port: 3003 }),
  /** Processing and query process; owns the PostgreSQL schema `ais`. */
  processor: Object.freeze({
    name: 'ais-processor',
    port: 3004,
    schema: 'ais',
  }),
});
