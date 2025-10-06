// src/app/features/rundown/rundown-editor/rundown-editor.component.ts
import { Component, OnDestroy, OnInit, DestroyRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule, ReactiveFormsModule, FormArray, FormBuilder, FormControl, FormGroup, Validators } from '@angular/forms';
import { TimePipe } from '../../../shared/time.pipe';
import { SignedTimePipe } from '../../../shared/signed-time.pipe';
import { debounceTime } from 'rxjs/operators';
import { RundownSegment } from '../../../models/rundown.models';
import { RundownService } from '../../../store/rundown.service';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TrackByFunction } from '@angular/core';


type RundownRow = {
  id: FormControl<number>;
  title: FormControl<string>;
  owner: FormControl<string>;
  startSec: FormControl<number>;
  durationSec: FormControl<number>;
  notes: FormControl<string>;
  color: FormControl<string>;
};

@Component({
  selector: 'app-rundown-editor',
  standalone: true,
  imports: [CommonModule, FormsModule, ReactiveFormsModule, TimePipe, SignedTimePipe],
  templateUrl: './rundown-editor.component.html',
  styleUrls: ['./rundown-editor.component.css']
})
export class RundownEditorComponent implements OnInit, OnDestroy {
  form!: FormGroup<{ serviceStart: FormControl<number>; segments: FormArray<FormGroup<RundownRow>>; }>;
  get segmentsArray() { return this.form.controls.segments; }
  totalSec = 0;
  overlapWarnings: string[] = [];
  private nextId = 1;

  constructor(private fb: FormBuilder, private store: RundownService, private destroyRef: DestroyRef, private rundown: RundownService
  ) {
    this.form = this.fb.group({
      serviceStart: this.fb.control<number>(0, { nonNullable: true }),
      segments: this.fb.array<FormGroup<RundownRow>>([])
    });
  }

  private isPatching = false;
  compact = true; // v1: show only #, Title, Start, Dur, End, Actions


  ngOnInit(): void {
    // 1) React to store document changes
    this.store.doc$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(doc => {
        this.isPatching = true;

        // top control
        this.form.controls.serviceStart.setValue(doc.serviceStartSec ?? 0, { emitEvent: false });

        const fa = this.segmentsArray;
        const storeSegs = doc.segments ?? [];

        const lengthChanged = fa.length !== storeSegs.length;

        if (lengthChanged) {
          // Rebuild only when the count differs
          while (fa.length) fa.removeAt(0, { emitEvent: false });
          storeSegs.forEach(s => fa.push(this.segmentGroup(s), { emitEvent: false }));
        } else {
          // Same count: keep groups, just reorder and patch in place (preserves focus)
          this.reorderToMatchStore(storeSegs);
          // inside the "patch values in place" loop
          storeSegs.forEach((s, i) => {
            const g = fa.at(i)!;

            // 👇 sync id first (no events → won’t loop)
            if (g.controls.id.value !== s.id) {
              g.controls.id.setValue(s.id, { emitEvent: false });
            }

            g.patchValue(
              {
                title: s.title ?? '',
                owner: s.owner ?? '',
                startSec: s.startSec ?? 0,
                durationSec: s.durationSec ?? 60,
                notes: s.notes ?? '',
                color: s.color ?? ''
              },
              { emitEvent: false }
            );
          });

        }

        this.recalc();
        this.isPatching = false;
      });

    // 2) Push top-level control changes to store
    this.form.controls.serviceStart.valueChanges
      .pipe(debounceTime(120), takeUntilDestroyed(this.destroyRef))
      .subscribe(val => {
        if (this.isPatching) return;
        this.store.setServiceStart(val ?? 0);
        this.recalc();
      });
  }

  ngOnDestroy(): void { }

  private segmentGroup(s: Partial<RundownSegment> = {}) {
    const idValue = s.id ?? this.nextId++;
    if (s.id != null) this.nextId = Math.max(this.nextId, s.id + 1);

    const g = this.fb.group<RundownRow>({
      id: new FormControl<number>(idValue, { nonNullable: true }),
      title: new FormControl<string>(s.title ?? '', { nonNullable: true, validators: [Validators.required] }),
      owner: new FormControl<string>(s.owner ?? '', { nonNullable: true }),
      startSec: new FormControl<number>(s.startSec ?? 0, { nonNullable: true, validators: [Validators.min(0)] }),
      durationSec: new FormControl<number>(s.durationSec ?? 60, { nonNullable: true, validators: [Validators.min(1)] }),
      notes: new FormControl<string>(s.notes ?? '', { nonNullable: true }),
      color: new FormControl<string>(s.color ?? '', { nonNullable: true }),
    });

    g.valueChanges.pipe(debounceTime(120)).subscribe(() => {
      if (this.isPatching) return;
      const v = g.getRawValue();
      this.store.upsertSegment({ ...v });
      this.recalc();
    });

    return g;
  }



