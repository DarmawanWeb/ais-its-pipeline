import {
  InjectPool,
  type Pool,
  withTransaction,
} from '@darmawanweb/ais-its-nest/db';
import { Injectable } from '@nestjs/common';

/** Identity of a vessel by MMSI (FLEET projection). */
export interface VesselRef {
  readonly mmsi: number;
  readonly vesselId: string;
  readonly name: string;
  readonly typeCode: string | null;
  /** `updatedAt` of the snapshot (orders redeliveries). */
  readonly updatedAt: Date;
}

/** Result of applying a snapshot. */
export type RefChange = 'applied' | 'stale';

/** `ais.vessel_refs`: idempotent by the snapshot's `updatedAt`. */
@Injectable()
export class VesselRefsRepository {
  constructor(@InjectPool() private readonly pool: Pool) {}

  /**
   * Applies a vessel snapshot unless a newer one is stored. A vessel whose
   * MMSI changed moves to the new MMSI (the old row is removed).
   */
  async upsert(ref: VesselRef): Promise<RefChange> {
    return withTransaction(
      this.pool,
      async (client) => {
        const current = await client.query<{ updated_at: Date }>(
          'SELECT updated_at FROM vessel_refs WHERE vessel_id = $1 FOR UPDATE',
          [ref.vesselId],
        );
        const stored = current.rows[0];
        if (stored !== undefined && stored.updated_at > ref.updatedAt)
          return 'stale';
        await client.query(
          'DELETE FROM vessel_refs WHERE vessel_id = $1 AND mmsi <> $2',
          [ref.vesselId, ref.mmsi],
        );
        const result = await client.query(
          `INSERT INTO vessel_refs (mmsi, vessel_id, name, type_code, updated_at)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (mmsi) DO UPDATE SET
             vessel_id = EXCLUDED.vessel_id, name = EXCLUDED.name,
             type_code = EXCLUDED.type_code, updated_at = EXCLUDED.updated_at
           WHERE vessel_refs.updated_at <= EXCLUDED.updated_at`,
          [ref.mmsi, ref.vesselId, ref.name, ref.typeCode, ref.updatedAt],
        );
        return result.rowCount === 0 ? 'stale' : 'applied';
      },
      { retries: 2 },
    );
  }

  /** Removes a deleted vessel. */
  async deleteByVesselId(vesselId: string): Promise<void> {
    await this.pool.query('DELETE FROM vessel_refs WHERE vessel_id = $1', [
      vesselId,
    ]);
  }
}
