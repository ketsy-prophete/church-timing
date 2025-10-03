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
  serviceStartSec: number;     // offset from service start (usually 0)
  segments: RundownSegment[];
}
