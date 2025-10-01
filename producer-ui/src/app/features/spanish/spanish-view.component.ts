// src/app/features/spanish/spanish-view.ts
import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute } from '@angular/router';
import { SignalrService } from '../../core/services/signalr';
import type { StateDto } from '../../core/services/signalr';
import { TimePipe } from '../../shared/time.pipe';
import { SignedTimePipe } from '../../shared/signed-time.pipe';
import { interval, map, startWith } from 'rxjs';

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
  `],
  template: `
  <div style="padding:16px; font-family:system-ui">
    <div class="titlebar">
      <h2>Spanish Producer</h2>
      <span class="clock">{{ etNow$ | async }} ET</span>
    </div>

    <!-- Live status / master countdown -->
    <div class="bar">
      <ng-container *ngIf="(hub.masterCountdown$ | async) as mc; else notStarted">
        <span class="dot" [class.live]="!!state?.masterStartAtUtc"></span>
        <b>Master T– {{ mc | mmss }}</b>
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
      <button (click)="sermonEnd()">Sermon End</button>
      <p><b>Sermon Ended At:</b> {{ s.spanish.sermonEndedAtSec | mmss }}</p>

      <h3 style="margin-top:12px">Completed in English</h3>
      <table>
        <tr>
          <th>#</th><th>Segment</th><th>Segment Drift</th><th>Total Drift</th><th>Status</th>
        </tr>
        <tr *ngFor="let row of completedEnglishWithRunning"
            [class.highlight]="row.seg.id === lastCompletedId">
          <td>{{ row.seg.order }}</td>
          <td>{{ row.seg.name }}</td>

          <!-- per-segment drift: over=green, under=red -->
          <td [style.color]="(row.seg.driftSec ?? 0) > 4 ? 'green'
                            : (row.seg.driftSec ?? 0) < -4 ? 'red'
                            : 'inherit'">
            {{ row.seg.driftSec | signedmmss }}
          </td>

          <!-- running total drift (row.running is a number; no ?? needed) -->
          <td [style.color]="row.running > 4 ? 'green'
                            : row.running < -4 ? 'red'
                            : 'inherit'">
            {{ row.running | signedmmss:true }}
          </td>

          <td>Complete</td>
        </tr>
      </table>
    </div>
  </div>
  `
})
export class SpanishViewComponent implements OnInit {
  state: StateDto | null = null;
  private runId!: string;

  // track most-recently completed English segment
  private prevCompletedIds = new Set<string>();
  lastCompletedId: string | null = null;

  constructor(public hub: SignalrService, private route: ActivatedRoute) {}

  async ngOnInit() {
    this.runId = this.route.snapshot.params['id'];
    await this.hub.connect(this.runId);
    this.state = this.hub.state$.value;

    this.hub.state$.subscribe(s => {
      this.state = s;
      this.updateHighlight(s);
    });
  }

  startRun() { this.hub.startRun(this.runId); }
  sermonEnd() { this.hub.sermonEnded(this.runId); }

  // Live ET clock
  etNow$ = interval(1000).pipe(
    startWith(0),
    map(() =>
      new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      }).format(new Date()).replace(/\s/g, '')
    )
  );

  // Completed rows with running total drift
  get completedEnglishWithRunning() {
    let sum = 0;
    return (this.state?.english.segments ?? [])
      .filter(s => s.completed)
      .sort((a, b) => a.order - b.order)
      .map(s => { sum += (s.driftSec ?? 0); return { seg: s, running: sum }; });
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
}
