// src/app/features/english/english-view.component.ts
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
  styles: [`
    /* ---- Layout basics ---- */
    .bar { display:flex; gap:12px; align-items:center; margin:8px 0; }
    table { border-collapse:collapse; }
    th, td { padding:6px 8px; border:1px solid #ccc; }

    /* ---- Titlebar / live dot / clocks ---- */
    .titlebar { display:flex; align-items:center; gap:12px; }
    .titlebar h2 { margin:0; }
    .dot { width:8px; height:8px; border-radius:50%; background:#bbb; display:inline-block; margin-left:6px; }
    .dot.live { background:#2ecc71; animation:pulse 1s infinite; }
    .dot.ended { background:#e53935; animation:none; }

    .clock {
      margin-left:auto;
      display:flex;
      align-items:flex-end;
      gap:12px;      /* separates the stack and the "last sync" label */
      font-weight:400;
    }
    .clock .stack {
      display:flex;
      flex-direction:column;
      align-items:flex-end;
      line-height:1.15;
    }
    .clock-time { font-weight:700; font-size:20px; line-height:1; }
    .clock-date { font-weight:500; font-size:12px; opacity:.8; line-height:1.2; }
    .last-sync  { white-space:nowrap; opacity:.8; align-self:flex-end; }

    @keyframes pulse { 0%{opacity:.4} 50%{opacity:1} 100%{opacity:.4} }

    /* ---- Segments table / states ---- */
    .segments-wrap { display:inline-block; }
    .segments-wrap table { width:auto; }
    .segments-head { display:flex; align-items:baseline; justify-content:space-between; gap:12px; margin:16px 0 8px; }
    .segments-head h3 { margin:0; }
    .total-drift { font-weight:600; white-space:nowrap; }

    .time-red { color:#e53935; }
    .over { color:#000000; }
    .under { color:#dc2626; }
    .actual-cell { min-width:96px; }
    .actual-primary { font-weight:600; line-height:1.1; }

    /* ---- Toasts ---- */
    .toast-wrap { position:fixed; right:16px; bottom:16px; display:flex; flex-direction:column; gap:8px; z-index:1000; pointer-events:none; }
    .toast { pointer-events:auto; position:relative; background:#111; color:#fff; border-radius:6px; padding:14px 36px 12px 12px; box-shadow:0 6px 24px rgba(0,0,0,.25); font-size:13px; border-left:4px solid transparent; }
    .toast.small { padding:10px 12px; }
    .toast small { opacity:.8; }
    .toast.delta-early { border-left-color:#16a34a; }
    .toast.delta-late  { border-left-color:#dc2626; }
    .toast.alert { background:#dc2626; color:#fff; }
    .toast-close { position:absolute; top:8px; right:10px; background:transparent; border:none; cursor:pointer; color:inherit; font-size:16px; line-height:1; }
    .toast > div:first-child { display:block; padding-right:28px; }
    .toast .stamp { opacity:.72; display:block; margin-top:4px; font-style:italic; }
  `],
})

export class EnglishViewComponent implements OnInit, OnDestroy {
  // ---------- DI ----------
  private route = inject(ActivatedRoute);
  private fb = inject(FormBuilder);
  private store = inject(RundownService);
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

  // ---------- Forms ----------
  etaForm = this.fb.group({
    etaSec: this.fb.control<number | null>(null),
  });

  // ---------- UI / view helpers ----------
  offeringClicked = false;
  trackBySeg: TrackByFunction<ViewStateDto['english']['segments'][number]> = (_i, s) => s.id;
  get doc$() { return this.store.doc$; }
  // ----- SHIMS for current template -----

  // Used by multiple *ngFor (segments, etaToasts, sermonEndToasts, doc.segments)
  public trackById: TrackByFunction<any> = (_: number, row: any) => row?.id ?? _;

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
  async ngOnInit() {
    // pick up :runId or :id (supports both route shapes)
    this.subRoute = this.route.paramMap.subscribe(async (pm) => {
      let id = pm.get('runId') ?? pm.get('id') ?? '';

      if (id && id !== 'latest') {
        if (this.connected && id === this.runId) return;
        this.runId = id;
        try { await this.hub.connect(this.runId); this.connected = true; }
        catch (e) { this.connectErr = e; console.error('[EnglishView] connect failed', e); }
        return;
      }

      // Fallback to latest run when no id or "latest"
      this.store.getLatestRunId().subscribe(async ({ runId }) => {
        if (!runId) return;
        if (this.connected && runId === this.runId) return;
        this.runId = runId;
        try { await this.hub.connect(runId); this.connected = true; }
        catch (e) { this.connectErr = e; console.error('[EnglishView] connect failed', e); }
      });
    });


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
  }

  // =========================================================
  // Actions (UI handlers)
  // =========================================================
  startRun() { if (this.runId) this.hub.startRun(this.runId); }
  sermonEnded() { if (this.runId) this.hub.sermonEnded(this.runId); }
  startOffering() {
    if (!this.runId || this.offeringClicked) return;
    this.offeringClicked = true;
    this.hub.startOffering(this.runId);
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
}
