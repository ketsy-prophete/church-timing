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

  // SignalrService: add an observable for the offset
  private _offsetMs$ = new BehaviorSubject<number>(0);
  readonly offsetMs$ = this._offsetMs$.asObservable();

  private setOffsetFromServerIso(iso: string) {
    const serverMs = this.parseServerUtc(iso);
    this.serverOffsetMs = serverMs - Date.now();   // correct direction
    this._offsetMs$.next(this.serverOffsetMs);
  }


  readonly masterTargetSec = 5 * 60;
  readonly state$ = new BehaviorSubject<StateDto | null>(null);

  constructor(private http: HttpClient) { }

  serverNowMs() { return Date.now() - this.serverOffsetMs; }
  getServerOffsetMs() { return this.serverOffsetMs; }

  private async refreshState(runId: string) {
    const state = await firstValueFrom(this.http.get<StateDto>(`${this.api}/api/runs/${runId}/state`));
    this.setOffsetFromServerIso(state.serverTimeUtc);
    this.lastSyncAt = Date.now();
    this.state$.next(state);
  }


  // Treat serverTimeUtc as UTC even if it arrives without a timezone (no 'Z')
  // Treat incoming ISO as UTC even if it lacks a timezone
  private parseServerUtc(iso: string): number {
    if (!iso) return Date.now();
    if (/Z|[+\-]\d{2}:\d{2}$/.test(iso)) return Date.parse(iso);
    return Date.parse(iso + 'Z');
  }




  // ==================== START OF Connect =========================//

  async connect(runId: string) {
    console.log('[Connect] called with', runId);

    this.currentRunId = runId;


    // Build once
    if (!this.hub) {
      this.hub = new signalR.HubConnectionBuilder()
        .withUrl(environment.hubUrl, { withCredentials: true })
        .withAutomaticReconnect()
        .build();
      console.log('[Hub] building new connection');


      console.log('[HubSetup] wiring handlers...');

      // ---- wire ALL handlers first ----
      this.hub.on('StateUpdated', (state: StateDto) => {
        this.stopPolling();
        this.lastSyncAt = Date.now();
        this.setOffsetFromServerIso(state.serverTimeUtc);
        console.log('[OffsetCheck]', {
          serverUtc: state.serverTimeUtc,
          localUtc: new Date().toISOString(),
          offsetMs: this.serverOffsetMs,
          offsetMin: (this.serverOffsetMs / 60000).toFixed(2)
        });

        this.state$.next(state);
      });

      this.hub.onreconnecting(() => this.startPolling(this.currentRunId ?? runId));

      this.hub.onreconnected(async () => {
        this.stopPolling();
        const id = this.currentRunId ?? runId;
        if (!id || !this.hub) return;
        try { await this.hub.invoke('JoinRun', id); } catch (e) { console.error('[Hub] re-JoinRun failed', e); return; }
        await this.refreshState(id);
      });

      this.hub.on('Error', (msg: string) => console.error('[Hub Error]', msg));
      this.hub.onclose(() => this.startPolling(this.currentRunId ?? runId));

      // After wiring handlers and before hub.start()
      console.log('[SyncOnce] forcing initial state fetch...');
      try {
        await this.syncOnce(runId);   // reuse that existing helper
        console.log('[SyncOnce] complete');
      } catch (err) {
        console.warn('[SyncOnce] failed', err);
      }

      // ---- now start/connect/JoinRun ----
      if (this.hub.state !== signalR.HubConnectionState.Connected) {
        await this.hub.start();
        console.log('[Hub] connected, waiting for StateUpdated...');
      }
      const id = this.currentRunId ?? runId;
      if (id) {
        try { await this.hub.invoke('JoinRun', id); } catch (e) { console.error('[Hub] initial JoinRun failed', e); }
        await this.refreshState(id);
        this.stopPolling();
      }
    }
  }
  // ==================== END OF Connect =========================//


  // ==================== START OF SyncOnce =========================//
  private async syncOnce(runId: string) {
    const url = `${this.api}/api/runs/${runId}/state`;
    const state = await firstValueFrom(this.http.get<StateDto>(url));
    this.setOffsetFromServerIso(state.serverTimeUtc);
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
      this.setOffsetFromServerIso(s.serverTimeUtc);
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
    interval(250).pipe(startWith(0)),
  ]).pipe(
    map(([s]) => {
      if (!s?.masterStartAtUtc) return 0;

      const startMs = this.parseServerUtc(s.masterStartAtUtc);
      const serverNow = Date.now() - this.serverOffsetMs;   // live server "now"
      const elapsed = Math.max(0, Math.floor((serverNow - startMs) / 1000));
      const target = this.masterTargetSec;                  // 36*60 for now
      return Math.max(0, target - elapsed);
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
