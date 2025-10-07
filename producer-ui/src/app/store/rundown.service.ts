import { Injectable } from '@angular/core';
import { BehaviorSubject, firstValueFrom } from 'rxjs';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import * as signalR from '@microsoft/signalr';

import { environment } from '../../environments/environment';
import { RundownDoc, RundownSegment } from '../models/rundown.models';

type SaveDto = {
    serviceStartSec: number;
    segments: Array<{
        id: number;
        title: string;
        owner: string;
        startSec: number;
        durationSec: number;
        notes: string;
        color: string;
    }>;
};

@Injectable({ providedIn: 'root' })
export class RundownService {
    // ---- state ----
    private _doc$ = new BehaviorSubject<RundownDoc>({ serviceStartSec: 0, segments: [] });
    readonly doc$ = this._doc$.asObservable();

    private hub?: signalR.HubConnection;
    private runId: string | null = null;

    constructor(private http: HttpClient) { }

    // ---- lifecycle ----
    init(runId: string) {
        if (this.runId === runId && this.hub && this.hub.state === signalR.HubConnectionState.Connected) return;
        this.runId = runId;

        // initial load from API
        this.reload();

        // connect SignalR
        this.hub = new signalR.HubConnectionBuilder()
            .withUrl(environment.hubUrl)
            .withAutomaticReconnect()
            .build();

        this.hub.on('RundownUpdated', (payload: { runId: string }) => {
            if (payload?.runId === this.runId) this.reload();
        });

        this.hub.start().catch(err => console.error('hub start failed', err));
    }

    dispose() {
        this.hub?.stop().catch(() => { });
        this.hub = undefined;
    }

    // ---- server calls ----
    private async reload() {
        if (!this.runId) return;
        try {
            const state = await firstValueFrom(this.http.get<RundownDoc>(`${environment.apiBaseUrl}/api/runs/${this.runId}/rundown/state`));
            this._doc$.next(state ?? { serviceStartSec: 0, segments: [] });
        } catch (e) {
            console.error('reload failed', e);
        }
    }

    saveRundown(runId: string, dto: SaveDto) {
        const headers = new HttpHeaders({ 'Content-Type': 'application/json' });
        return this.http.post<void>(`${environment.apiBaseUrl}/api/runs/${runId}/rundown/save`, dto, { headers });
    }

    // ---- local mutations (keeps your editor logic working) ----

    clearAll() {
        this._doc$.next({ serviceStartSec: 0, segments: [] });
    }

    setServiceStart(sec: number) {
        const d = { ...this._doc$.value, serviceStartSec: sec | 0 };
        this._doc$.next(d);
    }

    upsertSegment(seg: RundownSegment) {
        const d = { ...this._doc$.value };
        const idx = (d.segments ?? []).findIndex(s => s.id === seg.id);
        if (idx >= 0) d.segments![idx] = { ...d.segments![idx], ...seg };
        else d.segments = [...(d.segments ?? []), { ...seg }];
        this._doc$.next(d);
    }

    remove(i: number) {
        const d = { ...this._doc$.value };
        d.segments = [...(d.segments ?? [])];
        d.segments.splice(i, 1);
        this._doc$.next(d);
    }

    moveUp(i: number) { if (i <= 0) return; this.swap(i, i - 1); }
    moveDown(i: number) { const arr = this._doc$.value.segments ?? []; if (i >= arr.length - 1) return; this.swap(i, i + 1); }
    private swap(a: number, b: number) {
        const d = { ...this._doc$.value };
        const arr = [...(d.segments ?? [])];
        [arr[a], arr[b]] = [arr[b], arr[a]];
        d.segments = arr;
        this._doc$.next(d);
    }

    reflowStarts() {
        const d = { ...this._doc$.value };
        let t = d.serviceStartSec ?? 0;
        d.segments = (d.segments ?? []).map(s => {
            const r = { ...s, startSec: t };
            t += s.durationSec ?? 0;
            return r;
        });
        this._doc$.next(d);
    }

    exportPretty(): string {
        return JSON.stringify(this._doc$.value, null, 2);
    }

