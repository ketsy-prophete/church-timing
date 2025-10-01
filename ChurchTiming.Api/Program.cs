using System.Collections.Concurrent;
using Microsoft.AspNetCore.SignalR;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddSignalR();
builder.Services.AddCors(o => o.AddDefaultPolicy(p =>
    p.WithOrigins("http://localhost:4200")
     .AllowAnyHeader()
     .AllowAnyMethod()
     .AllowCredentials()));

builder.Services.AddSingleton<RunRepository>();

var app = builder.Build();
app.UseCors();
app.MapHub<ServiceSyncHub>("/hubs/serviceSync");

// Create a run with preteach/walk/baseOffering and planned segments
app.MapPost("/api/runs", (RunCreateDto dto, RunRepository repo) =>
{
    var run = new RunState
    {
        Id = Guid.NewGuid(),
        Date = DateOnly.FromDateTime(DateTime.UtcNow),
        PreteachSec = dto.PreteachSec,
        WalkBufferSec = dto.WalkBufferSec,
        BaseOfferingSec = dto.BaseOfferingSec <= 0 ? 300 : dto.BaseOfferingSec,
        Status = RunStatus.Draft,
        Segments = dto.Segments?.Select((s, i) => new Segment
        {
            Id = Guid.NewGuid(),
            Order = i + 1,
            Name = s.Name,
            PlannedSec = s.PlannedSec
        }).ToList() ?? new()
    };
    repo.Save(run);
    return Results.Ok(new { runId = run.Id });
});

// Get current state
app.MapGet("/api/runs/{id:guid}/state", (Guid id, RunRepository repo) =>
{
    var run = repo.Get(id);
    return run is null ? Results.NotFound() : Results.Ok(StateDto.From(run));
});

// Start/Close (optional convenience)
app.MapPost("/api/runs/{id:guid}/start", (Guid id, RunRepository repo, IHubContext<ServiceSyncHub, ISyncClient> hub) =>
{
    var run = repo.Get(id); if (run is null) return Results.NotFound();
    if (run.MasterStartAtUtc is null) { run.MasterStartAtUtc = DateTime.UtcNow; run.Status = RunStatus.Live; }
    hub.Clients.Group(ServiceSyncHub.GroupName(id)).StateUpdated(StateDto.From(run));
    return Results.Ok();
});

app.MapPost("/api/runs/{id:guid}/close", (Guid id, RunRepository repo) =>
{
    var run = repo.Get(id); if (run is null) return Results.NotFound();
    run.Status = RunStatus.Closed; return Results.Ok();
});

app.Run();

// ========= Models / Repo / Hub =========
public enum RunStatus { Draft, Live, Closed }

public class RunState
{
    public Guid Id { get; set; }
    public DateOnly Date { get; set; }
    public DateTime? MasterStartAtUtc { get; set; }
    public int PreteachSec { get; set; }
    public int WalkBufferSec { get; set; }
    public int BaseOfferingSec { get; set; } = 300;
    public RunStatus Status { get; set; } = RunStatus.Draft;

    // Spanish
    public int? SermonEndedAtSec { get; set; } // seconds since master start

    // English
    public List<Segment> Segments { get; set; } = new();
    public int? OfferingStartedAtSec { get; set; }
}

public class Segment
{
    public Guid Id { get; set; }
    public int Order { get; set; }
    public string Name { get; set; } = string.Empty;
    public int PlannedSec { get; set; }
    public DateTime? StartAtUtc { get; set; }
    public DateTime? EndAtUtc { get; set; }
    public int? ActualSec { get; set; }
    public int? DriftSec { get; set; }
}

public record RunCreateDto(int PreteachSec, int WalkBufferSec, int BaseOfferingSec, List<SegmentPlanDto>? Segments);
public record SegmentPlanDto(string Name, int PlannedSec);

public class RunRepository
{
    private readonly ConcurrentDictionary<Guid, RunState> _runs = new();
    public RunState? Get(Guid id) => _runs.TryGetValue(id, out var r) ? r : null;
    public void Save(RunState run) => _runs[run.Id] = run;
}

public interface ISyncClient
{
    Task StateUpdated(StateDto state);
    Task Error(string message);
}

public class ServiceSyncHub(RunRepository repo) : Hub<ISyncClient>
{
    public static string GroupName(Guid runId) => $"run:{runId}";

    public async Task JoinRun(Guid runId)
    {
        await Groups.AddToGroupAsync(Context.ConnectionId, GroupName(runId));
        var run = repo.Get(runId);
        if (run is not null)
            await Clients.Caller.StateUpdated(StateDto.From(run));
    }

