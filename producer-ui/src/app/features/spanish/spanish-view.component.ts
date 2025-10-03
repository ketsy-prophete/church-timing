// src/app/features/spanish/spanish-view.ts
import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute } from '@angular/router';
import { SignalrService } from '../../core/services/signalr';
import { TimePipe } from '../../shared/time.pipe';
import { SignedTimePipe } from '../../shared/signed-time.pipe';
import { Observable, interval, map, startWith, combineLatest } from 'rxjs';
import type { StateDto as BaseStateDto } from '../../core/services/signalr';

type StateDto = BaseStateDto & {
  spanish: BaseStateDto['spanish'] & {
    sermonEndEtaSec?: number;  // locally add the ETA field
  };
};


@Component({
  standalone: true,
  selector: 'app-spanish-view',
  imports: [CommonModule, TimePipe, SignedTimePipe],
  styles: [`
    .titlebar { display:flex; align-items:center; }
    .clock { margin-left:auto; font-weight:600; white-space:nowrap; }
    .bar{display:flex;gap:12px;align-items:center;margin:8px 0}
    .dot{width:8px;height:8px;border-radius:50%;background:#bbb;display:inline-block;margin-left:6px}
    .dot.live{background:#2ecc71;animation:pulse 1s infinite}
    @keyframes pulse{0%{opacity:.4}50%{opacity:1}100%{opacity:.4}}
    table{border-collapse:collapse}
    th,td{padding:6px 8px;border:1px solid #ccc}
    .highlight { background:#d0d0d0; transition: background-color 300ms ease-in-out; }
    .dot.ended { background:#e53935; animation:none; }  /* solid red, no pulse */
    .time-red { color:#e53935; }                         /* 00:00 in red */
    .over{color:#16a34a}.under{color:#dc2626}
    .clock-time { font-weight:700; font-size:20px;}
    .clock-date { font-weight:500; font-size:12px; opacity:.8; line-height:1.99; }

  `],
  template: `
  <div style="padding:16px; font-family:system-ui">
    <div class="titlebar">
      <h2>Spanish Producer</h2>
      <div class="clock">
        <div class="clock-time">{{ etNow$ | async }} ET</div>
        <div class="clock-date">{{ etDate$ | async }}</div>
      </div>
  </div>

    <!-- Live status / master countdown -->
    <div class="bar" *ngIf="vm$ | async as vm">
      <ng-container *ngIf="vm.s?.masterStartAtUtc; else notStarted">
        <span class="dot"
              [class.live]="vm.mc > 0"
              [class.ended]="vm.mc <= 0"></span>

        <b [class.time-red]="vm.mc <= 0">
          Master Timer – {{ (vm.mc > 0 ? vm.mc : 0) | mmss }}
        </b>

        <small *ngIf="(hub.lastSyncAgo$ | async) as secs">
          Live • Updated
          <ng-container *ngIf="secs < 60">&lt;1m</ng-container>
          <ng-container *ngIf="secs >= 60">{{ (secs/60) | number:'1.0-0' }}m</ng-container>
          ago
        </small>
      </ng-container>

      <ng-template #notStarted><b>Master Timer Pending Start</b></ng-template>
    </div>
    

    <div *ngIf="state as s">

      <h3 style="margin-top:12px">Completed in English</h3>
      <table>
        <tr>
          <th>#</th>
          <th>Segment</th>
          <th>Segment Drift</th>
          <th>Total Drift</th>
          <th>Status</th>
          <th>Ended</th>   
        </tr>

        <tr *ngFor="let row of completedEnglishWithRunning; let idx = index"
            [class.highlight]="row.seg.id === lastCompletedId">
          <td>{{ row.seg.order }}</td>
          <td>{{ row.seg.name }}</td>

          <td>{{ row.seg.driftSec | signedmmss }}</td>

          <td [style.color]="row.running > 4 ? 'black' : row.running < -4 ? 'red' : 'inherit'">
            {{ row.running | signedmmss:true }}
          </td>
         
          <td>Complete</td>

        <td>
          {{ endedAtFor(row.seg.id, completedEnglishSorted) | date:'h:mm a':'America/New_York' }}
        </td>

        </tr>
      </table>

<!-- Bottom controls: place right under the table -->
<div style="margin-top:8px;">

  <!-- LINE 1: Spanish ETA form + Current ETA (blue) -->
  <div>
    <label>Spanish ETA (mm:ss):
      <input #eta size="5" placeholder="mm:ss"
             (keyup.enter)="setSpanishEtaFromText(eta.value)">
    </label>
    <button type="button"
            style="margin-left:12px;"
            (click)="setSpanishEtaFromText(eta.value)"
            [disabled]="!state?.masterStartAtUtc">
      Set ETA
    </button>
    <button type="button"
            style="margin-left:12px;"
            (click)="setSpanishEtaPlus(30)"
            [disabled]="!state?.masterStartAtUtc">
      +30s
    </button>
    <button type="button"
            style="margin-left:12px;"
            (click)="setSpanishEtaPlus(60)"
            [disabled]="!state?.masterStartAtUtc">
      +60s
    </button>

    <!-- Current ETA (blue), spaced after +60s -->
    <span style="margin-left:12px; opacity:.95;">
      <span style="color:#1e40af; font-weight:700; font-size:13px">Current Eta: </span>
      <ng-container *ngIf="$any(state?.spanish)?.sermonEndEtaSec as etaSec; else noneEta">
        <span style="color:#1e40af; font-weight:700; font-size:13px">{{ etaSec | mmss }}</span>
      </ng-container>
      <ng-template #noneEta>—</ng-template>
    </span>
  </div>

  <!-- LINE 2: Sermon End button (double spacing below the form) -->
  <div style="margin-top:16px;">
    <button (click)="sermonEnd()"
            [disabled]="sermonEndClicked || (state?.spanish?.sermonEndedAtSec ?? 0) > 0">
      Sermon End
    </button>
  </div>

  <!-- LINE 3: Sermon Ended At (single spacing) -->
  <p style="margin:8px 0 0 0;">
    <b>Sermon Ended At:</b>
    {{ state?.spanish?.sermonEndedAtSec | mmss }}
  </p>

</div>
     


    </div>
  </div>
  `
})
export class SpanishViewComponent implements OnInit {
  state: StateDto | null = null;
  private runId!: string;

