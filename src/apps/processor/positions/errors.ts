import { NotFoundError } from '@darmawanweb/ais-its-nest';

/** `404 AIS_POSITION_NOT_FOUND`: no position was ever recorded for the MMSI. */
export class AisPositionNotFoundError extends NotFoundError {
  override readonly name = 'AisPositionNotFoundError';

  constructor(mmsi: number) {
    super(`No AIS position recorded for MMSI ${mmsi}`, {
      code: 'AIS_POSITION_NOT_FOUND',
      title: 'AIS position not found',
      extra: { mmsi },
    });
  }
}
