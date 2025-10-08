using Microsoft.AspNetCore.SignalR;

namespace ChurchTiming.Api.Contracts;

public class ServiceSyncHub : Hub<ISyncClient>
{
    public Task JoinRun(Guid runId) =>
        Groups.AddToGroupAsync(Context.ConnectionId, runId.ToString());

    public Task LeaveRun(Guid runId) =>
        Groups.RemoveFromGroupAsync(Context.ConnectionId, runId.ToString());
}
