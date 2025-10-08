using System.ComponentModel.DataAnnotations;

namespace ChurchTiming.Api.Data;

public class Run
{
    [Key] public Guid Id { get; set; } = Guid.NewGuid();
    public DateTime CreatedUtc { get; set; } = DateTime.UtcNow;
    public DateTime? MasterStartAtUtc { get; set; }
    public int PreteachSec { get; set; }
    public int WalkBufferSec { get; set; }
    public int BaseOfferingSec { get; set; }
    public int? EnglishOfferingStartedAtSec { get; set; }
    public int? SpanishSermonEndedAtSec { get; set; }
    public int? SpanishSermonEndEtaSec { get; set; }
    public List<RundownSegment> Segments { get; set; } = new();
}
