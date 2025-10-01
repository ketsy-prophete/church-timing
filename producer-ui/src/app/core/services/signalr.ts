import { Injectable } from '@angular/core';
import * as signalR from '@microsoft/signalr';
import { BehaviorSubject, combineLatest, interval, map, startWith } from 'rxjs';
import { environment } from '../../../environments/environment';

export interface SegmentDto { id: string; order: number; name: string; plannedSec: number; actualSec?: number; driftSec?: number; completed: boolean; }
export interface StateDto {
  runId: string;
  serverTimeUtc: string;
  masterStartAtUtc?: string;
  preteachSec: number;
  walkBufferSec: number;
  baseOfferingSec: number;
  spanish: { sermonEndedAtSec?: number };
  english: { segments: SegmentDto[]; runningDriftBeforeOfferingSec: number; offeringStartedAtSec?: number };
  offeringSuggestion: { stretchSec: number; offeringTargetSec: number };
}

@Injectable({ providedIn: 'root' })
export class SignalrService {
  private hub?: signalR.HubConnection;
  readonly state$ = new BehaviorSubject<StateDto | null>(null);
  private connected = false;

  private serverOffsetMs = 0;   // <- singular
  private lastSyncAt = Date.now();
  readonly masterTargetSec = 35 * 60;

  serverNowMs() { return Date.now() - this.serverOffsetMs; }
  
  async connect(runId: string) {
    if (this.connected) return;

    this.hub = new signalR.HubConnectionBuilder()
      .withUrl(environment.hubUrl)
      .withAutomaticReconnect()
      .build();

    // Single handler (updates offset + state)
    this.hub.on('StateUpdated', (state: StateDto) => {
      this.lastSyncAt = Date.now();
      this.serverOffsetMs = Date.now() - Date.parse(state.serverTimeUtc);
      this.state$.next(state);
    });
    this.hub.on('Error', (msg: string) => console.warn('Hub error:', msg));

    await this.hub.start();
    await this.hub.invoke('JoinRun', runId);
    this.connected = true;
  }

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
      const serverNow = Date.now() - this.serverOffsetMs;
      const elapsed = Math.floor((serverNow - Date.parse(s.masterStartAtUtc)) / 1000);
      return this.masterTargetSec - elapsed;
    })
  );

  startRun(runId: string) { return this.hub!.invoke('StartRun', runId); }
  sermonEnded(runId: string) { return this.hub!.invoke('SermonEnded', runId); }
  startOffering(runId: string) { return this.hub!.invoke('StartOffering', runId); }
  completeSegment(runId: string, segmentId: string) {
    return this.hub!.invoke('CompleteSegment', runId, segmentId);
  }
}
