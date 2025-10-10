import { Injectable } from '@angular/core';
import * as signalR from '@microsoft/signalr';
import { BehaviorSubject, combineLatest, interval, map, startWith, Subscription, EMPTY, firstValueFrom } from 'rxjs';
import { HttpClient } from '@angular/common/http';
import { environment } from '../../../environments/environment';
import { switchMap, catchError } from 'rxjs/operators';

export interface SegmentDto { id: string; order: number; name: string; plannedSec: number; actualSec?: number; driftSec?: number; completed: boolean; }

export interface StateDto {
  runId: string;
  serverTimeUtc: string;               // ISO string from backend
  masterStartAtUtc?: string;
  preteachSec: number;
  walkBufferSec: number;
  baseOfferingSec: number;
  spanish: { sermonEndedAtSec?: number; sermonEndEtaSec?: number; etaUpdatedAtUtc?: string };
  english: { segments: SegmentDto[]; runningDriftBeforeOfferingSec: number; offeringStartedAtSec?: number };
  offeringSuggestion: { stretchSec: number; offeringTargetSec: number };
}

export interface CreateRunDto {
  preteachSec: number;
  walkBufferSec: number;
  baseOfferingSec: number;
  segments?: { name: string; plannedSec: number }[];
}

@Injectable({ providedIn: 'root' })
export class SignalrService {
  private hub?: signalR.HubConnection;
  // private connected = false;
  private starting?: Promise<void>;
  private currentRunId?: string;
  private api = environment.apiBaseUrl;

  private serverOffsetMs = 0;
  private lastSyncAt = Date.now();
  private pollSub?: Subscription;

  readonly masterTargetSec = 36 * 60;
  readonly state$ = new BehaviorSubject<StateDto | null>(null);

  constructor(private http: HttpClient) { }

  serverNowMs() { return Date.now() - this.serverOffsetMs; }



  private async refreshState(runId: string) {
    const state = await firstValueFrom(this.http.get<StateDto>(`${this.api}/api/runs/${runId}/state`));
    this.serverOffsetMs = Date.now() - Date.parse(state.serverTimeUtc);
    this.lastSyncAt = Date.now();
    this.state$.next(state);
  }


  // ==================== START OF Connect =========================//

  async connect(runId: string) {
    const previousRunId = this.currentRunId;
    this.currentRunId = runId;


    // Build once
    if (!this.hub) {
      this.hub = new signalR.HubConnectionBuilder()
        .withUrl(environment.hubUrl, { withCredentials: true })
        .withAutomaticReconnect()
        .build();

      // If hub goes away, fall back to polling
      this.hub.onreconnecting(() => this.startPolling(this.currentRunId ?? runId));

      if (this.hub.state !== signalR.HubConnectionState.Connected) {
        await this.hub.start();
      }

      const id = this.currentRunId ?? runId;
      if (id) {
        try { await this.hub.invoke('JoinRun', id); } catch (e) { console.error('[Hub] initial JoinRun failed', e); }
        await this.refreshState(id);   // ← fetch immediately after subscribe
        this.stopPolling();            // ← prefer push if we’re live
      }

      this.hub.on('StateUpdated', (state: StateDto) => {
        this.stopPolling();                              // prefer push when hub is live
        this.serverOffsetMs = Date.now() - Date.parse(state.serverTimeUtc);
        this.lastSyncAt = Date.now();
        this.state$.next(state);                         // update UI
      });



      this.hub.onreconnected(async () => {
        this.stopPolling();
        const id = this.currentRunId ?? runId;
        if (!id || !this.hub) return;                 // guard runId & hub
        try { await this.hub.invoke('JoinRun', id); } catch (e) { console.error('[Hub] re-JoinRun failed', e); return; }
        await this.refreshState(id);                  // ← fetch right after re-subscribe
      });



      this.hub.on('Error', (msg: string) => console.error('[Hub Error]', msg));


      this.hub.onclose(() => this.startPolling(this.currentRunId ?? runId));
    }

    // If the route runId changed while connected, swap groups cleanly
    if (previousRunId && previousRunId !== runId && this.hub?.state === signalR.HubConnectionState.Connected) {
      try { await this.hub.invoke('LeaveRun', previousRunId); } catch { }
      try { await this.hub.invoke('JoinRun', runId); } catch (e) { console.error('[Hub] subscribe (run change) failed', e); }
      await this.refreshState(runId);
      this.stopPolling();
    }

    // If a start() is already in-flight, wait for it
    if (this.hub.state === signalR.HubConnectionState.Connecting && this.starting) {
      await this.starting;
    }

    // If not connected yet, start and hydrate via polling while we wait
    if (this.hub.state !== signalR.HubConnectionState.Connected) {
      if (!this.starting) {
        this.starting = (async () => {
          await this.hub!.start();
        })();
      }

      // Hydrate UI while hub connects
      this.startPolling(runId);

      try {
        await this.starting;
      } catch (err) {
        console.error('[SignalR] start failed', err);
        // Keep polling; bail early
        this.starting = undefined;
        return;
      } finally {
        this.starting = undefined;
      }

      // Once connected, subscribe + refresh to finalize real-time
      try { await this.hub.invoke('JoinRun', runId); } catch (e) { console.error('[Hub] post-start JoinRun failed', e); }
      await this.refreshState(runId);
      this.stopPolling();
    }
  }
  // ==================== END OF Connect =========================//


