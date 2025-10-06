using System.ComponentModel.DataAnnotations;
using System.ComponentModel.DataAnnotations.Schema;

namespace ChurchTiming.Api.Data;

public class RundownSegment
{
    [Key] public int Id { get; set; }
    [ForeignKey(nameof(Run))] public Guid RunId { get; set; }
    public Run? Run { get; set; }

    public int Order { get; set; }
    public string Name { get; set; } = string.Empty;
    public int PlannedSec { get; set; }

    public int? ActualSec { get; set; }
    public int? DriftSec { get; set; }
    public bool Completed { get; set; }
}
