using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using ChurchTiming.Api.Contracts;
using ChurchTiming.Api.Data;

var builder = WebApplication.CreateBuilder(args);

// 1) Services
builder.Services.AddDbContext<AppDbContext>(opt =>
    opt.UseSqlite(builder.Configuration.GetConnectionString("Default")));

// ---- CORS (DEV-ONLY: allow any origin + credentials) ----
// CORS must be registered BEFORE Build()
const string CorsPolicy = "ui";

builder.Services.AddCors(o => o.AddPolicy(CorsPolicy, p =>
{
    p.SetIsOriginAllowed(_ => true)  // allow ANY origin (dev)
    .AllowAnyHeader()
    .AllowAnyMethod()
    .AllowCredentials();
}));

builder.Services.AddControllers();
builder.Services.AddSignalR();

var app = builder.Build();

app.UseRouting();

// REMOVE app.MapHub<ServiceSyncHub>("/hubs/serviceSync"); 

// 2) Middleware
app.UseCors(CorsPolicy);

//REMOVE // Controllers + Hub both require the same policy
// app.MapControllers().RequireCors(CorsPolicy);

//REMOVE // 3) Hub
// app.MapHub<ServiceSyncHub>("/hubs/serviceSync").RequireCors(CorsPolicy);

static int SinceMasterStartSec(Run run) =>
    (int)Math.Round((DateTime.UtcNow - run.MasterStartAtUtc!.Value).TotalSeconds);


static object BuildState(Run run) => new
{
    runId = run.Id,
    serverTimeUtc = DateTime.UtcNow.ToUniversalTime(),
    masterStartAtUtc = run.MasterStartAtUtc,
    preteachSec = run.PreteachSec,
    walkBufferSec = run.WalkBufferSec,
    baseOfferingSec = run.BaseOfferingSec,
    spanish = new
    {
        sermonEndedAtSec = run.SpanishSermonEndedAtSec,
        sermonEndEtaSec = run.SpanishSermonEndEtaSec
    },
    english = new
    {
        segments = run.Segments
            .OrderBy(s => s.Order)
            .Select(s => new
            {
                id = s.Id,
                order = s.Order,
                name = s.Name,
                plannedSec = s.PlannedSec,
                actualSec = s.ActualSec,
                driftSec = s.DriftSec,
                completed = s.Completed
            }).ToArray(),
        runningDriftBeforeOfferingSec = run.Segments
            .Where(s => s.Completed)
            .Sum(s => (int?)s.DriftSec ?? 0),
        offeringStartedAtSec = run.EnglishOfferingStartedAtSec
    },
    offeringSuggestion = new { stretchSec = 0, offeringTargetSec = run.BaseOfferingSec }
};


// ---- Endpoints (EF-only) ----

// CREATE a run
app.MapPost("/api/runs", async (RunCreateDto dto, AppDbContext db) =>
{
    var run = new Run
    {
        PreteachSec = dto.preteachSec,
        WalkBufferSec = dto.walkBufferSec,
        BaseOfferingSec = dto.baseOfferingSec <= 0 ? 300 : dto.baseOfferingSec
    };
    db.Runs.Add(run);
    await db.SaveChangesAsync();
    return Results.Ok(new { runId = run.Id });
});

// START a run
app.MapPost("/api/runs/{id:guid}/start", async (Guid id, AppDbContext db) =>
{
    var run = await db.Runs.FindAsync(id);
    if (run is null) return Results.NotFound();
    run.MasterStartAtUtc ??= DateTime.UtcNow;
    await db.SaveChangesAsync();
    return Results.Ok();
});

// STATE
app.MapGet("/api/runs/{id:guid}/state", async (Guid id, AppDbContext db) =>
{
    var run = await db.Runs.Include(r => r.Segments).FirstOrDefaultAsync(r => r.Id == id);
    if (run is null) return Results.NotFound();

    return Results.Ok(BuildState(run));
});

// GET rundown
app.MapGet("/api/runs/{id:guid}/rundown", async (Guid id, AppDbContext db) =>
{
    var exists = await db.Runs.AnyAsync(r => r.Id == id);
    if (!exists) return Results.NotFound();

    var segments = await db.Segments
        .Where(s => s.RunId == id)
        .OrderBy(s => s.Order)
        .Select(s => new RundownSegmentDto(s.Id, s.Order, s.Name, s.PlannedSec, s.ActualSec, s.DriftSec, s.Completed))
        .ToListAsync();

    return Results.Ok(segments);
});

// SAVE rundown (replace all)
app.MapPost("/api/runs/{id:guid}/rundown/save", async (Guid id, List<RundownSegmentSaveDto> items, AppDbContext db, IHubContext<ServiceSyncHub, ISyncClient> hub) =>
{
    var run = await db.Runs.Include(r => r.Segments).FirstOrDefaultAsync(r => r.Id == id);
    if (run is null) return Results.NotFound();

    using var tx = await db.Database.BeginTransactionAsync();
    db.Segments.RemoveRange(run.Segments);
    await db.SaveChangesAsync();

    var newSegs = items.Select((it, i) => new RundownSegment
    {
        RunId = id,
        Order = it.order ?? i,
        Name = it.name ?? "",
        PlannedSec = it.plannedSec,
        ActualSec = it.actualSec,
        DriftSec = it.driftSec,
        Completed = it.completed ?? false
    });
    await db.Segments.AddRangeAsync(newSegs);
    await db.SaveChangesAsync();
    await tx.CommitAsync();

    await hub.Clients.All.RundownUpdated(id);
    return Results.Ok();
});

