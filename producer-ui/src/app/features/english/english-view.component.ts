import { Component, OnInit, OnDestroy, ViewChild, ElementRef, TrackByFunction, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { FormBuilder, ReactiveFormsModule } from '@angular/forms';
import { Observable, Subscription, combineLatest, interval, timer } from 'rxjs';
import { map, startWith, auditTime } from 'rxjs/operators';

import { SignalrService } from '../../core/services/signalr';
import type { StateDto as BaseStateDto } from '../../core/services/signalr';
import { TimePipe } from '../../shared/time.pipe';
import { SignedTimePipe } from '../../shared/signed-time.pipe';
import { RundownService } from '../../store/rundown.service';

// ---------- Local types ----------
type ViewStateDto = BaseStateDto & {
  spanish: BaseStateDto['spanish'] & { sermonEndEtaSec?: number };
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
  imports: [CommonModule, RouterLink, ReactiveFormsModule, TimePipe, SignedTimePipe],
  templateUrl: './english-view.component.html',
  styleUrls: ['./english-view.component.css'],
})

export class EnglishViewComponent implements OnInit, OnDestroy {

  // ---------- DI ----------
  private route = inject(ActivatedRoute);
  private fb = inject(FormBuilder);
  public hub = inject(SignalrService);

  // ---------- Route / connection ----------
  private subRoute?: Subscription;
  private subState?: Subscription;
  runId!: string;
  connected = false;
  connectErr: unknown = null;

  // ---------- Reactive state exposed to template ----------
  state$ = this.hub.state$;
  isLive$ = this.hub.isLive$;
  lastSyncAgo$ = this.hub.lastSyncAgo$;
  masterCountdown$ = this.hub.masterCountdown$;

  state: ViewStateDto | null = null;

  vm$!: Observable<{ mc: number; s: ViewStateDto | null }>;
  vmView$!: Observable<{ mc: number; s: ViewStateDto | null }>;

  constructor(private rundownService: RundownService) { }

  // ---------- Forms ----------
  etaForm = this.fb.group({
    etaSec: this.fb.control<number | null>(null),
  });

  // ---------- UI / view helpers ----------
  offeringClicked = false;
  trackBySeg: TrackByFunction<ViewStateDto['english']['segments'][number]> = (_i, s) => s.id;
  get doc$() { return this.rundownService.doc$; }

  // ----- SHIMS for current template -----

  // Used by multiple *ngFor (segments, etaToasts, sermonEndToasts, doc.segments)
  public trackById: TrackByFunction<any> = (_: number, row: any) => row?.id ?? _;
  trackBySegWrap = (_: number, row: { seg: { id: string } }) => row.seg.id;


  // Template calls (click)="complete(seg.id)"
  public complete(id: string) {
    if (this.runId) this.hub.completeSegment(this.runId, id);
  }


  // ---------- Toasts ----------
  etaToasts: EtaToast[] = [];
  sermonEndToasts: { id: number; wall: Date | null }[] = [];
  private lastEtaAbsSec: number | null = null;
  private lastToastAt = 0;
  private lastSermonEndSec: number | null = null;
  private toastIdSeq = 1;

  @ViewChild('etaChime') etaChime?: ElementRef<HTMLAudioElement>;

  // ---------- Row highlight ----------
  private prevCompletedIds = new Set<string>();
  lastCompletedId: string | null = null;

  // ---------- Clocks ----------
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
    this.subRoute = this.route.paramMap.subscribe(async pm => {
      const id = pm.get('runId') ?? pm.get('id');
      if (!id || id === this.runId) return;
      this.runId = id;
      try {
        await this.hub.connect(id);
        this.rundownService.init(id);
        this.connected = true;
      } catch (e) {
        console.error('[EnglishView] connect failed', e);
        // (optional) set a field like this.connectErr = e;
      }

    });

    // If you still want a "latest" fallback, add a getLatestRunId() helper to RundownService and re-enable.
    // For now, require a concrete :runId in the route.
    // ===============================================================
    // Fallback to latest run when no id or "latest"
    // ===============================================================
    // this.store.getLatestRunId().subscribe(async ({ runId }) => {
    //   if (!runId) return;
    //   if (this.connected && runId === this.runId) return;
    //   this.runId = runId;
    //   try { await this.hub.connect(runId); this.connected = true; }
    //   catch (e) { this.connectErr = e; console.error('[EnglishView] connect failed', e); }
    // });