    totalSec(): number {
        return (this._doc$.value.segments ?? []).reduce((sum, s) => sum + (s.durationSec ?? 0), 0);
    }

    overlaps(): string[] {
        // simple placeholder; keep your prior logic if you had it
        return [];
    }
}

// Notes
// What changed vs legacy:

// Reads runId from URL → rundown.init(runId) on ngOnInit, rundown.dispose() on ngOnDestroy.

// Subscribes to rundown.doc$ (same shape as before), keeps your method names (setServiceStart, upsertSegment, etc.).

// Replaced the old “start + append” flow with one saveRundown(runId, dto); SignalR pushes updates to all devices automatically.

// import { Injectable } from '@angular/core';
// import { HttpClient, HttpHeaders } from '@angular/common/http';
// import * as signalR from '@microsoft/signalr';
// import { BehaviorSubject, firstValueFrom } from 'rxjs';
// import { environment } from '../../environments/environment';

// import { RundownDoc, RundownSegment } from '../models/rundown.models';

// const tmpId = (() => { let n = -1; return () => n--; })(); // temp IDs for unsaved rows

// @Injectable({ providedIn: 'root' })
// export class RundownService {
//     private readonly _doc$ = new BehaviorSubject<RundownDoc>({ serviceStartSec: 0, segments: [this.blank()] });
//     readonly doc$ = this._doc$.asObservable();

//     private api = environment.apiBaseUrl;
//     private hubUrl = environment.hubUrl;
//     private hub?: signalR.HubConnection;

//     constructor(private http: HttpClient) { }

//     // ---------- Lifecycle ----------
//     /** Call this once you have the runId (e.g., from route). */
//     async init(runId: string) {
//         this.setRunId(runId);
//         await this.loadFromServer();
//         await this.startHub();
//     }

//     // ---------- Server I/O ----------
//     private async loadFromServer() {
//         const runId = this.runId;
//         if (!runId) return;

//         const apiSegs = await firstValueFrom(
//             this.http.get<Array<{ id: number; order: number; name: string; plannedSec: number; actualSec?: number | null; driftSec?: number | null; completed: boolean }>>(
//                 `${this.api}/api/runs/${runId}/rundown`
//             )
//         );

//         // Map API → editor model
//         const segs: RundownSegment[] = apiSegs
//             .sort((a, b) => a.order - b.order)
//             .map(s => ({
//                 id: s.id ?? tmpId(),
//                 title: s.name ?? '',
//                 owner: '',
//                 startSec: 0,              // will be reflowed below
//                 durationSec: (s.plannedSec ?? 0) | 0,
//                 notes: '',
//                 color: ''
//             }));

//         const doc: RundownDoc = { serviceStartSec: this.value.serviceStartSec | 0, segments: segs };
//         this.commit(doc);
//         this.reflowStarts();
//     }

//     /** Replace-all save — matches API contract. */
//     async pushToBackend(): Promise<void> {
//         const runId = this.runId;
//         if (!runId) throw new Error('runId not set');

//         const items = this.segments.map((s, i) => ({
//             order: i,
//             name: s.title ?? '',
//             plannedSec: (s.durationSec | 0),
//             actualSec: null as number | null,
//             driftSec: null as number | null,
//             completed: false
//         }));

//         await firstValueFrom(
//             this.http.post<void>(`${this.api}/api/runs/${runId}/rundown/save`, items)
//         );
//         // Do not mutate locally here — wait for hub to notify and reload.
//     }

//     getStateForRun<T>(runId: string) {
//         return this.http.get<T>(`${this.api}/api/runs/${runId}/state`);
//     }

//     startRun(runId: string) {
//         return this.http.post<void>(`${this.api}/api/runs/${runId}/start`, {});
//     }

//     // Spanish endpoints (unchanged)
//     setSpanishEta(runId: string, etaSec: number) {
//         return this.http.post<void>(
//             `${this.api}/api/runs/${runId}/spanish/eta`,
//             etaSec,
//             { headers: new HttpHeaders({ 'Content-Type': 'application/json' }) }
//         );
//     }

