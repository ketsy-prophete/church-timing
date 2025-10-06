using Microsoft.EntityFrameworkCore;

namespace ChurchTiming.Api.Data;

public class AppDbContext : DbContext
{
    public AppDbContext(DbContextOptions<AppDbContext> options) : base(options) { }

    public DbSet<Run> Runs => Set<Run>();
    public DbSet<RundownSegment> Segments => Set<RundownSegment>();
}
