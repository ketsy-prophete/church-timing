export interface RundownSegment {
  id: number;
  title: string;
  owner?: string;
  startSec: number;
  durationSec: number;
  notes?: string;
  color?: string;
}
export interface RundownDoc {
  runId?: string;
  serviceStartSec: number;
  segments: RundownSegment[];
}
export interface SegmentUpsertDto {
  id?: string | null;   // send null/'' for new rows
  order: number;
  name: string;
  plannedSec: number;
}

