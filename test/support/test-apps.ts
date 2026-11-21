import type { ApiKeyScope } from '@darmawanweb/ais-its-contracts/auth';
import type {
  AnyEventEnvelope,
  EventType,
  StreamName,
} from '@darmawanweb/ais-its-contracts/events';
import { ACCESS_TOKEN_KEY_RESOLVER } from '@darmawanweb/ais-its-nest/auth';
import { PG_POOL, type Pool } from '@darmawanweb/ais-its-nest/db';
import { NatsClient, StreamReplayer } from '@darmawanweb/ais-its-nest/nats';
import {
  buildTestApp,
  createTestConfig,
  createTestJwtIssuer,
  dropServiceSchema,
  type FakeIntrospectionServer,
  generateTestApiKey,
  provisionServiceSchema,
  startFakeApiKeyIntrospection,
  testInfra,
  type TestJwtIssuer,
  type TestTokenClaims,
  uniqueName,
} from '@darmawanweb/ais-its-nest/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import {
  configureIngestorApp,
  INGESTOR_BODY_LIMIT_BYTES,
} from '../../src/apps/ingestor/bootstrap.js';
import {
  type IngestorConfig,
  ingestorConfigSchema,
} from '../../src/apps/ingestor/config.js';
import { IngestorModule } from '../../src/apps/ingestor/ingestor.module.js';
import { INGESTOR_OPENAPI } from '../../src/apps/ingestor/openapi.options.js';
import {
  type ProcessorConfig,
  processorConfigSchema,
} from '../../src/apps/processor/config.js';
import { PROCESSOR_OPENAPI } from '../../src/apps/processor/openapi.options.js';
import { ProcessorModule } from '../../src/apps/processor/processor.module.js';
import { SERVICE } from '../../src/shared/service.js';

/** `INTERNAL_TOKEN` shared by the apps and the fake introspection endpoint. */
export const TEST_INTERNAL_TOKEN = 'test-internal-token-0123456789';

/**
 * Credentials for the apps under test: a JWT issuer (users) and the auth
 * service's API-key introspection endpoint, faked over HTTP so the real
 * introspection client of the kit is exercised.
 */
export interface TestAuth {
  readonly jwt: TestJwtIssuer;
  readonly introspection: FakeIntrospectionServer;
  /** `Authorization` header with a freshly signed access token. */
  bearer(claims?: TestTokenClaims): Promise<{ authorization: string }>;
  /** Registers a new active API key with `scopes` and returns it. */
  apiKey(scopes: readonly ApiKeyScope[], name?: string): string;
  close(): Promise<void>;
}

export async function startTestAuth(): Promise<TestAuth> {
  const jwt = await createTestJwtIssuer();
  const introspection = await startFakeApiKeyIntrospection({
    internalToken: TEST_INTERNAL_TOKEN,
  });
  return {
    jwt,
    introspection,
    bearer: async (claims) => ({
      authorization: `Bearer ${await jwt.sign(claims)}`,
    }),
    apiKey: (scopes, name) => {
      const key = generateTestApiKey();
      introspection.introspector.add(key, { scopes, name });
      return key;
    },
    close: () => introspection.close(),
  };
}

/** Variables every app under test gets (shared containers, fake auth). */
function commonEnv(auth: TestAuth): Record<string, string> {
  const { nats } = testInfra('nats');
  return {
    NATS_URL: nats.url,
    // Durable consumers of one app never collide with another app's.
    NATS_DURABLE_PREFIX: uniqueName('t'),
    AUTH_INTERNAL_URL: auth.introspection.url,
    INTERNAL_TOKEN: TEST_INTERNAL_TOKEN,
  };
}

/** A started ingestor. */
export interface TestIngestor {
  readonly app: NestFastifyApplication;
  readonly config: IngestorConfig;
  /** `http://127.0.0.1:<port>` when started with `listen` (socket.io tests). */
  readonly url: string | null;
}

/**
 * Builds the real ingestor as `server.ts` does (socket.io adapter, body
 * limit); hooks run (NATS, AIS_RAW ensured, upstream feeds started).
 */
