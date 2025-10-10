export function secondsRemaining(
  etaSec: number | null | undefined,
  etaUpdatedAtUtc: string | null | undefined,
  serverOffsetMs: number
): number | null {
  if (etaSec == null || !etaUpdatedAtUtc) return null;
  const updated = Date.parse(etaUpdatedAtUtc);
  const nowClientUtc = Date.now() - serverOffsetMs;   // align to server clock
  const elapsedSec = Math.max(0, Math.floor((nowClientUtc - updated) / 1000));
  return Math.max(0, etaSec - elapsedSec);
}