    public async Task StartRun(Guid runId)
    {
        var run = repo.Get(runId); if (run is null) { await Clients.Caller.Error("Run not found"); return; }
        if (run.MasterStartAtUtc is null) { run.MasterStartAtUtc = DateTime.UtcNow; run.Status = RunStatus.Live; }
        await Clients.Group(GroupName(runId)).StateUpdated(StateDto.From(run));
    }

    public async Task SermonEnded(Guid runId)
    {
        var run = repo.Get(runId); if (run is null || run.MasterStartAtUtc is null) { await Clients.Caller.Error("Run not live"); return; }
        if (run.SermonEndedAtSec is null)
            run.SermonEndedAtSec = (int)Math.Round((DateTime.UtcNow - run.MasterStartAtUtc.Value).TotalSeconds);
        await Clients.Group(GroupName(runId)).StateUpdated(StateDto.From(run));
    }

    public async Task StartOffering(Guid runId)
    {
        var run = repo.Get(runId); if (run is null || run.MasterStartAtUtc is null) { await Clients.Caller.Error("Run not live"); return; }
        if (run.OfferingStartedAtSec is null)
            run.OfferingStartedAtSec = (int)Math.Round((DateTime.UtcNow - run.MasterStartAtUtc.Value).TotalSeconds);
        await Clients.Group(GroupName(runId)).StateUpdated(StateDto.From(run));
    }

    public async Task CompleteSegment(Guid runId, Guid segmentId)
    {
        var run = repo.Get(runId); if (run is null || run.MasterStartAtUtc is null) { await Clients.Caller.Error("Run not live"); return; }

        var segs = run.Segments.OrderBy(s => s.Order).ToList();
        var seg = segs.FirstOrDefault(s => s.Id == segmentId);
        if (seg is null) { await Clients.Caller.Error("Segment not found"); return; }

        if (seg.EndAtUtc is null)
        {
            var idx = segs.FindIndex(s => s.Id == segmentId);
            var prevEnd = idx > 0 ? (segs[idx - 1].EndAtUtc ?? run.MasterStartAtUtc) : run.MasterStartAtUtc;

            seg.StartAtUtc ??= prevEnd; // start = previous segment's end (or master start)
            seg.EndAtUtc = DateTime.UtcNow;

            seg.ActualSec = (int)Math.Round((seg.EndAtUtc.Value - seg.StartAtUtc.Value).TotalSeconds);
            seg.DriftSec = seg.ActualSec - seg.PlannedSec;
        }

        await Clients.Group(GroupName(runId)).StateUpdated(StateDto.From(run));
    }

}

public record StateDto(
    Guid RunId,
    DateTime ServerTimeUtc,
    DateTime? MasterStartAtUtc,
    int PreteachSec,
    int WalkBufferSec,
    int BaseOfferingSec,
    SpanishDto Spanish,
    EnglishDto English,
    OfferingSuggestionDto OfferingSuggestion)
{
    public static StateDto From(RunState r)
    {
        var serverNow = DateTime.UtcNow;
        var runningDrift = r.Segments
            .Where(s => s.DriftSec is not null)
            .Sum(s => s.DriftSec!.Value);

        var stretch = ComputeStretch(r.SermonEndedAtSec, r.WalkBufferSec, r.OfferingStartedAtSec, r.BaseOfferingSec, r.PreteachSec);

        return new StateDto(
            r.Id,
            serverNow,
            r.MasterStartAtUtc,
            r.PreteachSec,
            r.WalkBufferSec,
            r.BaseOfferingSec,
            new SpanishDto(r.SermonEndedAtSec),
            new EnglishDto(
                r.Segments.Select(s => new SegmentDto(s.Id, s.Order, s.Name, s.PlannedSec, s.ActualSec, s.DriftSec, s.EndAtUtc is not null)).ToList(),
                runningDrift,
                r.OfferingStartedAtSec
            ),
            new OfferingSuggestionDto(stretch, r.BaseOfferingSec + stretch)
        );
    }

    static int ComputeStretch(int? sermonEnd, int walkBufferSec, int? offeringStart, int baseOfferingSec, int preteachSec)
    {
        if (sermonEnd is null || offeringStart is null) return 0;
        var targetArrival = sermonEnd.Value + walkBufferSec;
        var endOfOfferingPlusPreteach = offeringStart.Value + baseOfferingSec + preteachSec;
        return Math.Max(0, targetArrival - endOfOfferingPlusPreteach);
    }
}

public record SpanishDto(int? SermonEndedAtSec);
public record EnglishDto(List<SegmentDto> Segments, int RunningDriftBeforeOfferingSec, int? OfferingStartedAtSec);
public record SegmentDto(Guid Id, int Order, string Name, int PlannedSec, int? ActualSec, int? DriftSec, bool Completed);
public record OfferingSuggestionDto(int StretchSec, int OfferingTargetSec);