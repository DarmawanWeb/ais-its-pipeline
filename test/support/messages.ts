/** Fields of a test report (legacy upstream names). */
export interface ReportFields {
  readonly mmsi: number | string;
  readonly lat: number;
  readonly lon: number;
  readonly sog?: number;
  readonly cog?: number;
  readonly hdg?: number;
  readonly navstatus?: number;
  /** Legacy `data.utc` [s]: the position time is `timestamp − utc`. */
  readonly utc?: number;
  /** Reception timestamp of the message. */
  readonly timestamp: Date;
  readonly port?: string;
}

/**
 * A legacy upstream `TimestampedAisMessage` (be-legacy/src/types/ais.type.ts),
 * the shape of the Postman sample vessel 525005141 off Lombok.
 */
export function legacyMessage(fields: ReportFields): Record<string, unknown> {
  return {
    message: {
      data: {
        valid: true,
        aistype: 1,
        mmsi: String(fields.mmsi),
        navstatus: fields.navstatus ?? 0,
        lon: fields.lon,
        lat: fields.lat,
        cog: fields.cog ?? 0,
        sog: fields.sog ?? 0.1,
        hdg: fields.hdg ?? 511,
        utc: fields.utc ?? 0,
      },
      port: fields.port ?? 'COM3',
    },
    timestamp: fields.timestamp.toISOString(),
  };
}

/** The normalized flat format of `POST /ingest/ais`. */
export function normalizedMessage(
  fields: ReportFields,
): Record<string, unknown> {
  return {
    mmsi: Number(fields.mmsi),
    navstatus: fields.navstatus ?? 0,
    lat: fields.lat,
    lon: fields.lon,
    sog: fields.sog ?? 0.1,
    cog: fields.cog ?? 0,
    hdg: fields.hdg ?? 511,
    timestamp: fields.timestamp.toISOString(),
    ...(fields.utc === undefined ? {} : { utc: fields.utc }),
  };
}

/** The position time the ingestor derives: `timestamp − utc` seconds. */
export function positionTimeOf(fields: ReportFields): string {
  return new Date(
    fields.timestamp.getTime() - (fields.utc ?? 0) * 1000,
  ).toISOString();
}

/** Offsets a position by metres to the north and east (small distances). */
export function moved(
  position: { readonly lat: number; readonly lon: number },
  northM: number,
  eastM: number,
): { lat: number; lon: number } {
  const metersPerDegree = 111_195;
  return {
    lat: position.lat + northM / metersPerDegree,
    lon:
      position.lon +
      eastM / (metersPerDegree * Math.cos((position.lat * Math.PI) / 180)),
  };
}
