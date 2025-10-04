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