//     spanishEnded(runId: string, endedAtSec?: number | null) {
//         const body = endedAtSec ?? null; // null = “now”
//         return this.http.post<void>(
//             `${this.api}/api/runs/${runId}/spanish/ended`,
//             body,
//             { headers: new HttpHeaders({ 'Content-Type': 'application/json' }) }
//         );
//     }

//     // ---------- SignalR (new events + legacy compat) ----------
//     private async startHub() {
//         if (this.hub?.state === signalR.HubConnectionState.Connected) return;

//         this.hub = new signalR.HubConnectionBuilder()
//             .withUrl(this.hubUrl)
//             .withAutomaticReconnect()
//             .build();

//         const reloadIfThisRun = (changedRunId: string) => {
//             if (!this.runId) return;
//             if (changedRunId?.toLowerCase() === this.runId.toLowerCase()) this.loadFromServer();
//         };

//         this.hub.on('RundownUpdated', (runId: string) => reloadIfThisRun(runId));
//         this.hub.on('SpanishEtaUpdated', (runId: string, _eta: number) => reloadIfThisRun(runId));
//         this.hub.on('SpanishEnded', (runId: string, _sec: number) => reloadIfThisRun(runId));

//         // Legacy event name (compat): treat as “data changed”
//         this.hub.on('StateUpdated', (_: any) => this.loadFromServer());

//         await this.hub.start();
//     }

//     // ---------- Getters ----------
//     get value() { return this._doc$.value; }
//     get segments() { return this.value.segments; }
//     get runId() { return (this.value as any).runId as string | undefined; }

//     // ---------- Mutations (kept from your original API) ----------
//     setServiceStart(sec: number) { this.commit({ ...this.value, serviceStartSec: Math.max(0, sec | 0) }); this.reflowStarts(); }

//     upsertSegment(seg: RundownSegment) {
//         const list = [...this.segments];
//         const idx = list.findIndex(s => s.id === seg.id);
//         if (idx >= 0) list[idx] = seg; else list.push({ ...seg, id: tmpId() });
//         this.commit({ ...this.value, segments: list });
//         this.reflowStarts();
//     }

//     replaceAll(segments: RundownSegment[]) {
//         this.commit({ ...this.value, segments: [...segments] });
//         this.reflowStarts();
//     }

//     insertAfter(i: number, base?: Partial<RundownSegment>) {
//         const list = [...this.segments];
//         const prev = list[i] ?? list[i - 1];
//         const startSec = prev ? prev.startSec + prev.durationSec : this.value.serviceStartSec | 0;
//         const seg: RundownSegment = {
//             id: tmpId(),
//             title: base?.title ?? '',
//             owner: base?.owner ?? '',
//             startSec: base?.startSec ?? startSec,
//             durationSec: base?.durationSec ?? 60,
//             notes: base?.notes ?? '',
//             color: base?.color ?? ''
//         };
//         list.splice(i + 1, 0, seg);
//         this.commit({ ...this.value, segments: list });
//         this.reflowStarts();
//     }

//     duplicate(i: number) {
//         const v = this.segments[i]; if (!v) return;
//         const clone = { ...v, id: tmpId() };
//         const list = [...this.segments];
//         list.splice(i + 1, 0, clone);
//         this.commit({ ...this.value, segments: list });
//         this.reflowStarts();
//     }

//     remove(i: number) {
//         const list = [...this.segments];
//         list.splice(i, 1);
//         this.commit({ ...this.value, segments: list });
//         this.reflowStarts();
//     }

//     moveUp(i: number) {
//         if (i <= 0) return;
//         const list = [...this.segments];
//         const [item] = list.splice(i, 1);
//         list.splice(i - 1, 0, item);
//         this.commit({ ...this.value, segments: list });
//         this.reflowStarts();
//     }

//     moveDown(i: number) {
//         const list = [...this.segments];
//         if (i >= list.length - 1) return;
//         const [item] = list.splice(i, 1);
//         list.splice(i + 1, 0, item);
//         this.commit({ ...this.value, segments: list });
//         this.reflowStarts();
//     }

