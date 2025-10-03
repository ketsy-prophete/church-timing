// src/app/features/english/english-view.ts
import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute } from '@angular/router';
import { SignalrService } from '../../core/services/signalr';
import { TimePipe } from '../../shared/time.pipe';
import { SignedTimePipe } from '../../shared/signed-time.pipe';
import { Observable, interval, map, startWith, combineLatest } from 'rxjs';
import type { StateDto as BaseStateDto } from '../../core/services/signalr';
import { ViewChild, ElementRef } from '@angular/core';

type StateDto = BaseStateDto & {
  spanish: BaseStateDto['spanish'] & {
    sermonEndEtaSec?: number;  // locally add the ETA field
  };
};

interface EtaToast {
  id: number;
  remSec: number;          // countdown snapshot (e.g., 5:00 -> 300)
  wall: Date;              // timestamp for display
  deltaFromTarget: number; // neg = early, pos = late vs 36:00
}

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
    .dot.ended { background:#e53935; animation:none; }
    .time-red { color:#e53935; }
    .over{color:#000000}.under{color:#dc2626} /* fixed ## */
    .actual-cell { min-width: 96px; }
    .actual-primary { font-weight: 600; line-height: 1.1; }
    .clock-time { font-weight:700; font-size:20px;}
    .clock-date { font-weight:500; font-size:12px; opacity:.8; line-height:1.99; }
    /* Non-blocking toast stack */
    .toast-wrap{position:fixed;right:16px;bottom:16px;display:flex;flex-direction:column;gap:8px;z-index:1000;pointer-events:none}
    .toast{pointer-events:auto;background:#111;color:#fff;border-radius:6px;padding:10px 12px;box-shadow:0 6px 24px rgba(0,0,0,.25);font-size:13px;border-left:4px solid transparent}
    .toast small{opacity:.8}
    /* Delta hint: earlier=green, later=red */
    .toast.delta-early{border-left-color:#16a34a}
    .toast.delta-late{border-left-color:#dc2626}
  
/* Non-blocking toast stack */
.toast-wrap{
  position:fixed; right:16px; bottom:16px;
  display:flex; flex-direction:column; gap:8px;
  z-index:1000; pointer-events:none;
}

/* Base toast: reserve space for the close button and avoid overlap */
.toast{
  pointer-events:auto; position:relative;
  background:#111; color:#fff; border-radius:6px;
  padding:14px 36px 12px 12px;                 /* top right bottom left */
  box-shadow:0 6px 24px rgba(0,0,0,.25);
  font-size:13px;
  border-left:4px solid transparent;           /* default; tinted by variants */
}
.toast small{ opacity:.8; }

/* Delta hint: earlier=green, later=red */
.toast.delta-early{ border-left-color:#16a34a; }
.toast.delta-late{  border-left-color:#dc2626; }

/* Sermon Ended alert: black strip on the LEFT (no ::after at all) */
.toast.alert{
  background:#dc2626; color:#fff;
  position:relative;
  padding:16px 36px 14px 12px;
}

/* Close button */
.toast-close{
  position:absolute; top:8px; right:10px;
  background:transparent; border:none; cursor:pointer;
  color:inherit; font-size:16px; line-height:1;
}

/* Extra safety: ensure first line never sits under the × */
.toast > div:first-child{ display:block; padding-right:28px; }

/* Container/event-pass-through helpers */
.toast-wrap { pointer-events:none; }
.toast      { pointer-events:auto; }

    /* Make header stop exactly above the table's right edge (i.e., above "Ended") */
    .segments-wrap { display: inline-block; }                  /* width collapses to table width */
    .segments-wrap table { width: auto; }                      /* ensure table doesn't stretch to 100% */
    .segments-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin: 16px 0 8px; }
    .segments-head h3 { margin: 0; }
    .total-drift { font-weight: 600; white-space: nowrap; }
    /* Timestamp style for toasts */
    .toast .stamp{
      opacity:.72;       /* slightly lighter than main text */
      display:block;
      margin-top:4px;
      font-style:italic;
    }



  `],
  template: `

  <!-- producer.component.html -->
  <div style="padding:16px" class="toolbar">
    <button routerLink="/rundown" class="btn btn-secondary">Open Service Rundown</button>
  </div>
  <!-- rest of producer template... -->

  <div style="padding:16px; font-family:system-ui">
    <div class="titlebar">
      <h2>English Producer</h2>
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
      <ng-template #notStarted><b style="color:#3BB143">✅ Master Timer Ready (36 minutes) </b></ng-template>
    </div>

    <div *ngIf="state as s">
  <p>
  <b>Spanish Sermon Status:</b>
  Time Left:
  <ng-container *ngIf="spanishTimeLeftSec() as rem; else tlDash">
    {{ rem | mmss }}
  </ng-container>
  <ng-template #tlDash>—</ng-template>
  |
  Sermon Ended At:
  <ng-container *ngIf="state?.spanish?.sermonEndedAtSec as fin; else finDash">
    {{ fin | mmss }}
    <small style="margin-left:8px; opacity:.9">
      ({{ spanishEndedAtWallTime() | date:'h:mm a':'America/New_York' }})
    </small>
  </ng-container>
  <ng-template #finDash>—</ng-template>

  <ng-template #finDash>—</ng-template>
</p>

      <!-- Offering: Planned + Predicted (drift-aware, 36:00 fallback) → Final on real stamp -->
  <!-- Offering: stable, no flipping -->
      <p>
        <b>Offering Length:</b>
        Planned: {{ s.baseOfferingSec | mmss }}
        |
        <ng-container *ngIf="predictedLengthSec(s) as pl">
          Predicted: {{ pl | mmss }}
          <ng-container *ngIf="predictedExtensionSec(s) as ext">
          <small style="opacity:.8; margin-left:8px"> (+{{ ext | mmss }} included in prediction)
          </small>
          
          </ng-container>
        </ng-container>
      </p>


      <!-- Buttons -->
      <button (click)="startRun()" [disabled]="!!s.masterStartAtUtc">Start Run</button>
      <p>
        <button (click)="startOffering()" [disabled]="offeringClicked || isOfferingLocked(s)">
          Start Offering
        </button>
      </p>

      <!-- Segments (wrapped so header width == table width) -->
      <div class="segments-wrap">
        <div class="segments-head">
          <h3>Segments</h3>
          <div class="total-drift">
            <b>Total Drift:</b>
            <span [style.color]="+(s.english.runningDriftBeforeOfferingSec ?? 0) < -4 ? 'red'
                              : +(s.english.runningDriftBeforeOfferingSec ?? 0) >  4 ? 'black'
                              : 'inherit'">
              {{ s.english.runningDriftBeforeOfferingSec | signedmmss }}
            </span>
          </div>
        </div>

      <table>
        <tr>
          <th>#</th><th>Segment</th><th>Planned</th><th>Actual</th>
          <th>Segment Drift</th><th>Action</th><th>Ended</th>
        </tr>

        <tr *ngFor="let seg of s.english.segments; let i = index">
          <td>{{ seg.order }}</td>
          <td>{{ seg.name }}</td>
          <td>{{ seg.plannedSec | mmss }}</td>

          <!-- Actual (single bold line: live while active, then locked) -->
          <td class="actual-cell">
            <div class="actual-primary">
              <!-- While this segment is active -->
              <ng-container *ngIf="isActive(i, s.english.segments); else showLockedOrBlank">
                {{ activeElapsedSec(i, s.english.segments) | mmss }}
              </ng-container>

              <!-- After completion: show locked actual; otherwise blank (future segment) -->
              <ng-template #showLockedOrBlank>
                <ng-container *ngIf="seg.completed">
                  {{ seg.actualSec | mmss }}
                </ng-container>
              </ng-template>
            </div>
          </td>

          <td [class.under]="+(seg.driftSec ?? 0) < -4">
            {{ seg.driftSec | signedmmss }}
          </td>

          <!-- Action -->
          <td>
            <button (click)="complete(seg.id)" [disabled]="seg.completed">Complete</button>
          </td>

          <!-- Ended timestamp -->
          <td>
            <ng-container *ngIf="seg.completed; else dashEnded">
              {{ endedAt(i, s.english.segments) | date:'h:mm a':'America/New_York' }}
            </ng-container>
            <ng-template #dashEnded>—</ng-template>
          </td>
        </tr>
      </table>


      <audio #etaChime preload="auto">
        <source src="assets/sounds/eta-chime.wav" type="audio/wav">
      </audio>



<!-- Toasts (ETA + Sermon Ended) -->
  <div class="toast-wrap" aria-live="polite" aria-atomic="true">

  <!-- ETA change toasts -->
  <div class="toast"
      *ngFor="let t of etaToasts; trackBy: trackById"
      [class.delta-early]="t.deltaFromTarget < 0"
      [class.delta-late]="t.deltaFromTarget > 0">
    <button class="toast-close" aria-label="Close"
            (click)="closeEtaToast(t.id)">×</button>
    <div><b>Spanish ETA updated</b></div>
    <div>ETA: {{ t.remSec | mmss }}</div>
    <small class="stamp"><i>{{ t.wall | date:'h:mm a':'America/New_York' }}</i></small>
  </div>


  <!-- Sermon Ended toasts -->
  <div class="toast alert"
      *ngFor="let t of sermonEndToasts; trackBy: trackById">
    <button class="toast-close" aria-label="Close"
            (click)="closeSermonEndToast(t.id)">×</button>
    <div><b>Spanish Sermon Ended</b></div>
    <div>
      <small>Locked at T+{{ state?.spanish?.sermonEndedAtSec | mmss }}</small>
      <small class="stamp"><i>{{ t.wall | date:'h:mm a':'America/New_York' }}</i></small>
    </div>
  </div>


</div>
  `
})
export class EnglishViewComponent implements OnInit {
  state: StateDto | null = null;
  private runId!: string;

  vm$!: Observable<{ mc: number; s: StateDto | null }>;
  offeringClicked = false;

  // track most-recently completed English segment (for row highlight)
  private prevCompletedIds = new Set<string>();
  lastCompletedId: string | null = null;


  constructor(public hub: SignalrService, private route: ActivatedRoute) { }


  // ---- OFFERING / PREDICTED HELPERS ----

  // find "Offering" row (case-insensitive)
  private offeringIndex(s: StateDto): number {
    return s.english.segments.findIndex(x => /offering/i.test(x.name));
  }

  // Planned time when Offering should start (sum planned prior to “Offering”)
  private plannedOfferingStartSec(s: StateDto): number | null {
    const idx = s.english.segments.findIndex(x => /offering/i.test(x.name));
    if (idx < 0) return null;
    let total = 0;
    for (let i = 0; i < idx; i++) total += (s.english.segments[i].plannedSec ?? 0);
    return total;
  }

  // Live projected start (planned + running drift from completed)
  private projectedOfferingStartSec(s: StateDto): number | null {
    const planned = this.plannedOfferingStartSec(s);
    if (planned == null) return null;
    const drift = +(s.english.runningDriftBeforeOfferingSec ?? 0);
    return planned + drift;
  }

  // Prefer: real stamp > 0; else ETA > 0; else fallback target (36:00)
  private spanishAnchorOrPlannedSec(s: StateDto): number {
    const ended = s.spanish?.sermonEndedAtSec;
    const eta = (s as any)?.spanish?.sermonEndEtaSec; // TS-safe during Phase 1
    if (typeof ended === 'number' && ended > 0) return ended;
    if (typeof eta === 'number' && eta > 0) return eta;
    return this.hub.masterTargetSec; // 36:00 fallback
  }

  // Final only when REAL stamp exists (>0)
  isFinalOfferingAvailable(s: StateDto): boolean {
    return !!s.masterStartAtUtc
      && typeof s.spanish?.sermonEndedAtSec === 'number'
      && s.spanish!.sermonEndedAtSec > 0;
  }

  // Predicted (drift-aware; uses fallback/ETA/stamp anchor)
  predictedOfferingLengthSec(s: StateDto): number | null {
    const start = this.projectedOfferingStartSec(s);
    if (start == null) return null;
    const base = +(s.baseOfferingSec ?? 0);
    const anchor = this.spanishAnchorOrPlannedSec(s);
    const gap = Math.max(0, anchor - start);
    return Math.max(base, gap);
  }


  // Predicted full length (never null: falls back to base)
  predictedLengthSec(s: StateDto): number {
    const base = +(s.baseOfferingSec ?? 0);
    const start = this.projectedOfferingStartSec(s);
    if (start == null) return base;
    const gap = Math.max(0, this.anchorSec(s) - start);
    return Math.max(base, gap);
  }

  // Predicted extension only (>= 0)
  predictedExtensionSec(s: StateDto): number {
    const ext = this.predictedLengthSec(s) - +(s.baseOfferingSec ?? 0);
    return Math.max(0, ext);
  }

  // ---- END OFFERING HELPERS ----

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

      // Detect ETA changes (works even if ETA isn’t typed on StateDto)
      const eta = (s as any)?.spanish?.sermonEndEtaSec;
      if (typeof eta === 'number') {
        this.onEtaUpdated(eta);
      }

      const end = s?.spanish?.sermonEndedAtSec ?? null;
      if (typeof end === 'number' && end > 0 && end !== this.lastSermonEndSec) {
        this.lastSermonEndSec = end;
        this.pushSermonEndedToast();
      }

    });
  }

  startRun() { this.hub.startRun(this.runId); }

  startOffering() {
    if (this.offeringClicked) return;
    this.offeringClicked = true;
    this.hub.startOffering(this.runId);
  }

  isOfferingLocked(s: StateDto): boolean {
    const seg = s.english.segments.find(x => /offering/i.test(x.name));
    if (!seg) return false;
    return !!seg.completed || (seg.actualSec ?? 0) > 0;
  }

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

  endedAt(idx: number, segs: StateDto['english']['segments']): Date | null {
    if (!this.state?.masterStartAtUtc || !segs[idx]?.completed) return null;
    let total = 0;
    for (let i = 0; i <= idx; i++) total += (segs[i].actualSec ?? 0);
    const endMs = Date.parse(this.state.masterStartAtUtc) + total * 1000;
    return new Date(endMs);
  }

  // Which anchor to use: Final > ETA > 36:00 fallback
  private anchorSec(s: StateDto): number {
    const ended = s.spanish?.sermonEndedAtSec ?? 0;
    const eta = (s as any)?.spanish?.sermonEndEtaSec ?? 0;
    if (ended > 0) return ended;
    if (eta > 0) return eta;
    return this.hub.masterTargetSec; // 36:00
  }


  // Store the remaining time snapshot (what the Spanish side entered) + timestamp
  etaToasts: EtaToast[] = [];
  private lastEtaAbsSec: number | null = null;
  private toastIdSeq = 1;
  private lastToastAt = 0;
  sermonEndToasts: { id: number; wall: Date | null }[] = [];
  private lastSermonEndSec: number | null = null;

  @ViewChild('etaChime') etaChime?: ElementRef<HTMLAudioElement>;

  private async onEtaUpdated(newEtaAbsSec: number) {
    // ignore zeros/nulls and true duplicates
    if (!(newEtaAbsSec > 0)) return;
    if (this.lastEtaAbsSec != null && newEtaAbsSec === this.lastEtaAbsSec) return;

    // rate-limit: ignore if within 800ms of last toast
    // (helps if multiple updates arrive in quick succession)
    // throttle
    const now = Date.now();
    if (now - this.lastToastAt < 800) return;
    this.lastToastAt = now;

    this.lastEtaAbsSec = newEtaAbsSec;

    // compute the countdown snapshot to display (entered ETA relative to "now")
    const nowElapsed = this.masterElapsedSec() ?? 0;                 // seconds since master start
    const remSec = Math.max(0, Math.floor(newEtaAbsSec - nowElapsed)); // show 5:00 if they entered 5:00

    // stripe logic vs 36:00 target
    const deltaFromTarget = newEtaAbsSec - this.hub.masterTargetSec;

    const id = this.toastIdSeq++;
    const wall = new Date(this.hub.serverNowMs());
    this.etaToasts = [...this.etaToasts, { id, remSec, wall, deltaFromTarget }];

    try { await this.etaChime?.nativeElement.play(); } catch { }
  }

  private pushSermonEndedToast() {
    const id = this.toastIdSeq++;
    const wall = this.spanishEndedAtWallTime();
    this.sermonEndToasts.push({ id, wall: wall ?? null });
  }


  spanishEtaSec(s: any): number | null {
    const manual = s?.spanish?.sermonEndEtaSec;
    if (manual != null) return manual;   // manual override wins
    // fallback: if you still have a computed ETA, return it; otherwise null
    return null; // or: return this.computeSpanishEtaFromTimestamps(s);
  }


  // Color ETA red if later than 36:00, green if earlier; neutral if exactly 36:00
  etaColor(etaSec: number): string {
    if (etaSec > this.hub.masterTargetSec) return '#dc2626';  // red
    if (etaSec < this.hub.masterTargetSec) return '#16a34a';  // green
    return 'inherit';
  }

  // Difference vs the 36:00 target (positive = late, negative = early)
  etaDeltaFromTarget(etaSec: number): number {
    return etaSec - this.hub.masterTargetSec;
  }

  private masterElapsedSec(): number | null {
    const start = this.state?.masterStartAtUtc;
    if (!start) return null;
    const ms = this.hub.serverNowMs() - Date.parse(start);
    return Math.max(0, Math.floor(ms / 1000));
  }

  spanishTimeLeftSec(): number | null {
    const ended = this.state?.spanish?.sermonEndedAtSec;
    if (ended != null && ended > 0) return 0;                  // ← freeze at 0 after final
    const etaAbs = this.state?.spanish?.sermonEndEtaSec;
    const now = this.masterElapsedSec();
    if (etaAbs == null || now == null) return null;
    return Math.max(0, etaAbs - now);
  }

  spanishEndedAtWallTime(): Date | null {
    const endSec = this.state?.spanish?.sermonEndedAtSec;
    const startStr = this.state?.masterStartAtUtc;

    // Strict guards so TS knows both are valid
    if (typeof endSec !== 'number' || endSec <= 0) return null;
    if (!startStr) return null;

    const startMs = Date.parse(startStr);
    return new Date(startMs + endSec * 1000);
  }

  closeEtaToast(id: number) {
    this.etaToasts = this.etaToasts.filter(t => t.id !== id);
  }

  closeSermonEndToast(id: number) {
    this.sermonEndToasts = this.sermonEndToasts.filter(t => t.id !== id);
  }

  // Optional: for *ngFor trackBy to reduce DOM churn
  trackById(_: number, item: { id: number }) { return item.id; }


}