  // ==================== START OF SyncOnce =========================//
  private async syncOnce(runId: string) {
    const url = `${this.api}/api/runs/${runId}/state`;
    const state = await firstValueFrom(this.http.get<StateDto>(url));
    this.serverOffsetMs = Date.now() - Date.parse(state.serverTimeUtc);
    this.lastSyncAt = Date.now();
    this.state$.next(state);
  }

  // ==================== END OF SyncOnce =========================//


  // Add to SignalrService (below connect/fields)
  async disconnect() {
    this.stopPolling();

    if (!this.hub) return;
    try {
      await this.hub.stop();
    } catch (e) {
      console.warn('[Hub] stop failed (safe to ignore in dev):', e);
    } finally {
      this.currentRunId = undefined;
      this.starting = undefined;
      this.hub = undefined; // drop the instance so a fresh connect() will rebuild it
    }
  }

  // start a lightweight /state poller
  private startPolling(runId: string, ms = 1000) {
    this.stopPolling();
    this.pollSub = interval(ms).pipe(
      startWith(0),
      switchMap(() => this.getState(runId)),
      catchError(err => { console.warn('[poll] state fetch failed', err); return EMPTY; })
    ).subscribe(s => {
      if (!s) return;
      this.serverOffsetMs = Date.now() - Date.parse(s.serverTimeUtc); // ← correct sign + uses 's'
      this.lastSyncAt = Date.now();
      this.state$.next(s);
    });
  }


  private stopPolling() {
    this.pollSub?.unsubscribe();
    this.pollSub = undefined;
  }



  // --------- Derived streams ----------
  readonly isLive$ = this.state$.pipe(map(s => !!s?.masterStartAtUtc));

  readonly lastSyncAgo$ = interval(1000).pipe(
    startWith(0),
    map(() => Math.max(0, Math.floor((Date.now() - this.lastSyncAt) / 1000)))
  );

  readonly masterCountdown$ = combineLatest([
    this.state$,
    interval(250).pipe(startWith(0))
  ]).pipe(
    map(([s]) => {
      if (!s?.masterStartAtUtc) return null;
      const serverNow = this.serverNowMs();
      const elapsed = Math.floor((serverNow - Date.parse(s.masterStartAtUtc)) / 1000);
      return this.masterTargetSec - elapsed;
    })
  );

  // --------- Client → Server hub methods (names must match backend) ----------
  // joinRun used to join the SignalR group
  joinRun(runId: string) { return this.hub ? this.hub.invoke('JoinRun', runId) : Promise.resolve(); }


  async startRun(runId: string) {
    await firstValueFrom(this.http.post(`${this.api}/api/runs/${runId}/start`, {}));
    try { await this.refreshState(runId); } catch { }
  }
  async sermonEnded(runId: string) {
    await firstValueFrom(this.http.post(`${this.api}/api/runs/${runId}/spanish/ended`, {}));
    try { await this.refreshState(runId); } catch { }
  }

  async startOffering(runId: string) {
    await firstValueFrom(this.http.post(`${this.api}/api/runs/${runId}/english/offering/start`, {}));
    try { await this.refreshState(runId); } catch { }
  }

  async completeSegment(runId: string, segmentId: string) {
    await firstValueFrom(this.http.post(`${this.api}/api/runs/${runId}/english/segments/${segmentId}/complete`, {}));
    try { await this.refreshState(runId); } catch { }
  }
  async setSpanishEta(runId: string, etaSec: number) {
    await firstValueFrom(
      this.http.post(`${this.api}/api/runs/${runId}/spanish/eta`, etaSec, {
        headers: { 'Content-Type': 'application/json' }
      })
    );
    try { await this.refreshState(runId); } catch { }
  }

  createRun(dto: CreateRunDto) {
    return this.http.post<{ runId: string }>(`${this.api}/api/runs`, dto);
  }

  getState(runId: string) {
    return this.http.get<StateDto>(`${this.api}/api/runs/${runId}/state`);
  }
}
