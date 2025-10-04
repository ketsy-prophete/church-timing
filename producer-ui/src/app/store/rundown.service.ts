import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { RundownDoc, RundownSegment } from '../models/rundown.models';

const LS_KEY = 'rundown.v1';
let _id = 1;
const newId = () => _id++;

@Injectable({ providedIn: 'root' })
export class RundownService {
    private readonly _doc$ = new BehaviorSubject<RundownDoc>(this.load());
    readonly doc$ = this._doc$.asObservable();

    // --- getters ---
    get value() { return this._doc$.value; }
    get segments() { return this.value.segments; }

    // --- mutations ---
    setServiceStart(sec: number) {
        this.commit({ ...this.value, serviceStartSec: Math.max(0, sec | 0) });
    }

    upsertSegment(seg: RundownSegment) {
        const list = [...this.segments];
        const idx = list.findIndex(s => s.id === seg.id);
        if (idx >= 0) list[idx] = seg; else list.push({ ...seg, id: newId() });
        this.commit({ ...this.value, segments: list });
    }

    replaceAll(segments: RundownSegment[]) {
        this.commit({ ...this.value, segments: [...segments] });
    }

    insertAfter(i: number, base?: Partial<RundownSegment>) {
        const list = [...this.segments];
        const prev = list[i] ?? list[i - 1];
        const startSec = prev ? prev.startSec + prev.durationSec : 0;
        const seg: RundownSegment = {
            id: newId(),
            title: base?.title ?? '',
            owner: base?.owner ?? '',
            startSec: base?.startSec ?? startSec,
            durationSec: base?.durationSec ?? 60,
            notes: base?.notes ?? '',
            color: base?.color ?? ''
        };
        list.splice(i + 1, 0, seg);
        this.commit({ ...this.value, segments: list });
    }

    duplicate(i: number) {
        const v = this.segments[i]; if (!v) return;
        const clone = { ...v, id: newId() };
        const list = [...this.segments];
        list.splice(i + 1, 0, clone);
        this.commit({ ...this.value, segments: list });
    }

    remove(i: number) {
        const list = [...this.segments];
        list.splice(i, 1);
        this.commit({ ...this.value, segments: list });
    }

    moveUp(i: number) {
        if (i <= 0) return;
        const list = [...this.segments];
        const [item] = list.splice(i, 1);
        list.splice(i - 1, 0, item);
        this.commit({ ...this.value, segments: list });
    }

    moveDown(i: number) {
        const list = [...this.segments];
        if (i >= list.length - 1) return;
        const [item] = list.splice(i, 1);
        list.splice(i + 1, 0, item);
        this.commit({ ...this.value, segments: list });
    }

    reflowStarts() {
        const list = [...this.segments];
        let cursor = 0;
        for (const s of list) {
            s.startSec = cursor;
            cursor += Math.max(1, s.durationSec | 0);
        }
        this.commit({ ...this.value, segments: list });
    }

    clearAll() {
        this.commit({ serviceStartSec: 0, segments: [this.blank()] });
    }

    // --- utils / derived ---
    totalSec(): number {
        return this.segments.reduce((a, s) => a + (s.durationSec | 0), 0);
    }

    overlaps(): string[] {
        const warns: string[] = [];
        const sorted = [...this.segments].sort((a, b) => a.startSec - b.startSec);
        for (let i = 0; i < sorted.length - 1; i++) {
            const a = sorted[i], b = sorted[i + 1];
            const aEnd = a.startSec + a.durationSec;
            if (b.startSec < aEnd) warns.push(`“${a.title || 'Untitled'}” overlaps “${b.title || 'Untitled'}” by ${aEnd - b.startSec}s`);
        }
        return warns;
    }

    exportPretty(): string { return JSON.stringify(this.value, null, 2); }
    import(json: string) {
        const parsed = JSON.parse(json) as RundownDoc;
        if (!parsed?.segments) throw new Error('Invalid JSON');
        this.commit(parsed);
    }

    // --- internal ---
    private commit(doc: RundownDoc) {
        this._doc$.next(doc);
        localStorage.setItem(LS_KEY, JSON.stringify(doc));
    }

    private load(): RundownDoc {
        try {
            const raw = localStorage.getItem(LS_KEY);
            if (raw) return JSON.parse(raw) as RundownDoc;
        } catch { }
        return { serviceStartSec: 0, segments: [this.blank()] };
    }

    private blank(): RundownSegment {
        return { id: newId(), title: '', owner: '', startSec: 0, durationSec: 60, notes: '', color: '' };
    }
}
