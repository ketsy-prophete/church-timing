namespace ChurchTiming.Api.Contracts;

public record SegmentUpsertDto(string Id, int Order, string Name, int PlannedSec, int? ActualSec);