//     reflowStarts() {
//         const list = [...this.segments];
//         let cursor = this.value.serviceStartSec | 0;
//         for (const s of list) {
//             s.startSec = cursor;
//             cursor += Math.max(1, s.durationSec | 0);
//         }
//         this._doc$.next({ ...this.value, segments: list });
//     }

//     clearAll() { this.commit({ serviceStartSec: 0, segments: [this.blank()] }); this.reflowStarts(); }

//     totalSec(): number { return this.segments.reduce((a, s) => a + (s.durationSec | 0), 0); }

//     overlaps(): string[] {
//         const warns: string[] = [];
//         const sorted = [...this.segments].sort((a, b) => a.startSec - b.startSec);
//         for (let i = 0; i < sorted.length - 1; i++) {
//             const a = sorted[i], b = sorted[i + 1];
//             const aEnd = a.startSec + a.durationSec;
//             if (b.startSec < aEnd) warns.push(`“${a.title || 'Untitled'}” overlaps “${b.title || 'Untitled'}” by ${aEnd - b.startSec}s`);
//         }
//         return warns;
//     }

//     exportPretty(): string { return JSON.stringify(this.value, null, 2); }

//     import(json: string) {
//         const parsed = JSON.parse(json) as Partial<RundownDoc>;
//         if (!parsed?.segments) throw new Error('Invalid JSON');
//         const segs = parsed.segments.map(s => ({
//             ...s,
//             id: Number(s.id) || tmpId(),
//             startSec: Math.max(0, (s.startSec as number) | 0),
//             durationSec: Math.max(1, (s.durationSec as number) | 0),
//             title: s.title ?? ''
//         })) as RundownSegment[];
//         this.commit({
//             ...this.value,
//             serviceStartSec: Math.max(0, (parsed.serviceStartSec ?? this.value.serviceStartSec) | 0),
//             segments: segs
//         });
//         this.reflowStarts();
//     }

//     // ---------- Internals ----------
//     private commit(doc: RundownDoc) { this._doc$.next(doc); } // no localStorage anymore

//     private blank(): RundownSegment {
//         return { id: tmpId(), title: '', owner: '', startSec: 0, durationSec: 60, notes: '', color: '' };
//     }

//     setRunId(id: string) { (this._doc$.value as any).runId = id; } // keep your existing pattern
// }

// // Notes:
// // Keeps your method names so components don’t break.

// // Removes localStorage; state lives in memory, and server is source of truth.

// // pushToBackend() now calls /api/runs/{id}/rundown/save; hub broadcasts trigger an automatic reload.

// // Path to environment stays ../../environments/environment (same folder depth you had).

// // You can delete methods that hit old endpoints you no longer use (appendSegments, completeSegment, etc.) — I removed them in this version.


// // import { Injectable } from '@angular/core';
// // import { RundownDoc, RundownSegment } from '../models/rundown.models';
// // import { HttpClient, HttpHeaders } from '@angular/common/http';
// // import { environment } from '../../environments/environment';
// // import { BehaviorSubject, firstValueFrom } from 'rxjs';

// // const LS_KEY = 'rundown.v1';
// // let _id = 1;
// // const newId = () => _id++;

// // @Injectable({ providedIn: 'root' })
// // export class RundownService {
// //     private readonly _doc$ = new BehaviorSubject<RundownDoc>(this.load());
// //     readonly doc$ = this._doc$.asObservable();

// //     private api = environment.apiBaseUrl;
// //     private runId$ = new BehaviorSubject<string | null>(null);

// //     constructor(private http: HttpClient) { }

// //     private async ensureRunId(): Promise<string> {
// //         const current = this.runId$.value;
// //         if (current) return current;

// //         try {
// //             const latest = await firstValueFrom(
// //                 this.http.get<{ runId: string }>(`${this.api}/api/runs/latest`)
// //             );
// //             this.runId$.next(latest.runId);
// //             return latest.runId;
// //         } catch (e: any) {
// //             if (e?.status === 404) {
// //                 const created = await firstValueFrom(
// //                     this.http.post<{ runId: string }>(`${this.api}/api/runs`, {})
// //                 );
// //                 this.runId$.next(created.runId);
// //                 return created.runId;
// //             }
// //             throw e;
// //         }
// //     }

