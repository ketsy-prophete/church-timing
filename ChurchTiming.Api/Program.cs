using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using ChurchTiming.Api.Contracts;
using ChurchTiming.Api.Data;
using Microsoft.AspNetCore.Mvc;




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

static DateTime AsUtc(DateTime dt) =>
    dt.Kind switch
    {
        DateTimeKind.Utc => dt,
        DateTimeKind.Local => dt.ToUniversalTime(),
        _ => DateTime.SpecifyKind(dt, DateTimeKind.Utc) // Unspecified -> treat as UTC (no shift)
    };

static int SinceMasterStartSec(Run run) =>
    (int)Math.Round((DateTime.UtcNow - AsUtc(run.MasterStartAtUtc!.Value)).TotalSeconds);


static object BuildState(Run run) => new
{
    runId = run.Id,
    serverTimeUtc = DateTime.UtcNow.ToString("o"),
    // masterStartAtUtc = run.MasterStartAtUtc.HasValue
    masterStartUtc = run.MasterStartAtUtc.HasValue
        ? AsUtc(run.MasterStartAtUtc.Value).ToString("o")
        : null,
    masterTargetSec = 22 * 60,
    preteachSec = run.PreteachSec,
    walkBufferSec = run.WalkBufferSec,
    baseOfferingSec = run.BaseOfferingSec,
    spanish = new
    {
        sermonEndEtaSec = run.SpanishSermonEndEtaSec,
        etaUpdatedAtUtc = run.SpanishEtaUpdatedAtUtc.HasValue
            ? AsUtc(run.SpanishEtaUpdatedAtUtc.Value).ToString("o")
            : null,
        sermonEndedAtSec = run.SpanishSermonEndedAtSec,
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

// START a run (broadcast + return state)
app.MapPost("/api/runs/{id:guid}/start",
async (Guid id, AppDbContext db, IHubContext<ServiceSyncHub, ISyncClient> hub) =>
{
    var run = await db.Runs
        .Include(r => r.Segments)
        .FirstOrDefaultAsync(r => r.Id == id);
    if (run is null) return Results.NotFound();

    //you want me to change the below line...
    run.MasterStartAtUtc ??= DateTime.UtcNow;
    await db.SaveChangesAsync();

    // Build current StateDto (use your existing builder if you have one)
    var state = BuildState(run);

    await hub.Clients.Group(id.ToString()).StateUpdated(state); // ← push to both devices
    return Results.Ok(state);
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

// Bulk SAVE (upsert) English segments
app.MapPost("/api/runs/{id:guid}/english/segments",
async (Guid id, SegmentUpsertDto[] payload, AppDbContext db, IHubContext<ServiceSyncHub, ISyncClient> hub) =>
{
    var run = await db.Runs.Include(r => r.Segments).FirstOrDefaultAsync(r => r.Id == id);
    if (run is null) return Results.NotFound();

    // Index existing segments by Id
    var byId = run.Segments.ToDictionary(s => s.Id);

    // Track which server ids are present in the incoming payload
    var seenServerIds = new HashSet<int>();

    foreach (var dto in payload.OrderBy(p => p.Order))
    {
        // Try to map incoming dto.Id (string) to server int id; if parse fails => treat as new
        var hasServerId = int.TryParse(dto.Id, out var serverId) && byId.ContainsKey(serverId);
        if (hasServerId)
        {
            var seg = byId[serverId];
            seg.Order = dto.Order;
            seg.Name = dto.Name;
            seg.PlannedSec = dto.PlannedSec;
            // Do NOT touch seg.ActualSec/Completed on bulk save
            seenServerIds.Add(serverId);
        }
        else
        {
            // New segment
            run.Segments.Add(new RundownSegment
            {
                RunId = id,
                Order = dto.Order,
                Name = dto.Name,
                PlannedSec = dto.PlannedSec,
                // ActualSec, Completed left null/false
            });
        }
    }

    // Remove segments not present in payload, but only if they haven't been completed/timed
    var toRemove = run.Segments
        .Where(s => s.Id != 0) // exclude newly-added (temporary key) rows
        .Where(s => !seenServerIds.Contains(s.Id))
        .Where(s => payload.All(p => !(int.TryParse(p.Id, out var pid) && pid == s.Id)))
        .Where(s => s.ActualSec is null && !s.Completed)
        .ToList();

    db.RemoveRange(toRemove);


    await db.SaveChangesAsync();

    // Broadcast fresh state so all clients (English/Spanish) refresh immediately
    var state = BuildState(run);
    await hub.Clients.Group(id.ToString()).StateUpdated(state);

    return Results.Ok();
});

// Complete a segment (idempotent)
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
        seg.ActualSec ??= (int)Math.Round((DateTime.UtcNow - AsUtc(run.MasterStartAtUtc.Value)).TotalSeconds);
        // ---- compute DriftSec (duration - planned) ----
        var prev = run.Segments
            .Where(s => s.Order < seg.Order && s.Completed && s.ActualSec != null)
            .OrderByDescending(s => s.Order)
            .FirstOrDefault();
        var prevActual = prev?.ActualSec ?? 0;
        // var duration = Math.Max(0, (seg.ActualSec ?? 0) - prevActual);
        // seg.DriftSec = duration - seg.PlannedSec;
        var duration = Math.Max(0, (seg.ActualSec ?? 0) - prevActual);
        seg.DriftSec = seg.PlannedSec - duration;

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
app.MapPost("/api/runs/{id:guid}/spanish/eta",
async (Guid id, [FromBody] int etaSec, AppDbContext db, IHubContext<ServiceSyncHub, ISyncClient> hub) =>
{
    if (etaSec < 0) return Results.BadRequest("etaSec must be >= 0");

    var run = await db.Runs.FindAsync(id);
    if (run is null) return Results.NotFound();

    run.SpanishSermonEndEtaSec = etaSec;          // raw value
    run.SpanishEtaUpdatedAtUtc = DateTime.UtcNow; // timestamp
    await db.SaveChangesAsync();

    // Reload with segments for the broadcast payload
    var stateRun = await db.Runs
        .AsNoTracking()
        .Include(r => r.Segments)
        .FirstAsync(r => r.Id == id);

    var state = BuildState(stateRun);
    await hub.Clients.Group(id.ToString()).StateUpdated(state);
    return Results.Ok(state);
});

// Spanish Ended
app.MapPost("/api/runs/{id:guid}/spanish/ended", async (Guid id, int? endedAtSec, AppDbContext db, IHubContext<ServiceSyncHub, ISyncClient> hub) =>
{
    var run = await db.Runs.FindAsync(id);
    if (run is null || run.MasterStartAtUtc is null) return Results.BadRequest("Run not live or not found");
    var sec = endedAtSec ?? (int)Math.Round((DateTime.UtcNow - AsUtc(run.MasterStartAtUtc.Value)).TotalSeconds);
    run.SpanishSermonEndedAtSec ??= sec;
    await db.SaveChangesAsync();
    var state = await db.Runs.Include(r => r.Segments).Where(r => r.Id == id).Select(r => r).FirstAsync();
    await hub.Clients.Group(id.ToString()).StateUpdated(BuildState(state));
    return Results.Ok(BuildState(state));

});

// 4) (V2 backend only) OVERRIDE SPANISH END ---------------------------------
// app.MapPost("/api/runs/{id:guid}/spanish/ended/override",
// ([FromRoute] Guid id, [FromBody] int endedAtSec,
//  RunRepository repo, IHubContext<ServiceSyncHub, ISyncClient> hub) =>
// {
//     var run = repo.Get(id);
//     if (run is null || run.MasterStartAtUtc is null) return Results.BadRequest("Run not live or not found");

//     run.SermonEndedAtSec = endedAtSec;   // force replace
//     repo.Save(run);
//     return Results.Ok();
// });

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
