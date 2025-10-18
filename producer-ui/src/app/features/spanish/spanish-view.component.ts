import { Component, OnInit, OnDestroy, inject, TrackByFunction } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute } from '@angular/router';
import {
  Observable, Subscription, interval, map, startWith, combineLatest
} from 'rxjs';
import { TimePipe } from '../../shared/time.pipe';
import { SignedTimePipe } from '../../shared/signed-time.pipe';
import { SignalrService } from '../../core/services/signalr';
import type { StateDto as BaseStateDto } from '../../core/services/signalr';
import { RundownService } from '../../store/rundown.service';
import { RundownSegment } from '../../models/rundown.models';

type StateDto = BaseStateDto & {
  spanish: BaseStateDto['spanish'] & { sermonEndEtaSec?: number };
};

// Shape of English segments coming from hub/state (not the RundownDoc)
type EnglishSeg = {
  id: string;
  order: number;
  name: string;
  plannedSec: number;
  actualSec?: number;
  driftSec?: number;
  completed?: boolean;
};

@Component({
  standalone: true,
  selector: 'app-spanish-view',
  imports: [CommonModule, TimePipe, SignedTimePipe], // 
  templateUrl: './spanish-view.component.html',
  styleUrls: ['./spanish-view.component.css'],
})
export class SpanishViewComponent implements OnInit, OnDestroy {
  state: StateDto | null = null;
  private route = inject(ActivatedRoute);
  private rundown = inject(RundownService);
  public hub = inject(SignalrService);
  private subRoute?: Subscription;
  private subState?: Subscription;
  runId!: string;

  private currentRunId?: string;

  // Streams
  doc$ = this.rundown.doc$;
  vm$!: Observable<{ mc: number; s: StateDto | null }>;

  // UI state
  sermonEndClicked = false;
  showMiniRundown = false;

  // Trackers / highlights
  private prevCompletedIds = new Set<string>();
  lastCompletedId: string | null = null;

  // trackBy helpers
  trackById: TrackByFunction<RundownSegment> = (_i, row) => row.id;
  trackBySegWrap = (_: number, row: { seg: { id: string } }) => row.seg.id;
  trackBySeg = (index: number, seg: { id?: string } | null | undefined) => seg?.id ?? index;

  constructor(private sync: SignalrService) { }

  // ---------- Lifecycle ----------
  async ngOnInit() {
    this.state = this.hub.state$.value;

    this.subRoute = this.route.paramMap.subscribe(async (pm) => {
      const id = pm.get('runId') ?? pm.get('id');
      if (!id || id === this.runId) return;
      this.runId = id;
      await this.hub.connect(id);
      this.rundown.init(id);
    });

    this.vm$ = combineLatest([
      this.hub.masterCountdown$.pipe(startWith(null as number | null)),
      this.hub.state$.pipe(startWith(this.state)),
    ]).pipe(map(([mc, s]) => ({ mc: mc ?? 0, s })));

    this.subState = this.hub.state$.subscribe((s) => {
      this.state = s as StateDto | null;
      this.updateHighlight(this.state);
    });

  }

  ngOnDestroy() {
    this.subRoute?.unsubscribe();
    this.subState?.unsubscribe();
    this.hub.disconnect();
    this.rundown.dispose();
  }


  // ---------- Actions ----------
  startRun() { this.hub.startRun(this.runId); }

  sermonEnd() {
    if (this.sermonEndClicked) return;
    this.sermonEndClicked = true;
    this.hub.sermonEnded(this.runId);
  }

  // ---------- Clocks ----------
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

  // ---------- Remaining helper & other methods ----------
  private parseMmSs(txt: string): number | null {
    const m = /^(\d{1,3}):([0-5]\d)$/.exec(txt.trim());
    if (!m) return null;
    return Number(m[1]) * 60 + Number(m[2]);
  }

  mmssValid(v: string): boolean {
    return /^\d{1,3}:[0-5]\d$/.test((v ?? '').trim());
  }

  private masterElapsedSec(): number | null {
    const start = this.state?.masterStartUtc;
    if (!start) return null;
    const ms = this.hub.serverNowMs() - Date.parse(start);
    return Math.max(0, Math.floor(ms / 1000));
  }

  async setSpanishEtaFromText(txt: string) {
    const remaining = this.parseMmSs(txt);
    if (remaining == null) return;
    const now = this.masterElapsedSec();
    if (now == null) return;
    await this.setSpanishEtaAbs(now + remaining);
  }

