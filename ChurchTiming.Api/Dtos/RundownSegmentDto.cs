namespace ChurchTiming.Api.Contracts;

public record RundownSegmentDto(
    int id, int order, string name, int plannedSec,
    int? actualSec, int? driftSec, bool completed
);
