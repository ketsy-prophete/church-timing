namespace ChurchTiming.Api.Contracts;

public record RundownSegmentSaveDto(
    int? order, string? name, int plannedSec,
    int? actualSec, int? driftSec, bool? completed
);