// //     // Call this from your "Save to Producer"
// //     // Call this from "Save to Producer"
// //     async pushToBackend(): Promise<void> {
// //         const runId = await this.ensureRunId();

// //         // Map local editor rows → backend DTO
// //         const items = this.segments.map((s, i) => ({
// //             name: s.title ?? '',
// //             plannedSec: (s.durationSec | 0),
// //             order: i
// //         }));

// //         await firstValueFrom(
// //             this.http.post<void>(`${this.api}/api/runs/${runId}/segments`, items)
// //         );
// //     }


// //     // Safe state fetch with 404 auto-heal (refresh runId once)
// //     async getState<T>(): Promise<T> {
// //         let runId = await this.ensureRunId();
// //         try {
// //             return await firstValueFrom(this.http.get<T>(`${this.api}/api/runs/${runId}/state`));
// //         } catch (e: any) {
// //             if (e?.status === 404) {
// //                 this.runId$.next(null);
// //                 runId = await this.ensureRunId();
// //                 return await firstValueFrom(this.http.get<T>(`${this.api}/api/runs/${runId}/state`));
// //             }
// //             throw e;
// //         }
// //     }


// //     // --- getters ---
// //     get value() { return this._doc$.value; }
// //     get segments() { return this.value.segments; }

// //     // --- mutations ---
// //     setServiceStart(sec: number) {
// //         this.commit({ ...this.value, serviceStartSec: Math.max(0, sec | 0) });
// //     }

// //     upsertSegment(seg: RundownSegment) {
// //         const list = [...this.segments];
// //         const idx = list.findIndex(s => s.id === seg.id);
// //         if (idx >= 0) list[idx] = seg; else list.push({ ...seg, id: newId() });
// //         this.commit({ ...this.value, segments: list });
// //     }

// //     replaceAll(segments: RundownSegment[]) {
// //         this.commit({ ...this.value, segments: [...segments] });
// //     }

// //     insertAfter(i: number, base?: Partial<RundownSegment>) {
// //         const list = [...this.segments];
// //         const prev = list[i] ?? list[i - 1];
// //         const startSec = prev ? prev.startSec + prev.durationSec : 0;
// //         const seg: RundownSegment = {
// //             id: newId(),
// //             title: base?.title ?? '',
// //             owner: base?.owner ?? '',
// //             startSec: base?.startSec ?? startSec,
// //             durationSec: base?.durationSec ?? 60,
// //             notes: base?.notes ?? '',
// //             color: base?.color ?? ''
// //         };
// //         list.splice(i + 1, 0, seg);
// //         this.commit({ ...this.value, segments: list });
// //     }

// //     duplicate(i: number) {
// //         const v = this.segments[i]; if (!v) return;
// //         const clone = { ...v, id: newId() };
// //         const list = [...this.segments];
// //         list.splice(i + 1, 0, clone);
// //         this.commit({ ...this.value, segments: list });
// //     }

// //     remove(i: number) {
// //         const list = [...this.segments];
// //         list.splice(i, 1);
// //         this.commit({ ...this.value, segments: list });
// //     }

// //     moveUp(i: number) {
// //         if (i <= 0) return;
// //         const list = [...this.segments];
// //         const [item] = list.splice(i, 1);
// //         list.splice(i - 1, 0, item);
// //         this.commit({ ...this.value, segments: list });
// //     }

// //     moveDown(i: number) {
// //         const list = [...this.segments];
// //         if (i >= list.length - 1) return;
// //         const [item] = list.splice(i, 1);
// //         list.splice(i + 1, 0, item);
// //         this.commit({ ...this.value, segments: list });
// //     }

// //     reflowStarts() {
// //         const list = [...this.segments];
// //         let cursor = this.value.serviceStartSec; // ← start from service start
// //         for (const s of list) {
// //             s.startSec = cursor;
// //             cursor += Math.max(1, s.durationSec | 0);
// //         }
// //         this.commit({ ...this.value, segments: list });
// //     }

// //     clearAll() {
// //         this.commit({ serviceStartSec: 0, segments: [this.blank()] });
// //     }

