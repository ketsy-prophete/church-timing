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
  spanish: { sermonEndedAtSec?: number; sermonEndEtaSec?: number };
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
  private connected = false;
  private starting?: Promise<void>;
  private currentRunId?: string;

  private serverOffsetMs = 0;
  private lastSyncAt = Date.now();
  private pollSub?: Subscription;

  readonly masterTargetSec = 36 * 60;
  readonly state$ = new BehaviorSubject<StateDto | null>(null);

  constructor(private http: HttpClient) { }

  serverNowMs() { return Date.now() - this.serverOffsetMs; }

  // ==================== START OF Connect =========================//

  async connect(runId: string) {
    this.currentRunId = runId;

    // Build once
    if (!this.hub) {
      this.hub = new signalR.HubConnectionBuilder()
        .withUrl(environment.hubUrl)
        .withAutomaticReconnect()
        .build();

      this.hub.on('StateUpdated', (state: StateDto) => {
        this.stopPolling();
        this.lastSyncAt = Date.now();
        this.serverOffsetMs = Date.now() - Date.parse(state.serverTimeUtc);
        this.state$.next(state);
      });

      this.hub.on('Error', (msg: string) => console.error('[Hub Error]', msg));

      // Fallbacks & recovery
      this.hub.onreconnecting(() => this.startPolling(this.currentRunId ?? runId));
      this.hub.onreconnected(async () => {
        this.stopPolling();
        if (this.currentRunId) {
          // rejoin group after a reconnect, then hydrate
          await this.joinRun(this.currentRunId);
          await this.syncOnce(this.currentRunId);
        }
      });
      this.hub.onclose(() => this.startPolling(this.currentRunId ?? runId));
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
          this.connected = true;
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
    }

    // Connected: stop polling, join group, do one REST sync
    this.stopPolling();
    await this.joinRun(runId);
    await this.syncOnce(runId);
  }
  // ==================== END OF Connect =========================//


  // ==================== START OF SyncOnce =========================//
  private async syncOnce(runId: string) {
    const url = `${environment.apiBaseUrl}/api/runs/${runId}/state`;
    const state = await firstValueFrom(this.http.get<StateDto>(url));
    this.lastSyncAt = Date.now();
    this.serverOffsetMs = Date.now() - Date.parse(state.serverTimeUtc);
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
      this.connected = false;
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
      this.lastSyncAt = Date.now();
      this.serverOffsetMs = Date.now() - Date.parse(s.serverTimeUtc);
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
  joinRun(runId: string) { return this.hub!.invoke('JoinRun', runId); }


  startRun(runId: string) {
    return firstValueFrom(this.http.post(`${environment.apiBaseUrl}/api/runs/${runId}/start`, {}));
  }
  sermonEnded(runId: string) {
    return firstValueFrom(this.http.post(`${environment.apiBaseUrl}/api/runs/${runId}/spanish/ended`, {}));
  }
  startOffering(runId: string) {
    return firstValueFrom(this.http.post(`${environment.apiBaseUrl}/api/runs/${runId}/offering/start`, {}));
  }
  completeSegment(runId: string, segmentId: string) {
    return firstValueFrom(this.http.post(`${environment.apiBaseUrl}/api/runs/${runId}/segments/${segmentId}/complete`, {}));
  }
  setSpanishEta(runId: string, etaSec: number) {
    return firstValueFrom(this.http.post(
      `${environment.apiBaseUrl}/api/runs/${runId}/spanish/eta?etaSec=${etaSec}`, {}));
  }

  createRun(dto: CreateRunDto) {
    return this.http.post<{ runId: string }>(`${environment.apiBaseUrl}/api/runs`, dto);
  }

  getState(runId: string) {
    return this.http.get<StateDto>(`${environment.apiBaseUrl}/api/runs/${runId}/state`);
  }
}
