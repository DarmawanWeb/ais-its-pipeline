import { readFile } from 'node:fs/promises';

import { InjectConfig } from '@darmawanweb/ais-its-nest';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';

import { CoastlineGeometry } from '../../../shared/domain/coastline.js';
import type { ProcessorConfig } from '../config.js';

/**
 * The coast geometry (`GEO_COASTLINE_PATH`, default `data/coastline.geojson`)
 * loaded and indexed **once** at startup (spec §13.2) — never per message.
 * A missing or invalid file stops the boot: every recorded position needs it.
 */
@Injectable()
export class CoastlineService implements OnModuleInit {
  private readonly logger = new Logger(CoastlineService.name);
  private geometry: CoastlineGeometry | null = null;

  constructor(@InjectConfig() private readonly config: ProcessorConfig) {}

  async onModuleInit(): Promise<void> {
    const path = this.config.GEO_COASTLINE_PATH;
    const json: unknown = JSON.parse(await readFile(path, 'utf8'));
    this.geometry = CoastlineGeometry.fromGeoJson(json);
    const { rings, segments, skippedSegments, ignoredFeatures } =
      this.geometry.summary;
    this.logger.log(
      `Coastline loaded from ${path}: ${rings} rings, ${segments} segments` +
        (skippedSegments + ignoredFeatures > 0
          ? ` (${skippedSegments} zero-length segments and ${ignoredFeatures} non-polygon features ignored)`
          : ''),
    );
  }

  /**
   * Distance to the coast [m] (method `geo.coast_distance`); `Infinity`
   * when the file has no polygon (legacy).
   *
   * @throws {Error} before the module was initialized
   */
  distanceM(lat: number, lon: number): number {
    if (this.geometry === null)
      throw new Error('The coastline is not loaded yet');
    return this.geometry.distanceM(lat, lon);
  }
}