    // reflect hub state locally + drive toasts/highlights
    this.subState = this.hub.state$.subscribe((s) => {
      this.state = s as ViewStateDto | null;
      if (!s) return;

      this.updateHighlight(s as ViewStateDto);

      const eta = (s as ViewStateDto).spanish?.sermonEndEtaSec;
      if (typeof eta === 'number') this.onEtaUpdated(eta);

      const end = s.spanish?.sermonEndedAtSec ?? null;
      if (typeof end === 'number' && end > 0 && end !== this.lastSermonEndSec) {
        this.lastSermonEndSec = end;
        this.pushSermonEndedToast();
      }
    });

    // build a small view model for template convenience
    this.vm$ = combineLatest([
      this.hub.masterCountdown$.pipe(startWith(null as number | null)),
      this.hub.state$.pipe(startWith(this.state)),
    ]).pipe(map(([mc, s]) => ({ mc: mc ?? 0, s: s as ViewStateDto | null })));

    this.vmView$ = this.vm$.pipe(auditTime(0));
  }

  ngOnDestroy() {
    this.subRoute?.unsubscribe();
    this.subState?.unsubscribe();
    this.hub.disconnect();
    this.rundownService.dispose();   // <— clean up the rundown hub/subscriptions
  }

  // =========================================================
  // Actions (UI handlers)
  // =========================================================
  startRun() { if (this.runId) this.hub.startRun(this.runId); }

  sermonEnded() { if (this.runId) this.hub.sermonEnded(this.runId); }

  async startOffering() {
    if (!this.runId || this.offeringClicked) return;
    this.offeringClicked = true;
    try {
      await this.rundownService.startOffering(this.runId);
    } finally {
      this.offeringClicked = false; // optional: reset if you want re-click ability
    }
  }

  completeSegment(segId: string) { if (this.runId) this.hub.completeSegment(this.runId, segId); }

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
  // View helpers (segments / timing)
  // =========================================================
  isOfferingLocked(s: ViewStateDto): boolean {
    const seg = s.english.segments.find(x => /offering/i.test(x.name));
    if (!seg) return false;
    return !!seg.completed || (seg.actualSec ?? 0) > 0;
  }

  isActive(idx: number, segs: ViewStateDto['english']['segments']): boolean {
    if (!this.state?.masterStartAtUtc) return false;
    for (let i = 0; i < idx; i++) if (!segs[i].completed) return false;
    return !segs[idx].completed;
  }

  activeElapsedSec(idx: number, segs: ViewStateDto['english']['segments']): number {
    let sumActualBefore = 0;
    for (let i = 0; i < idx; i++) sumActualBefore += (segs[i].actualSec ?? 0);
    const masterStartMs = Date.parse(this.state!.masterStartAtUtc!);
    const segStartMs = masterStartMs + sumActualBefore * 1000;
    const nowMs = this.hub.serverNowMs();
    return Math.max(0, Math.floor((nowMs - segStartMs) / 1000));
  }

  endedAt(idx: number, segs: ViewStateDto['english']['segments']): Date | null {
    if (!this.state?.masterStartAtUtc || !segs[idx]?.completed) return null;
    let total = 0;
    for (let i = 0; i <= idx; i++) total += (segs[i].actualSec ?? 0);
    const endMs = Date.parse(this.state.masterStartAtUtc) + total * 1000;
    return new Date(endMs);
  }

  // =========================================================
  // Drift / ETA helpers
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
    const start = this.state?.masterStartAtUtc;
    if (!start) return null;
    const ms = this.hub.serverNowMs() - Date.parse(start);
    return Math.max(0, Math.floor(ms / 1000));
  }

  private spanishAnchorOrPlannedSec(s: ViewStateDto): number {
    const ended = s.spanish?.sermonEndedAtSec;
    const eta = s.spanish?.sermonEndEtaSec;
    if (typeof ended === 'number' && ended > 0) return ended;
    if (typeof eta === 'number' && eta > 0) return eta;
    return this.hub.masterTargetSec; // 36:00 fallback
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

  predictedLengthSec(s: ViewStateDto): number {
    const base = +(s.baseOfferingSec ?? 0);
    const plannedStart = this.plannedOfferingStartSec(s);
    if (plannedStart == null) return base;
    const drift = +(s.english.runningDriftBeforeOfferingSec ?? 0);
    const start = plannedStart + drift;
    const gap = Math.max(0, this.spanishAnchorOrPlannedSec(s) - start);
    return Math.max(base, gap);
  }

  predictedExtensionSec(s: ViewStateDto): number {
    const ext = this.predictedLengthSec(s) - +(s.baseOfferingSec ?? 0);
    return Math.max(0, ext);
  }

  private plannedOfferingStartSec(s: ViewStateDto): number | null {
    const idx = s.english.segments.findIndex(x => /offering/i.test(x.name));
    if (idx < 0) return null;
    let total = 0;
    for (let i = 0; i < idx; i++) total += (s.english.segments[i].plannedSec ?? 0);
    return total;
  }

  // =========================================================
  // Toasts
  // =========================================================
  private async onEtaUpdated(newEtaAbsSec: number) {
    if (!(newEtaAbsSec > 0)) return;
    if (this.lastEtaAbsSec != null && newEtaAbsSec === this.lastEtaAbsSec) return;

    const now = Date.now();
    if (now - this.lastToastAt < 800) return; // rate-limit duplicate bursts
    this.lastToastAt = now;

    this.lastEtaAbsSec = newEtaAbsSec;

    const nowElapsed = this.masterElapsedSec() ?? 0;
    const remSec = Math.max(0, Math.floor(newEtaAbsSec - nowElapsed));
    const deltaFromTarget = newEtaAbsSec - this.hub.masterTargetSec;

    const id = this.toastIdSeq++;
    const wall = new Date(this.hub.serverNowMs());
    this.etaToasts = [...this.etaToasts, { id, remSec, wall, deltaFromTarget }];

    try { await this.etaChime?.nativeElement.play(); } catch { /* no-op */ }
  }

  private pushSermonEndedToast() {
    const id = this.toastIdSeq++;
    const wall = this.spanishEndedAtWallTime();
    this.sermonEndToasts = [...this.sermonEndToasts, { id, wall: wall ?? null }];
  }

  closeEtaToast(id: number) {
    this.etaToasts = this.etaToasts.filter(t => t.id !== id);
  }

  closeSermonEndToast(id: number) {
    this.sermonEndToasts = this.sermonEndToasts.filter(t => t.id !== id);
  }

  spanishEtaSec(s: ViewStateDto | null): number | null {
    const manual = s?.spanish?.sermonEndEtaSec;
    return manual ?? null;
  }

  etaColor(etaSec: number): string {
    if (etaSec > this.hub.masterTargetSec) return '#dc2626';  // red = late
    if (etaSec < this.hub.masterTargetSec) return '#16a34a';  // green = early
    return 'inherit';
  }

  etaDeltaFromTarget(etaSec: number): number {
    return etaSec - this.hub.masterTargetSec;
  }

  spanishTimeLeftSec(): number | null {
    const ended = this.state?.spanish?.sermonEndedAtSec;
    if (ended != null && ended > 0) return 0;
    const etaAbs = this.state?.spanish?.sermonEndEtaSec;
    const now = this.masterElapsedSec();
    if (etaAbs == null || now == null) return null;
    return Math.max(0, etaAbs - now);
  }

  spanishEndedAtWallTime(): Date | null {
    const endSec = this.state?.spanish?.sermonEndedAtSec;
    const startStr = this.state?.masterStartAtUtc;
    if (typeof endSec !== 'number' || endSec <= 0) return null;
    if (!startStr) return null;
    const startMs = Date.parse(startStr);
    return new Date(startMs + endSec * 1000);
  }

  totalDurationSec(doc: { segments?: Array<{ durationSec?: number }> } | null | undefined): number {
    return (doc?.segments ?? []).reduce((sum, s) => sum + (s?.durationSec ?? 0), 0);
  }

}