  addSegment() {
    const newSeg: RundownSegment = {
      id: this.nextId++,
      title: '',
      owner: '',
      startSec: 0,
      durationSec: 60,
      notes: '',
      color: '#5b9',
    };

    // Create the row in-place (no value-change storm)
    const g = this.segmentGroup(newSeg);
    this.segmentsArray.push(g, { emitEvent: false });

    // Tell the store right away so doc$ matches the UI
    this.isPatching = true;
    this.store.upsertSegment({ ...newSeg });
    this.isPatching = false;
  }

  duplicate(i: number) {
    const src = this.segmentsArray.at(i)!.getRawValue();
    const newSeg: RundownSegment = {
      ...src,
      id: this.nextId++,       // ensure a fresh id
    };

    const g = this.segmentGroup(newSeg);
    this.segmentsArray.insert(i + 1, g, { emitEvent: false });

    // Keep store in sync immediately (prevents the "first keypress" blur/ghost row)
    this.isPatching = true;
    this.store.upsertSegment({ ...newSeg });
    this.isPatching = false;
  }

  remove(i: number) { this.store.remove(i); }
  moveUp(i: number) { this.store.moveUp(i); }
  moveDown(i: number) { this.store.moveDown(i); }
  reflowStarts() { this.store.reflowStarts(); }
  clearAll() { this.store.clearAll(); }

  import(jsonStr: string) {
    const data = JSON.parse(jsonStr);
    this.segmentsArray.clear();
    for (const seg of data.segments ?? []) {
      this.segmentsArray.push(this.createRow(seg)); // createRow assigns id if missing
    }
    this.form.controls.serviceStart.setValue(data.serviceStartSec ?? 0);
  }
  exportPretty(): string { return this.store.exportPretty(); }

  private recalc() { this.totalSec = this.store.totalSec(); this.overlapWarnings = this.store.overlaps(); }

  copyJson() {
    const text = this.exportPretty();
    if (navigator?.clipboard?.writeText) navigator.clipboard.writeText(text);
  }

  trackBySegment: TrackByFunction<FormGroup<RundownRow>> =
    (_: number, g) => g;




  // Helper to make a row (accepts values, not controls)
  private createRow(init: Partial<RundownSegment> = {}): FormGroup<RundownRow> {
    return this.segmentGroup(init);
  }

  private reorderToMatchStore(storeSegs: RundownSegment[]) {
    const fa = this.segmentsArray;
    const currentIds = Array.from({ length: fa.length }, (_, i) => fa.at(i)!.controls.id.value);

    for (let i = 0; i < storeSegs.length; i++) {
      const targetId = storeSegs[i].id;
      if (fa.at(i)!.controls.id.value === targetId) continue;

      const from = currentIds.indexOf(targetId);
      if (from === -1) continue; // id not present yet; let the next doc$ tick handle it

      const g = fa.at(from)!;
      fa.removeAt(from, { emitEvent: false });
      fa.insert(i, g, { emitEvent: false });

      currentIds.splice(from, 1);
      currentIds.splice(i, 0, targetId);
    }
  }

  pushToBackend() {
    const items = this.segmentsArray.controls.map(fg => ({
      Name: (fg.value.title ?? '').toString().trim() || 'Untitled',
      PlannedSec: Number(fg.value.durationSec ?? 0) | 0
    }));

    const go = (runId: string) => {
      this.rundown.startRun(runId).subscribe({
        next: () => {
          this.rundown.appendSegments(runId, items).subscribe({
            next: res => {
              console.log('Rundown appended', res);
              // TODO: show toast “Rundown sent to Producer”
            },
            error: err => console.error('Append failed', err)
          });
        },
        error: err => console.error('Start failed', err)
      });
    };

    const existing = this.rundown.runId;
    if (existing) {
      go(existing);
    } else {
      this.rundown.getLatestRunId().subscribe({
        next: ({ runId }) => { this.rundown.setRunId(runId); go(runId); },
        error: err => console.error('Could not get latest run id', err)
      });
    }
  }



}
