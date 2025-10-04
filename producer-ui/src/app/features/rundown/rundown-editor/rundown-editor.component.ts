// src/app/features/rundown/rundown-editor/rundown-editor.component.ts
import { Component, OnDestroy, OnInit, DestroyRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule, ReactiveFormsModule, FormArray, FormBuilder, FormControl, FormGroup, Validators } from '@angular/forms';
import { TimePipe } from '../../../shared/time.pipe';            // name: 'mmss'
import { SignedTimePipe } from '../../../shared/signed-time.pipe'; // name: 'signedmmss'
import { debounceTime } from 'rxjs/operators';
import { RundownSegment } from '../../../models/rundown.models';
import { RundownService } from '../../../store/rundown.service';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

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

  constructor(private fb: FormBuilder, private store: RundownService, private destroyRef: DestroyRef) {
    this.form = this.fb.group({
      serviceStart: this.fb.control<number>(0, { nonNullable: true }),
      segments: this.fb.array<FormGroup<RundownRow>>([])
    });
  }

  ngOnInit(): void {
    this.store.doc$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(doc => {
      this.form.controls.serviceStart.setValue(doc.serviceStartSec, { emitEvent: false });
      while (this.segmentsArray.length) this.segmentsArray.removeAt(0);
      doc.segments.forEach(s => this.segmentsArray.push(this.segmentGroup(s)));
      this.recalc();
    });

    this.form.valueChanges.pipe(debounceTime(120), takeUntilDestroyed(this.destroyRef)).subscribe(() => {
      this.store.setServiceStart(this.form.controls.serviceStart.value ?? 0);
      const segs = this.segmentsArray.controls.map(g => g.getRawValue() as RundownSegment);
      this.store.replaceAll(segs);
      this.recalc();
    });
  }

  ngOnDestroy(): void {}

  private segmentGroup(s?: Partial<RundownSegment>) {
    return this.fb.group<RundownRow>({
      id: new FormControl<number>(s?.id ?? 0, { nonNullable: true }),
      title: new FormControl<string>(s?.title ?? '', { nonNullable: true, validators: [Validators.required] }),
      owner: new FormControl<string>(s?.owner ?? '', { nonNullable: true }),
      startSec: new FormControl<number>(s?.startSec ?? 0, { nonNullable: true, validators: [Validators.min(0)] }),
      durationSec: new FormControl<number>(s?.durationSec ?? 60, { nonNullable: true, validators: [Validators.min(1)] }),
      notes: new FormControl<string>(s?.notes ?? '', { nonNullable: true }),
      color: new FormControl<string>(s?.color ?? '', { nonNullable: true }),
    });
  }

  addSegment(i?: number) { this.store.insertAfter(typeof i === 'number' ? i : this.segmentsArray.length - 1); }
  duplicate(i: number) { this.store.duplicate(i); }
  remove(i: number) { this.store.remove(i); }
  moveUp(i: number) { this.store.moveUp(i); }
  moveDown(i: number) { this.store.moveDown(i); }
  reflowStarts() { this.store.reflowStarts(); }
  clearAll() { this.store.clearAll(); }

  import(json: string) { try { this.store.import(json); } catch { alert('Invalid JSON'); } }
  exportPretty(): string { return this.store.exportPretty(); }

  private recalc() { this.totalSec = this.store.totalSec(); this.overlapWarnings = this.store.overlaps(); }

  copyJson() {
    const text = this.exportPretty();
    if (navigator?.clipboard?.writeText) navigator.clipboard.writeText(text);
  }
}
