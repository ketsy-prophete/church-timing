// src/app/features/english/english-view.ts
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
  selector: 'app-english-view',
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
      <h2>English Producer</h2>
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
      <ng-template #notStarted><b>Master Timer Ready</b></ng-template>
    </div>

    <div *ngIf="state as s">
      <p><b>Spanish Sermon End:</b> {{ s.spanish.sermonEndedAtSec | mmss }}</p>

      <!-- Offering suggestion -->
      <p><b>Offering Length:</b>
        <ng-container *ngIf="s.offeringSuggestion.stretchSec === 0; else stretch">
          {{ s.baseOfferingSec | mmss }} (Stay)
        </ng-container>
        <ng-template #stretch>
          {{ s.offeringSuggestion.offeringTargetSec | mmss }}
          — <em>(with {{ s.offeringSuggestion.stretchSec | mmss }} extension)</em>
        </ng-template>
      </p>

      <button (click)="startRun()" [disabled]="!!s.masterStartAtUtc">Start Run</button>
      <p><button (click)="startOffering()">Start Offering</button></p>

      <h3>Segments</h3>
      <table>
        <tr>
          <th>#</th><th>Segment</th><th>Planned</th><th>Actual</th><th>Segment Drift</th><th>Timer</th><th>Action</th>
        </tr>

        <tr *ngFor="let seg of s.english.segments; let i = index"
            [class.highlight]="seg.id === lastCompletedId">
          <td>{{ seg.order }}</td>
          <td>{{ seg.name }}</td>
          <td>{{ seg.plannedSec | mmss }}</td>
          <td>{{ seg.actualSec  | mmss }}</td>

          <!-- Drift: over=green, under=red (use tolerance ±4s; tweak if you prefer) -->
          <td [style.color]="(seg.driftSec ?? 0) > 4 ? 'green'
                           : (seg.driftSec ?? 0) < -4 ? 'red'
                           : 'inherit'">
            {{ seg.driftSec | signedmmss }}
          </td>

          <!-- Timer: live for active segment; freeze to actual when completed -->
          <td>
            <span *ngIf="seg.completed; else liveOrDash">{{ seg.actualSec | mmss }}</span>
            <ng-template #liveOrDash>
              <span *ngIf="isActive(i, s.english.segments); else dash">
                {{ activeElapsedSec(i, s.english.segments) | mmss }}
              </span>
              <ng-template #dash>—</ng-template>
            </ng-template>
          </td>

          <td>
            <button (click)="complete(seg.id)" [disabled]="seg.completed">Complete</button>
          </td>
        </tr>
      </table>

      <p>
        <b>Total Drift:</b>
        <span
          [style.color]="(s.english.runningDriftBeforeOfferingSec ?? 0) < -4 ? 'red'
                        : (s.english.runningDriftBeforeOfferingSec ?? 0) >  4 ? 'green'
                        : 'inherit'">
          {{ s.english.runningDriftBeforeOfferingSec | signedmmss }}
        </span>
      </p>
    </div>
  </div>
  `
})
export class EnglishViewComponent implements OnInit {
  state: StateDto | null = null;
  private runId!: string;

  // track most-recently completed English segment (for row highlight)
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
  startOffering() { this.hub.startOffering(this.runId); }
  complete(id: string) { this.hub.completeSegment(this.runId, id); }

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

  // Row active logic for the live timer
  isActive(idx: number, segs: StateDto['english']['segments']): boolean {
    if (!this.state?.masterStartAtUtc) return false;
    for (let i = 0; i < idx; i++) if (!segs[i].completed) return false;
    return !segs[idx].completed;
  }

  activeElapsedSec(idx: number, segs: StateDto['english']['segments']): number {
    let sumActualBefore = 0;
    for (let i = 0; i < idx; i++) sumActualBefore += (segs[i].actualSec ?? 0);
    const masterStartMs = Date.parse(this.state!.masterStartAtUtc!);
    const segStartMs = masterStartMs + sumActualBefore * 1000;
    const nowMs = this.hub.serverNowMs();
    return Math.max(0, Math.floor((nowMs - segStartMs) / 1000));
  }

  // Highlight newest completed item
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
