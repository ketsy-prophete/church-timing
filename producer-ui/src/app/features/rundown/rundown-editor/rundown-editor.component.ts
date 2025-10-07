import { Component, OnDestroy, OnInit, DestroyRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule, ReactiveFormsModule, FormArray, FormBuilder, FormControl, FormGroup, Validators } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { debounceTime } from 'rxjs/operators';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TrackByFunction } from '@angular/core';

import { TimePipe } from '../../../shared/time.pipe';
import { SignedTimePipe } from '../../../shared/signed-time.pipe';
import { RundownSegment } from '../../../models/rundown.models';
import { RundownService } from '../../../store/rundown.service';



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

  constructor(private fb: FormBuilder,
    private route: ActivatedRoute,
    private rundown: RundownService,
    private destroyRef: DestroyRef,
  ) {
    this.form = this.fb.group({
      serviceStart: this.fb.control<number>(0, { nonNullable: true }),
      segments: this.fb.array<FormGroup<RundownRow>>([])
    });
  }

  private isPatching = false;
  compact = true; // v1: show only #, Title, Start, Dur, End, Actions


  ngOnInit(): void {
    this.runId = this.route.snapshot.paramMap.get('runId')!;
    this.rundown.init(this.runId);



    // 1) React to store document changes
    this.rundown.doc$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(doc => {
        this.isPatching = true;


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

    this.form.controls.serviceStart.valueChanges
      .pipe(debounceTime(120), takeUntilDestroyed(this.destroyRef))
      .subscribe(val => {
        if (this.isPatching) return;
        this.rundown.setServiceStart(val ?? 0);
        this.recalc();
      });
  }

  ngOnDestroy(): void {
    this.rundown.dispose();
  }

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
      this.rundown.upsertSegment({ ...v });
      this.recalc();
    });

    return g;
  }


  // =================== Converting helpers for Start/Dur from secs (original) min/sec inputs =================== //
  // Read helpers
  minOf(sec?: number | null) { sec = sec ?? 0; return Math.floor(sec / 60); }
  secOf(sec?: number | null) { sec = sec ?? 0; return sec % 60; }

  // Write helpers (Duration)
  setDurMin(i: number, ev: Event) {
    const g = this.segmentsArray.at(i)!;
    const ss = this.secOf(g.controls.durationSec.value);
    const mm = Math.max(0, Number((ev.target as HTMLInputElement).value) | 0);
    g.controls.durationSec.setValue(mm * 60 + ss);
  }
  setDurSec(i: number, ev: Event) {
    const g = this.segmentsArray.at(i)!;
    const mm = this.minOf(g.controls.durationSec.value);
    let ss = Math.max(0, Number((ev.target as HTMLInputElement).value) | 0);
    if (ss > 59) ss = 59; // clamp
    g.controls.durationSec.setValue(mm * 60 + ss);
  }

  // Write helpers (Start)
  setStartMin(i: number, ev: Event) {
    const g = this.segmentsArray.at(i)!;
    const ss = this.secOf(g.controls.startSec.value);
    const mm = Math.max(0, Number((ev.target as HTMLInputElement).value) | 0);
    g.controls.startSec.setValue(mm * 60 + ss);
  }
  setStartSec(i: number, ev: Event) {
    const g = this.segmentsArray.at(i)!;
    const mm = this.minOf(g.controls.startSec.value);
    let ss = Math.max(0, Number((ev.target as HTMLInputElement).value) | 0);
    if (ss > 59) ss = 59; // clamp
    g.controls.startSec.setValue(mm * 60 + ss);
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
    this.rundown.upsertSegment({ ...newSeg });
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
    this.rundown.upsertSegment({ ...newSeg });
    this.isPatching = false;
  }

  remove(i: number) { this.rundown.remove(i); }
  moveUp(i: number) { this.rundown.moveUp(i); }
  moveDown(i: number) { this.rundown.moveDown(i); }
  reflowStarts() { this.rundown.reflowStarts(); }
  clearAll() { this.rundown.clearAll(); }

  import(jsonStr: string) {
    const data = JSON.parse(jsonStr);
    this.segmentsArray.clear();
    for (const seg of data.segments ?? []) {
      this.segmentsArray.push(this.createRow(seg)); // createRow assigns id if missing
    }
    this.form.controls.serviceStart.setValue(data.serviceStartSec ?? 0);
  }
  exportPretty(): string { return this.rundown.exportPretty(); }

  private recalc() { this.totalSec = this.rundown.totalSec(); this.overlapWarnings = this.rundown.overlaps(); }
  private runId!: string;

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
    const dto = {
      serviceStartSec: this.form.controls.serviceStart.value ?? 0,
      segments: this.segmentsArray.controls.map(fg => ({
        id: fg.controls.id.value,
        title: fg.controls.title.value?.trim() || 'Untitled',
        owner: fg.controls.owner.value || '',
        startSec: fg.controls.startSec.value ?? 0,
        durationSec: fg.controls.durationSec.value ?? 60,
        notes: fg.controls.notes.value || '',
        color: fg.controls.color.value || ''
      }))
    };

    this.rundown.saveRundown(this.runId, dto).subscribe({
      next: () => console.log('Rundown saved'),
      error: err => console.error('Save failed', err)
    });
  }

}