  async setSpanishEtaAbs(sec: number) {
    if (sec == null || !isFinite(sec)) return;
    const eta = Math.max(0, Math.floor(sec));
    try {
      await this.hub.setSpanishEta(this.runId, eta);
    } catch (err) {
      console.error('[ETA] SetSpanishEta failed:', err);
    }
  }

  // ---------- Completed English w/ cumulative drift ----------
  get completedEnglishWithRunning() {
    let sum = 0;
    const list = ((this.state?.english?.segments ?? []) as unknown as EnglishSeg[])
      .filter((s) => !!s.completed)
      .slice()
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

    return list.map((seg) => {
      const drift = +(seg.driftSec ?? 0);
      sum += drift;
      return { seg, running: sum };
    });
  }

  get completedEnglishSorted(): EnglishSeg[] {
    return ((this.state?.english?.segments ?? []) as unknown as EnglishSeg[])
      .filter((s) => !!s.completed)
      .slice()
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }

  // NEW: all English segments, sorted by order (completed + not completed)
  get englishSegmentsSorted(): EnglishSeg[] {
    return ((this.state?.english?.segments ?? []) as unknown as EnglishSeg[])
      .slice()
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }

  // Running total drift per row (completed rows add to the sum; others show current total)
  get englishSegmentsWithRunning(): Array<EnglishSeg & { running: number | null }> {
    const segs = this.englishSegmentsSorted;
    let sum = 0;
    return segs.map(seg => {
      if (seg.completed) sum += Number(seg.driftSec ?? 0);
      return { ...seg, running: seg.completed ? sum : null };
    });
  }



  private updateHighlight(s: StateDto | null) {
    if (!s?.english?.segments) return;
    const completed = (s.english.segments as unknown as EnglishSeg[]).filter((x) => x.completed);
    const completedIds = new Set(completed.map((x) => x.id));
    const newlyCompleted = completed.filter((x) => !this.prevCompletedIds.has(x.id));

    if (newlyCompleted.length > 0) {
      newlyCompleted.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      this.lastCompletedId = newlyCompleted[newlyCompleted.length - 1].id;
    }
    // If there are newly completed segments, pick the latest; otherwise, on first load, fall back to the highest-order completed segment.
    const source = newlyCompleted.length > 0 ? newlyCompleted : completed;
    if (source.length > 0) {
      source.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      this.lastCompletedId = source[source.length - 1].id;
    } else {
      this.lastCompletedId = null;
    }
    this.prevCompletedIds = completedIds;
  }

  endedAtFor(segId: string, segs: EnglishSeg[]): Date | null {
    if (!this.state?.masterStartUtc) return null;
    const seg = segs.find((s) => s.id === segId);
    if (seg?.completed && typeof seg.actualSec === 'number') {
      const endMs = Date.parse(this.state.masterStartUtc) + seg.actualSec * 1000;
      return new Date(endMs);
    }
    return null;
  }

  currentSpanishRemainingSec(): number | null {
    const ended = this.state?.spanish?.sermonEndedAtSec;
    if (ended != null && ended > 0) return 0;
    const etaAbs = this.state?.spanish?.sermonEndEtaSec;
    const start = this.state?.masterStartUtc;
    if (etaAbs == null || !start) return null;
    const now = Math.max(0, Math.floor((this.hub.serverNowMs() - Date.parse(start)) / 1000));
    return Math.max(0, etaAbs - now);
  }

  spanishEndedAtWallTime(): Date | null {
    const endSec = this.state?.spanish?.sermonEndedAtSec;
    const startStr = this.state?.masterStartUtc;
    if (typeof endSec !== 'number' || endSec <= 0) return null;
    if (!startStr) return null;
    const startMs = Date.parse(startStr);
    return new Date(startMs + endSec * 1000);
  }

  // ---------- RundownDoc helpers ----------
  totalDurationSec(doc: { segments?: Array<{ durationSec?: number }> } | null | undefined): number {
    return (doc?.segments ?? []).reduce((sum, s) => sum + (s?.durationSec ?? 0), 0);
  }

  displayTitleDoc(seg: RundownSegment): string {
    return seg.title || 'Untitled';
  }

  displayDurDoc(seg: RundownSegment): number {
    return seg.durationSec ?? 0;
  }
}
