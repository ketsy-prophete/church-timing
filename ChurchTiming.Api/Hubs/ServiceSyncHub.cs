using Microsoft.AspNetCore.SignalR;

namespace ChurchTiming.Api.Contracts;

public class ServiceSyncHub : Hub<ISyncClient> { }
