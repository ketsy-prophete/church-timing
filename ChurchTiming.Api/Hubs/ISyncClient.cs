namespace ChurchTiming.Api.Contracts
{
    public interface ISyncClient
    {
        Task RundownUpdated(Guid runId);
        Task SpanishEtaUpdated(Guid runId, int etaSec);
        Task SpanishEnded(Guid runId, int endedAtSec);

        Task StateUpdated(object state);
    }
}