// //     // backend calls
// //     getLatestRunId() {
// //         return this.http.get<{ runId: string }>(`${this.api}/api/runs/latest`);
// //     }

// //     getStateForRun(runId: string) {
// //         return this.http.get<any>(`${this.api}/api/runs/${runId}/state`);
// //     }

// //     startRun(runId: string) {
// //         return this.http.post<void>(`${this.api}/api/runs/${runId}/start`, {});
// //     }

// //     appendSegments(runId: string, items: Array<{ Name: string; PlannedSec: number }>) {
// //         return this.http.post<{ added: number; total: number }>(
// //             `${this.api}/api/runs/${runId}/segments`,
// //             items
// //         );
// //     }

// //     completeSegment(runId: string, segmentId: string) {
// //         return this.http.post<void>(`${this.api}/api/runs/${runId}/segments/${segmentId}/complete`, {});
// //     }

// //     setSpanishEta(runId: string, etaSec: number) {
// //         return this.http.post<void>(
// //             `${this.api}/api/runs/${runId}/spanish/eta`,
// //             etaSec,
// //             { headers: new HttpHeaders({ 'Content-Type': 'application/json' }) }
// //         );
// //     }

// //     spanishEnded(runId: string, endedAtSec?: number | null) {
// //         const body = endedAtSec ?? null; // null = “now”
// //         return this.http.post<void>(
// //             `${this.api}/api/runs/${runId}/spanish/ended`,
// //             body,
// //             { headers: new HttpHeaders({ 'Content-Type': 'application/json' }) }
// //         );
// //     }

// //     startOffering(runId: string) {
// //         return this.http.post<void>(`${this.api}/api/runs/${runId}/offering/start`, {});
// //     }




// //     // --- utils / derived ---
// //     totalSec(): number {
// //         return this.segments.reduce((a, s) => a + (s.durationSec | 0), 0);
// //     }

// //     overlaps(): string[] {
// //         const warns: string[] = [];
// //         const sorted = [...this.segments].sort((a, b) => a.startSec - b.startSec);
// //         for (let i = 0; i < sorted.length - 1; i++) {
// //             const a = sorted[i], b = sorted[i + 1];
// //             const aEnd = a.startSec + a.durationSec;
// //             if (b.startSec < aEnd) warns.push(`“${a.title || 'Untitled'}” overlaps “${b.title || 'Untitled'}” by ${aEnd - b.startSec}s`);
// //         }
// //         return warns;
// //     }

// //     exportPretty(): string { return JSON.stringify(this.value, null, 2); }
// //     import(json: string) {
// //         const parsed = JSON.parse(json) as Partial<RundownDoc>;
// //         if (!parsed?.segments) throw new Error('Invalid JSON');
// //         const segs = parsed.segments.map(s => ({
// //             ...s,
// //             id: Number(s.id),
// //             startSec: Math.max(0, (s.startSec as number) | 0),
// //             durationSec: Math.max(1, (s.durationSec as number) | 0),
// //             title: s.title ?? ''
// //         })) as RundownSegment[];
// //         this.commit({
// //             ...this.value,                  // preserve existing runId or other fields
// //             serviceStartSec: Math.max(0, (parsed.serviceStartSec ?? this.value.serviceStartSec) | 0),
// //             segments: segs
// //         });
// //     }




// //     // --- internal ---
// //     private commit(doc: RundownDoc) {
// //         this._doc$.next(doc);
// //         localStorage.setItem(LS_KEY, JSON.stringify(doc));
// //     }

// //     private load(): RundownDoc {
// //         try {
// //             const raw = localStorage.getItem(LS_KEY);
// //             if (raw) return JSON.parse(raw) as RundownDoc;
// //         } catch { }
// //         return { serviceStartSec: 0, segments: [this.blank()] };
// //     }

// //     private blank(): RundownSegment {
// //         return { id: newId(), title: '', owner: '', startSec: 0, durationSec: 60, notes: '', color: '' };
// //     }

// //     setRunId(id: string) { this.commit({ ...this.value, runId: id }); }
// //     get runId() { return this.value.runId; }

// // }