export async function startIngestor(
  auth: TestAuth,
  env: Readonly<Record<string, string>> = {},
  options: { readonly listen?: boolean } = {},
): Promise<TestIngestor> {
  const config = createTestConfig(ingestorConfigSchema, {
    ...commonEnv(auth),
    ...env,
  });
  const app = await buildTestApp(IngestorModule, {
    config,
    openapi: INGESTOR_OPENAPI,
    adapter: { bodyLimitBytes: INGESTOR_BODY_LIMIT_BYTES },
    configure: configureIngestorApp,
    overrides: [
      { provide: ACCESS_TOKEN_KEY_RESOLVER, useValue: auth.jwt.keyResolver },
    ],
  });
  let url: string | null = null;
  if (options.listen === true) {
    await app.listen(0, '127.0.0.1');
    url = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  }
  return { app, config, url };
}

/** A started processor with its database pool. */
export interface TestProcessor {
  readonly app: NestFastifyApplication;
  readonly config: ProcessorConfig;
  readonly pool: Pool;
}

/**
 * A clean schema `ais` (dropped and provisioned like
 * `infra/postgres/bootstrap.sql`): the drizzle definitions name the schema,
 * so test files share it and each starts from scratch. Returns the
 * `DATABASE_URL` of `ais_svc`.
 */
export async function resetProcessorSchema(): Promise<string> {
  const { postgres } = testInfra('postgres');
  await dropServiceSchema(postgres.adminUrl, SERVICE.processor.schema);
  return provisionServiceSchema(postgres.adminUrl, SERVICE.processor.schema);
}

/**
 * Builds the real processor (migrations on boot, consumers `ais-processor`
 * and `ais-processor-fleet`, Valkey, coastline). Short batch delays keep
 * the tests fast.
 */
export async function startProcessor(
  auth: TestAuth,
  databaseUrl: string,
  env: Readonly<Record<string, string>> = {},
): Promise<TestProcessor> {
  const { redis } = testInfra('redis');
  const config = createTestConfig(processorConfigSchema, {
    ...commonEnv(auth),
    DATABASE_URL: databaseUrl,
    DATABASE_SCHEMA: SERVICE.processor.schema,
    DB_MIGRATE_ON_BOOT: 'true',
    REDIS_URL: redis.url,
    PROCESSOR_FLUSH_MS: '50',
    ...env,
  });
  const app = await buildTestApp(ProcessorModule, {
    config,
    openapi: PROCESSOR_OPENAPI,
    overrides: [
      { provide: ACCESS_TOKEN_KEY_RESOLVER, useValue: auth.jwt.keyResolver },
    ],
  });
  return { app, config, pool: app.get<unknown, Pool>(PG_POOL) };
}

/**
 * Empties streams shared by the test files (durable consumers deliver the
 * whole stream, so a new processor would replay earlier files' reports).
 * Call it before starting a processor.
 */
export async function purgeStreams(
  app: NestFastifyApplication,
  streams: readonly StreamName[],
): Promise<void> {
  const { manager } = await app.get(NatsClient).ready();
  for (const stream of streams) {
    await manager.streams.purge(stream).catch((error: unknown) => {
      // A stream nobody created yet is empty.
      if (!String(error).includes('stream not found')) throw error;
    });
  }
}

/** A stored event with its subject and `Nats-Msg-Id`. */
export interface StoredEvent {
  readonly event: AnyEventEnvelope;
  readonly subject: string;
  readonly msgId: string | null;
}

/** Every event of `eventTypes` stored in `stream` since `from` (stream order). */
export async function readEvents(
  app: NestFastifyApplication,
  options: {
    readonly stream: StreamName;
    readonly filterSubjects: readonly string[];
    readonly eventTypes: readonly EventType[];
    readonly from: Date;
  },
): Promise<StoredEvent[]> {
  const events: StoredEvent[] = [];
  await app.get(StreamReplayer).replay({
    ...options,
    handler: (event, context) => {
      events.push({
        event,
        subject: context.subject,
        msgId: context.headers?.get('Nats-Msg-Id') ?? null,
      });
    },
  });
  return events;
}