// 1) Complete a segment (idempotent)
// Route: note :int on segmentId
app.MapPost("/api/runs/{id:guid}/english/segments/{segmentId:int}/complete",
async (Guid id, int segmentId, AppDbContext db, IHubContext<ServiceSyncHub, ISyncClient> hub) =>
{
    var run = await db.Runs.Include(r => r.Segments).FirstOrDefaultAsync(r => r.Id == id);
    if (run is null || run.MasterStartAtUtc is null) return Results.BadRequest("Run not live or not found");

    var seg = run.Segments.FirstOrDefault(s => s.Id == segmentId); // int == int ✅
    if (seg is null) return Results.NotFound();

    if (!seg.Completed)
    {
        seg.Completed = true;
        seg.ActualSec ??= (int)Math.Round((DateTime.UtcNow - run.MasterStartAtUtc.Value).TotalSeconds);
        await db.SaveChangesAsync();
        await hub.Clients.Group(id.ToString()).StateUpdated(BuildState(run));
    }
    return Results.Ok();
});

// 2) Start offering (idempotent)
app.MapPost("/api/runs/{id:guid}/english/offering/start",
async (Guid id, AppDbContext db, IHubContext<ServiceSyncHub, ISyncClient> hub) =>
{
    var run = await db.Runs
        .Include(r => r.Segments)
        .FirstOrDefaultAsync(r => r.Id == id);

    if (run is null || run.MasterStartAtUtc is null)
        return Results.BadRequest("Run not live or not found");

    if (run.EnglishOfferingStartedAtSec is null)
    {
        run.EnglishOfferingStartedAtSec = SinceMasterStartSec(run);
        await db.SaveChangesAsync();
        var state = BuildState(run!);
        await hub.Clients.Group(id.ToString()).StateUpdated(state);
    }

    return Results.Ok();
});

// Spanish ETA
app.MapPost("/api/runs/{id:guid}/spanish/eta", async (Guid id, int etaSec, AppDbContext db, IHubContext<ServiceSyncHub, ISyncClient> hub) =>
{
    var run = await db.Runs.FindAsync(id);
    if (run is null) return Results.NotFound();
    run.SpanishSermonEndEtaSec = etaSec;
    await db.SaveChangesAsync();
    await hub.Clients.Group(id.ToString()).SpanishEtaUpdated(id, etaSec);
    return Results.Ok();
});

// Spanish Ended
app.MapPost("/api/runs/{id:guid}/spanish/ended", async (Guid id, int? endedAtSec, AppDbContext db, IHubContext<ServiceSyncHub, ISyncClient> hub) =>
{
    var run = await db.Runs.FindAsync(id);
    if (run is null || run.MasterStartAtUtc is null) return Results.BadRequest("Run not live or not found");
    var sec = endedAtSec ?? (int)Math.Round((DateTime.UtcNow - run.MasterStartAtUtc.Value).TotalSeconds);
    run.SpanishSermonEndedAtSec ??= sec;
    await db.SaveChangesAsync();
    await hub.Clients.Group(id.ToString()).SpanishEnded(id, run.SpanishSermonEndedAtSec.Value);
    return Results.Ok(new { sermonEndedAtSec = run.SpanishSermonEndedAtSec });
});

// Utility/health
app.MapGet("/ping", () => Results.Ok(new { ok = true, time = DateTime.UtcNow }));
app.MapGet("/", () => Results.Text("root ok"));
app.MapGet("/health", () => Results.Text("ok"));

// DB smoke test
app.MapGet("/__db/ok", async (AppDbContext db) =>
{
    var count = await db.Runs.CountAsync();
    return Results.Ok(new { ok = true, runs = count });
});

//Dev HUD

app.MapGet("/__hud/{id:guid}", async (Guid id, AppDbContext db) =>
{
    var run = await db.Runs.Include(r => r.Segments).FirstOrDefaultAsync(r => r.Id == id);
    if (run is null) return Results.NotFound("Run not found");
    var segs = string.Join(", ", run.Segments.OrderBy(s => s.Order).Select(s => $"{s.Order}:{s.Name}({s.PlannedSec}s)"));
    return Results.Text(
        $"RUN {run.Id}\nStartUtc: {run.MasterStartAtUtc?.ToString("u") ?? "-"}\nOffering: {run.BaseOfferingSec}s\nSpanish(eta/end): {run.SpanishSermonEndEtaSec}/{run.SpanishSermonEndedAtSec}\nSegments: [{segs}]",
        "text/plain");
});

app.MapControllers();
app.MapHub<ServiceSyncHub>("/hubs/serviceSync");

app.Run();

