namespace ChurchTiming.Api.Contracts
{
    public interface ISyncClient
    {
        Task RundownUpdated(Guid runId);
        Task SpanishEtaUpdated(Guid runId, int etaSec);
        Task SpanishEnded(Guid runId, int endedAtSec);

        // Add this so Program.cs can push the full state/ unified broadcast
        Task StateUpdated(object state);
    }
}