  vm$!: Observable<{ mc: number; s: StateDto | null }>;

  sermonEndClicked = false;

  // track most-recently completed English segment
  private prevCompletedIds = new Set<string>();
  lastCompletedId: string | null = null;

  // seconds since master start (rounded)
  private nowSinceMasterSec(): number | null {
    if (!this.state?.masterStartAtUtc) return null;
    const ms = this.hub.serverNowMs() - Date.parse(this.state.masterStartAtUtc);
    return Math.max(0, Math.floor(ms / 1000));
  }

  // parse "mm:ss" into seconds; returns null if invalid
  private parseMmSs(txt: string): number | null {
    const m = txt.trim().match(/^(\d{1,2}):([0-5]\d)$/);
    if (!m) return null;
    return (+m[1]) * 60 + (+m[2]);
  }



  constructor(public hub: SignalrService, private route: ActivatedRoute) { }

  async ngOnInit() {
    this.runId = this.route.snapshot.params['id'];
    await this.hub.connect(this.runId);
    this.state = this.hub.state$.value;

    this.vm$ = combineLatest([
      this.hub.masterCountdown$.pipe(startWith(null as number | null)),
      this.hub.state$.pipe(startWith(this.state))
    ]).pipe(
      map(([mc, s]) => ({ mc: mc ?? 0, s }))
    );

    this.hub.state$.subscribe(s => {
      this.state = s;
      this.updateHighlight(s);
    });
  }

  startRun() { this.hub.startRun(this.runId); }

  sermonEnd() {
    if (this.sermonEndClicked) return;
    this.sermonEndClicked = true;
    this.hub.sermonEnded(this.runId);
  }
  // Live ET clock
  etNow$ = interval(1000).pipe(
    startWith(0),
    map(() =>
      new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      }).format(new Date())
    )
  );

  etDate$ = interval(1000).pipe(
    startWith(0),
    map(() =>
      new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        year: 'numeric',
      }).format(new Date())
    )
  );

  async setSpanishEtaAbs(sec: number) {
    if (sec == null || !isFinite(sec)) return;
    const eta = Math.max(0, Math.floor(sec));
    try {
      await this.hub.setSpanishEta(this.runId, eta);
      console.log('[ETA] SetSpanishEta →', eta);
    } catch (err) {
      console.error('[ETA] SetSpanishEta failed:', err);
    }
  }

  async setSpanishEtaPlus(offsetSec: number) {
    const now = this.nowSinceMasterSec();
    if (now == null) {
      console.warn('[ETA] Plus clicked before master start');
      return;
    }
    await this.setSpanishEtaAbs(now + offsetSec);
  }

  async setSpanishEtaFromText(txt: string) {
    const sec = this.parseMmSs(txt);
    if (sec == null) {
      console.warn('[ETA] Invalid mm:ss:', txt);
      return;
    }
    await this.setSpanishEtaAbs(sec);
  }



  // Completed rows with running total drift
  get completedEnglishWithRunning() {
    let sum = 0;
    return (this.state?.english.segments ?? [])
      .filter(s => s.completed)
      .sort((a, b) => a.order - b.order)
      .map(s => {
        const drift = +(s.driftSec ?? 0);
        sum += drift;
        return { seg: s, running: sum };
      });
  }

  get completedEnglishSorted() {
    return (this.state?.english.segments ?? []).filter(s => s.completed).sort((a, b) => a.order - b.order);
  }


  // highlight newest completed item 
  private updateHighlight(s: StateDto | null) {
    if (!s) return;
    const completed = s.english.segments.filter(x => x.completed);
    const completedIds = new Set(completed.map(x => x.id));

    const newlyCompleted = completed.filter(x => !this.prevCompletedIds.has(x.id));
    if (newlyCompleted.length > 0) {
      newlyCompleted.sort((a, b) => a.order - b.order);
      this.lastCompletedId = newlyCompleted[newlyCompleted.length - 1].id;
    }

    this.prevCompletedIds = completedIds;
  }

  endedAtFor(segId: string, segs: StateDto['english']['segments']): Date | null {
    if (!this.state?.masterStartAtUtc) return null;
    let total = 0;
    for (const s of [...segs].sort((a, b) => a.order - b.order)) { // copy before sort
      total += (s.actualSec ?? 0);
      if (s.id === segId && s.completed) {
        const endMs = Date.parse(this.state.masterStartAtUtc) + total * 1000;
        return new Date(endMs);
      }
    }
    return null;
  }




}
