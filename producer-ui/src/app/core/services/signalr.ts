import { Injectable } from '@angular/core';
import * as signalR from '@microsoft/signalr';
import { BehaviorSubject, combineLatest, interval, map, startWith, Subscription, EMPTY } from 'rxjs';
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


  async connect(runId: string) {
    // If a start() is already in-flight, wait and just (re)join.
    if (this.starting) {
      await this.starting;
      await this.joinRun(runId);
      this.currentRunId = runId;
      this.getState(runId).subscribe(s => this.state$.next(s));
      return;
    }

    if (this.hub && this.hub.state !== signalR.HubConnectionState.Disconnected) {
      // Already connected/reconnecting: (re)join and hydrate; no start() call.
      await this.joinRun(runId);
      this.currentRunId = runId;
      this.getState(runId).subscribe(s => this.state$.next(s));
      return;
    }
    // if already connected/connecting, keep your existing guard logic...
    // (unchanged)

    // Build a new connection if needed
    if (!this.hub) {
      this.hub = new signalR.HubConnectionBuilder()
        .withUrl(environment.hubUrl)
        .withAutomaticReconnect()
        .build();

      // When hub pushes, treat that as "authoritative" and stop polling
      this.hub.on('StateUpdated', (state: StateDto) => {
        this.stopPolling();
        this.lastSyncAt = Date.now();
        this.serverOffsetMs = Date.now() - Date.parse(state.serverTimeUtc);
        this.state$.next(state);
      });

      this.hub.on('Error', (msg: string) => console.error('[Hub Error]', msg));

      // If hub goes away, fall back to polling
      this.hub.onreconnecting(() => this.startPolling(this.currentRunId ?? runId));
      // Build a new connection if needed
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

        // If hub goes away, fall back to polling
        this.hub.onreconnecting(() => this.startPolling(this.currentRunId ?? runId));

        // ⬇️ REPLACE your existing onreconnected line with this:
        this.hub.onreconnected(async () => {
          this.stopPolling();
          if (this.currentRunId) {
            await this.joinRun(this.currentRunId);                 // re-join the group
            this.getState(this.currentRunId).subscribe(s => this.state$.next(s)); // optional one-time refresh
          }
        });

        this.hub.onclose(() => this.startPolling(this.currentRunId ?? runId));
      }

      this.hub.onclose(() => this.startPolling(this.currentRunId ?? runId));
    }

    // Kick off polling **now** so the UI hydrates even before hub connects
    this.startPolling(runId);

    // Start hub (your existing lock logic is fine)
    this.starting = (async () => {
      await this.hub!.start();
      this.connected = true;
    })();
    try { await this.starting; } finally { this.starting = undefined; }

    // Join group + one-time snapshot (keep your existing lines)
    await this.joinRun(runId);
    this.currentRunId = runId;
    this.getState(runId).subscribe(s => this.state$.next(s));
  }


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
  joinRun(runId: string) { return this.hub!.invoke('JoinRun', runId); }
  startRun(runId: string) { return this.hub!.invoke('StartRun', runId); }
  sermonEnded(runId: string) { return this.hub!.invoke('SermonEnded', runId); }
  startOffering(runId: string) { return this.hub!.invoke('StartOffering', runId); }
  completeSegment(runId: string, segmentId: string) {
    return this.hub!.invoke('CompleteSegment', runId, segmentId);
  }
  setSpanishEta(runId: string, etaSec: number) {
    return this.hub!.invoke('SetSpanishEta', runId, etaSec);
  }

  // --------- HTTP endpoints (create/get state) ----------
  createRun(dto: CreateRunDto) {
    return this.http.post<{ runId: string }>(`${environment.apiBaseUrl}/api/runs`, dto);
  }

  getState(runId: string) {
    return this.http.get<StateDto>(`${environment.apiBaseUrl}/api/runs/${runId}/state`);
  }

}
