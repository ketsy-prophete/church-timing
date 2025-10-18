import { Component, OnInit, OnDestroy, ViewChild, ElementRef, TrackByFunction, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { FormBuilder, ReactiveFormsModule } from '@angular/forms';
import { Observable, Subscription, combineLatest, interval, timer, BehaviorSubject } from 'rxjs';
import { map, startWith, auditTime } from 'rxjs/operators';

import { SignalrService } from '../../core/services/signalr';
import type { StateDto as ViewStateDto } from '../../core/services/signalr';
import { TimePipe } from '../../shared/time.pipe';
import { SignedTimePipe } from '../../shared/signed-time.pipe';
import { RundownService } from '../../store/rundown.service';
import { TickerService } from '../../core/services/ticker.service';

interface EtaToast {
  id: number;
  remSec: number;
  wall: Date;
  deltaFromTarget: number;
}

@Component({
  standalone: true,
  selector: 'app-english-view',
  imports: [CommonModule, RouterLink, ReactiveFormsModule, TimePipe, SignedTimePipe],
  templateUrl: './english-view.component.html',
  styleUrls: ['./english-view.component.css'],
})
export class EnglishViewComponent implements OnInit, OnDestroy {
  // private readonly signalr = inject(SignalrService);
  private readonly ticker = inject(TickerService);

  // ---------- DI ----------
  private route = inject(ActivatedRoute);
  private fb = inject(FormBuilder);
  public hub = inject(SignalrService);

  offsetMs$ = this.hub.offsetMs$;
  state$ = this.hub.state$;

  serverNow$ = combineLatest([this.ticker.now$, this.offsetMs$]).pipe(
    map(([now, offset]) => now - (offset ?? 0))
  );

  constructor(private rundownService: RundownService) { }

  // ---------- Route / connection ----------
  private subRoute?: Subscription;
  private subState?: Subscription;
  runId!: string;
  connected = false;
  connectErr: unknown = null;
  showMiniRundown = false;

  // ---------- Reactive state (read-only streams from service) ----------
  readonly isLive$ = this.hub.isLive$;
  readonly lastSyncAgo$ = this.hub.lastSyncAgo$;
  readonly masterCountdown$ = this.hub.masterCountdown$;

  // Local snapshot (set only when state is non-null)
  public state: ViewStateDto | null = null;

  // VM streams
  vm$!: Observable<{ mc: number; s: ViewStateDto | null }>;
  vmView$!: Observable<{ mc: number; s: ViewStateDto | null }>;

  // ---------- Forms ----------
  etaForm = this.fb.group({
    etaSec: this.fb.control<number | null>(null),
  });

  // ---------- UI / view helpers ----------
  offeringClicked = false;
  get doc$() { return this.rundownService.doc$; }

  // trackBys
  trackBySeg: TrackByFunction<ViewStateDto['english']['segments'][number]> = (_i, s) => s.id;
  public trackById: TrackByFunction<any> = (_: number, row: any) => row?.id ?? _;
  trackBySegWrap = (_: number, row: { seg: { id: string } }) => row.seg.id;

  // ---------- Toasts ----------
  etaToasts: EtaToast[] = [];
  sermonEndToasts: { id: number; wall: Date | null }[] = [];
  private lastEtaAbsSec: number | null = null;
  private lastToastAt = 0;
  private lastSermonEndSec: number | null = null;
  private toastIdSeq = 1;

  rawSpanishInputSec: number | null = null;

  // @ViewChild('etaChime') etaChime?: ElementRef<HTMLAudioElement>;

  // ---------- Row highlight ----------
  private prevCompletedIds = new Set<string>();
  lastCompletedId: string | null = null;

  // ---------- Clocks (UI-only) ----------
  nowSec$ = timer(0, 1000).pipe(map(() => Math.floor(Date.now() / 1000)));
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

  // =========================================================
  // Lifecycle
  // =========================================================
  ngOnInit(): void {
    // 1) Connect to the correct run from the route
    this.subRoute = this.route.paramMap.subscribe(async pm => {
      const id = pm.get('runId') ?? pm.get('id');
      if (!id || id === this.runId) return;
      this.runId = id;
      try {
        await this.hub.connect(id);
        this.rundownService.init(id);
        this.connected = true;
      } catch (e) {
        this.connectErr = e;
        console.error('[EnglishView] connect failed', e);
      }
    });

    // 2) Wait for a NON-NULL state before doing any timer math / UI logic
    this.subState = this.hub.state$.subscribe((s) => {
      console.log('STATE UPDATE', s);
      this.state = s;
      if (!s) return;

      // sermonEndEtaSec = adjusted ETA relative to master
      // etaUpdatedAtUtc = actual timestamp when Spanish sent it
      // derive how many seconds Spanish *typed* (raw input)
      if (s.spanish?.etaUpdatedAtUtc && s.spanish.sermonEndEtaSec != null) {
        const sentAtMs = Date.parse(s.spanish.etaUpdatedAtUtc);
        const serverNow = this.hub.serverNowMs();
        const ageSec = Math.max(0, Math.floor((serverNow - sentAtMs) / 1000));
        this.rawSpanishInputSec = Math.max(0, s.spanish.sermonEndEtaSec + ageSec);
      }

      // Toast triggers
      const eta = s.spanish?.sermonEndEtaSec;
      if (typeof eta === 'number') this.onEtaUpdated(eta);

      const end = s.spanish?.sermonEndedAtSec ?? null;
      if (typeof end === 'number' && end > 0 && end !== this.lastSermonEndSec) {
        this.lastSermonEndSec = end;
        this.pushSermonEndedToast();
      }

      // Segment highlight
      this.updateHighlight(s);
    });


    // 3) ViewModel: compute mc locally from state + server time (no service change)
    this.vm$ = combineLatest([
      this.hub.state$.pipe(startWith<ViewStateDto | null>(null)),
      interval(1000).pipe(startWith(0))
    ]).pipe(
      map(([s]) => ({ mc: this.masterCountdownSec(s) ?? 0, s }))
    );

    this.vmView$ = this.vm$.pipe(auditTime(0));
  }

  ngOnDestroy() {
    this.subRoute?.unsubscribe();
    this.subState?.unsubscribe();
    this.hub.disconnect();
    this.rundownService.dispose();
  }

  // =========================================================
  // Actions
  // =========================================================
  startRun() { if (this.runId) this.hub.startRun(this.runId); }
  sermonEnded() { if (this.runId) this.hub.sermonEnded(this.runId); }
  completeSegment(segId: string) { if (this.runId) this.hub.completeSegment(this.runId, segId); }

  async startOffering() {
    const s = this.state;
    if (!this.runId || this.isOfferingLocked(s) || this.offeringClicked) return;
    this.offeringClicked = true;
    try {
      await this.rundownService.startOffering(this.runId);
    } finally {
      this.offeringClicked = false;
    }
  }

  setEta(delta?: number) {
    const cur = this.etaForm.value.etaSec ?? 0;
    const val = typeof delta === 'number' ? Math.max(0, cur + delta) : cur;
    this.etaForm.patchValue({ etaSec: val });
  }

  submitEta() {
    const v = this.etaForm.value.etaSec ?? 0;
    if (this.runId) this.hub.setSpanishEta(this.runId, v);
  }

  clearEta() {
    if (this.runId) this.hub.setSpanishEta(this.runId, 0);
    this.etaForm.reset();
  }

  // =========================================================
  // View helpers / timing / toasts
  // =========================================================
  private updateHighlight(s: ViewStateDto | null) {
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

  private masterElapsedSec(): number | null {
    const start = this.state?.masterStartUtc;
    if (!start) return null;
    const ms = this.hub.serverNowMs() - Date.parse(start);
    return Math.max(0, Math.floor(ms / 1000));
  }

  private spanishAnchorOrPlannedSec(s: ViewStateDto): number {
    const ended = s.spanish?.sermonEndedAtSec;
    const eta = s.spanish?.sermonEndEtaSec;
    if (typeof ended === 'number' && ended > 0) return ended;
    if (typeof eta === 'number' && eta > 0) return eta;
    return this.hub.masterTargetSec;
  }

  predictedOfferingLengthSec(s: ViewStateDto): number | null {
    const plannedStart = this.plannedOfferingStartSec(s);
    if (plannedStart == null) return null;
    const drift = +(s.english.runningDriftBeforeOfferingSec ?? 0);
    const start = plannedStart + drift;
    const base = +(s.baseOfferingSec ?? 0);
    const anchor = this.spanishAnchorOrPlannedSec(s);
    const gap = Math.max(0, anchor - start);
    return Math.max(base, gap);
  }

  private plannedOfferingStartSec(s: ViewStateDto): number | null {
    const segs = s.english.segments ?? [];
    const idx = segs.findIndex(x => /offering/i.test(x.name));
    if (idx < 0) return null;
    let total = 0;
    for (let i = 0; i < idx; i++) total += this.plannedDuration(i, segs);
    return total;
  }

  private async onEtaUpdated(newEtaAbsSec: number) {
    if (!(newEtaAbsSec > 0)) return;
    if (this.lastEtaAbsSec != null && newEtaAbsSec === this.lastEtaAbsSec) return;
    const now = Date.now();
    if (now - this.lastToastAt < 800) return;
    this.lastToastAt = now;
    this.lastEtaAbsSec = newEtaAbsSec;

    const nowElapsed = this.masterElapsedSec() ?? 0;
    const remSec = Math.max(0, Math.floor(newEtaAbsSec - nowElapsed));
    const deltaFromTarget = newEtaAbsSec - this.hub.masterTargetSec;
    const id = this.toastIdSeq++;
    const wall = new Date(this.hub.serverNowMs());
    this.etaToasts = [...this.etaToasts, { id, remSec, wall, deltaFromTarget }];
    // try { await this.etaChime?.nativeElement.play(); } catch { }
  }

  private pushSermonEndedToast() {
    const id = this.toastIdSeq++;
    const wall = this.spanishEndedAtWallTime();
    this.sermonEndToasts = [...this.sermonEndToasts, { id, wall: wall ?? null }];
  }

  closeEtaToast(id: number) { this.etaToasts = this.etaToasts.filter(t => t.id !== id); }
  closeSermonEndToast(id: number) { this.sermonEndToasts = this.sermonEndToasts.filter(t => t.id !== id); }

  spanishEndedAtWallTime(): Date | null {
    const endSec = this.state?.spanish?.sermonEndedAtSec;
    const startStr = this.state?.masterStartUtc;
    if (typeof endSec !== 'number' || endSec <= 0) return null;
    if (!startStr) return null;
    const startMs = Date.parse(startStr);
    return new Date(startMs + endSec * 1000);
  }

  totalDurationSec(doc: { segments?: Array<{ durationSec?: number }> } | null | undefined): number {
    return (doc?.segments ?? []).reduce((sum, s) => sum + (s?.durationSec ?? 0), 0);
  }

  isOfferingLocked(s: ViewStateDto | null): boolean {
    if (!s) return true;
    if (s.english?.offeringStartedAtSec != null) return true;
    const seg = s.english?.segments.find(x => /offering/i.test(x.name));
    return !!seg && (!!seg.completed || (seg.actualSec ?? 0) > 0);
  }

  plannedDuration(i: number, segs: { plannedSec: number }[]): number {
    if (!segs?.length) return 0;
    const current = segs[i]?.plannedSec ?? 0;
    const prev = i > 0 ? (segs[i - 1]?.plannedSec ?? 0) : 0;
    // If values are already durations (not marks), this will no-op:
    return current >= prev ? current - prev : current;
  }

  // -------- Template helpers --------
  spanishEtaSec(s: any): number | null {
    return s?.spanish?.sermonEndEtaSec ?? null;
  }
  predictedLengthSec(s: any): number | null {
    const base = s?.baseOfferingSec ?? 0;
    const plannedStart = this.plannedOfferingStartSec(s);
    if (plannedStart == null) return base;
    const drift = s?.english?.runningDriftBeforeOfferingSec ?? 0;
    const start = plannedStart + drift;
    const anchor = this.spanishAnchorOrPlannedSec(s);
    const gap = Math.max(0, anchor - start);
    return Math.max(base, gap);
  }
  predictedExtensionSec(s: any): number {
    const ext = this.predictedLengthSec(s)! - (s?.baseOfferingSec ?? 0);
    return Math.max(0, ext);
  }
  isActive(idx: number, segs: any[]): boolean {
    if (!this.state?.masterStartUtc) return false;
    for (let i = 0; i < idx; i++) if (!segs[i].completed) return false;
    return !segs[idx].completed;
  }
  // activeElapsedSec(idx: number, segs: any[], s: ViewStateDto): number {
  //   let prevActual = 0;
  //   for (let i = idx - 1; i >= 0; i--) {
  //     const a = segs[i].actualSec;
  //     if (segs[i].completed && typeof a === 'number') { prevActual = a; break; }
  //   }
  //   const masterStartMs = Date.parse(s.masterStartUtc!);
  //   const segStartMs = masterStartMs + prevActual * 1000;
  //   const nowMs = this.hub.serverNowMs();
  //   return Math.max(0, Math.floor((nowMs - segStartMs) / 1000));
  // }
  activeElapsedSec(idx: number, segs: any[], s: ViewStateDto): number {
    if (!s?.masterStartUtc) return 0;
    const masterStartMs = Date.parse(s.masterStartUtc);
    const priorActualSec = this.sumActualBefore(idx, segs);       // ✅ sum, not “last completed”
    const segStartMs = masterStartMs + priorActualSec * 1000;
    const nowMs = this.hub.serverNowMs();
    return Math.max(0, Math.floor((nowMs - segStartMs) / 1000));
  }

  // endedAt(idx: number, segs: any[]): Date | null {
  //   if (!this.state?.masterStartUtc || !segs[idx]?.completed) return null;
  //   const endSec = segs[idx].actualSec ?? 0;
  //   const endMs = Date.parse(this.state.masterStartUtc) + endSec * 1000;
  //   return new Date(endMs);
  // }
  endedAt(idx: number, segs: any[]): Date | null {
    if (!this.state?.masterStartUtc || !segs[idx]?.completed) return null;

    // If you later add actualStopUtc, prefer that here.
    const endAbsSec = this.sumActualThrough(idx, segs);           // ✅ cumulative up to this row
    const endMs = Date.parse(this.state.masterStartUtc) + endAbsSec * 1000;
    return new Date(endMs);
  }

  // ✅ Add these two helpers anywhere inside the class:
  masterCountdownSec(s: ViewStateDto | null): number | null {
    if (!s?.masterStartUtc) return null;
    const startMs = Date.parse(s.masterStartUtc);
    const nowMs = this.hub.serverNowMs();
    const elapsed = Math.max(0, Math.floor((nowMs - startMs) / 1000));
    return s.masterTargetSec - elapsed; // can be <= 0
  }

  liveActualSec(
    seg: { id: string; order: number; completed?: boolean; actualSec?: number },
    segs: Array<{ id: string; order: number; completed?: boolean; actualSec?: number }>
  ): number {
    if (seg.completed) return seg.actualSec ?? 0;

    // allow ticking ONLY for the first incomplete row
    const firstOpen = [...segs].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).find(s => !s.completed);
    if (!firstOpen || firstOpen.id !== seg.id) return 0; // not current → don't tick

    const start = this.state?.masterStartUtc;
    if (!start) return 0;

    const elapsed = Math.max(0, Math.floor((this.hub.serverNowMs() - Date.parse(start)) / 1000));
    const order = seg.order ?? 0;
    const priorMark = segs
      .filter(s => (s.order ?? 0) < order && s.completed)
      .reduce((t, s) => t + (s.actualSec ?? 0), 0);

    return Math.max(0, elapsed - priorMark); // current row counts up from 00:00
  }



  plannedMarks(segs: { plannedSec: number }[]): number[] {
    let acc = 0;
    return (segs ?? []).map(s => (acc += (s?.plannedSec ?? 0)));
  }

  private sumActualBefore(idx: number, segs: Array<{ completed?: boolean; actualSec?: number }>): number {
    let total = 0;
    for (let i = 0; i < idx; i++) total += (segs[i]?.completed ? (segs[i]?.actualSec ?? 0) : 0);
    return total;
  }

  private sumActualThrough(idx: number, segs: Array<{ completed?: boolean; actualSec?: number }>): number {
    return this.sumActualBefore(idx, segs) + (segs[idx]?.completed ? (segs[idx]?.actualSec ?? 0) : 0);
  }

}
