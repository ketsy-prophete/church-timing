import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
// src/app/store/rundown-store.service.ts
import { RundownDoc, RundownSegment } from '../models/rundown.models';


@Injectable({ providedIn: 'root' })
export class RundownStore {
    // Initial empty doc
    private readonly _state = new BehaviorSubject<RundownDoc>({
        runId: undefined,
        serviceStartSec: 0,
        segments: []
    });

    readonly state$ = this._state.asObservable();
    get state(): RundownDoc { return this._state.value; }

    /** Replace whole doc */
    private set(doc: RundownDoc) { this._state.next(doc); }

    /** Patch helper */
    private patch(partial: Partial<RundownDoc>) {
        this.set({ ...this.state, ...partial });
    }

    // ---- Mutations ----
    setRunId(runId: string) { this.patch({ runId }); }

    setServiceStart(sec: number) {
        this.patch({ serviceStartSec: sec });
    }

    addSegment(init?: Partial<Omit<RundownSegment, 'id' | 'title' | 'durationSec' | 'startSec'>>) {
        const id = this.nextId();
        const seg: RundownSegment = {
            id,
            title: 'New Segment',
            durationSec: 300,
            startSec: 0,
            ...init
        };
        this.patch({ segments: [...this.state.segments, seg] });
    }

    updateSegment(id: number, changes: Partial<RundownSegment>) {
        const segments = this.state.segments.map(s => (s.id === id ? { ...s, ...changes } : s));
        this.patch({ segments });
    }

    removeSegment(id: number) {
        this.patch({ segments: this.state.segments.filter(s => s.id !== id) });
    }

    clear() {
        this.set({ runId: this.state.runId, serviceStartSec: 0, segments: [] });
    }

    /** Fill startSec by cascading from serviceStartSec + each prior duration */
    autoFillStarts() {
        let t = this.state.serviceStartSec;
        const segments = this.state.segments.map(s => {
            const withStart = { ...s, startSec: t };
            t += s.durationSec;
            return withStart;
        });
        this.patch({ segments });
    }

    /** Import/export */
    import(json: string) {
        try {
            const parsed = JSON.parse(json) as RundownDoc;
            // Minimal shape check
            if (!parsed || !Array.isArray(parsed.segments) || typeof parsed.serviceStartSec !== 'number') {
                throw new Error('Invalid rundown shape');
            }
            this.set(parsed);
        } catch (e) {
            throw new Error('Invalid JSON: ' + (e as Error).message);
        }
    }

    export(pretty = true): string {
        return JSON.stringify(this.state, pretty ? null : undefined, pretty ? 2 : undefined);
    }

    // ---- Utils ----
    private nextId(): number {
        const max = this.state.segments.reduce((m, s: RundownSegment) => Math.max(m, s.id), 0);
        return max + 1;
    }
}
