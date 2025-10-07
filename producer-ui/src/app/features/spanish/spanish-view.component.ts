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
  templateUrl: './spanish-view.component.html',
  styleUrls: ['./spanish-view.component.css'],
})

export class SpanishViewComponent implements OnInit {
  state: StateDto | null = null;
  private runId!: string;

  vm$!: Observable<{ mc: number; s: StateDto | null }>;

  sermonEndClicked = false;

  // track most-recently completed English segment
  private prevCompletedIds = new Set<string>();
  lastCompletedId: string | null = null;



  // parse strictly "mm:ss" (00–59 seconds); returns null if invalid
  private parseMmSs(txt: string): number | null {
    const m = /^(\d{1,3}):([0-5]\d)$/.exec(txt.trim());
    if (!m) return null;
    return Number(m[1]) * 60 + Number(m[2]);
  }

  // Add this inside the class (anywhere with your other helpers)
  mmssValid(v: string): boolean {
    return /^\d{1,3}:[0-5]\d$/.test((v ?? '').trim());
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


  async setSpanishEtaFromText(txt: string) {
    const remaining = this.parseMmSs(txt);
    if (remaining == null) {
      console.warn('[ETA] Invalid mm:ss:', txt);
      return;
    }

    const now = this.masterElapsedSec();
    if (now == null) {
      console.warn('[ETA] Master not started; cannot set absolute ETA.');
      return;
    }

    await this.setSpanishEtaAbs(now + remaining);
  }

  private masterElapsedSec(): number | null {
    const start = this.state?.masterStartAtUtc;
    if (!start) return null;
    const ms = this.hub.serverNowMs() - Date.parse(start);
    return Math.max(0, Math.floor(ms / 1000));
  }



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


  currentSpanishRemainingSec(): number | null {
    const ended = this.state?.spanish?.sermonEndedAtSec;
    if (ended != null && ended > 0) return 0;                  // ← freeze at 0 after final
    const etaAbs = this.state?.spanish?.sermonEndEtaSec;
    const start = this.state?.masterStartAtUtc;
    if (etaAbs == null || !start) return null;
    const now = Math.max(0, Math.floor((this.hub.serverNowMs() - Date.parse(start)) / 1000));
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



}
