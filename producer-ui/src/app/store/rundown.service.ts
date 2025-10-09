import { Injectable } from '@angular/core';
import { BehaviorSubject, firstValueFrom } from 'rxjs';
import { HttpClient } from '@angular/common/http';
import * as signalR from '@microsoft/signalr';

import { environment } from '../../environments/environment';
import { RundownDoc, RundownSegment } from '../models/rundown.models';


@Injectable({ providedIn: 'root' })
export class RundownService {
    // ---- state ----
    private _doc$ = new BehaviorSubject<RundownDoc>({ serviceStartSec: 0, segments: [] });
    readonly doc$ = this._doc$.asObservable();

    private hub?: signalR.HubConnection;
    private runId: string | null = null;

    private api = environment.apiBaseUrl;


    constructor(private http: HttpClient) { }

    async saveToProducer(runId: string, segments: RundownSegment[]): Promise<void> {
        const url = `${this.api}/api/runs/${runId}/english/segments`;

        const payload = segments.map((s, i) => ({
            id: s.id != null ? String(s.id) : '',   // new rows can send ''
            order: i + 1,                           // use current list order
            name: s.title ?? '',
            plannedSec: Math.max(0, Math.trunc(s.durationSec ?? 0)),
            actualSec: null                         // editor doesn't set this
        }));

        await firstValueFrom(this.http.post<void>(url, payload));
    }


    // ---- lifecycle ----
    async init(runId: string) {
        if (this.runId === runId && this.hub && this.hub.state === signalR.HubConnectionState.Connected) return;
        this.runId = runId;

        // initial load from API
        this.reload();

        // connect SignalR
        this.hub = new signalR.HubConnectionBuilder()
            .withUrl(environment.hubUrl)
            .withAutomaticReconnect()
            .build();

        this.hub.on('StateUpdated', (state: any) => {
            if (!state || state.runId !== this.runId) return;
            this.applyStateToDoc(state);
        });

        // on reconnect, re-join the run group
        this.hub.onreconnected(async () => {
            if (!this.runId) return;
            try { await this.hub!.invoke('Join', this.runId); }
            catch { try { await this.hub!.invoke('JoinRun', this.runId); } catch { } }
        });

        try {
            await this.hub.start();
            if (!this.runId) return;
            try { await this.hub!.invoke('Join', this.runId); }
            catch { try { await this.hub!.invoke('JoinRun', this.runId); } catch (e) { console.warn('join failed', e); } }
        } catch (err) {
            console.error('hub start failed', err);
        }

    }

    dispose() {
        this.hub?.stop().catch(() => { });
        this.hub = undefined;
        this.runId = null;
    }

    // ---- server calls ----
    private async reload() {
        if (!this.runId) return;
        try {
            const state = await firstValueFrom(this.http.get<any>(`${this.api}/api/runs/${this.runId}/state`));
            this.applyStateToDoc(state);
        } catch (e) {
            console.error('reload failed', e);
        }
    }

    private applyStateToDoc(state: any) {
        // english.segments expected to be [{ id, order, name, plannedSec, actualSec? }, ...]
        const src = (state?.english?.segments ?? []) as any[];
        let t = 0;
        const segments: RundownSegment[] = src
            .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
            .map(s => {
                const r: RundownSegment = {
                    id: (typeof s.id === 'number' && Number.isFinite(s.id))
                        ? s.id
                        : (Number.parseInt(String(s.id), 10) || 0),
                    title: s.name ?? '',
                    owner: '',
                    startSec: t,
                    durationSec: Math.max(0, s.plannedSec ?? 0),
                    notes: '',
                    color: ''
                };
                t += r.durationSec;
                return r;
            });

        const doc: RundownDoc = { runId: state?.runId, serviceStartSec: 0, segments };
        this._doc$.next(doc);
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

    // RundownService
    async startOffering(runId: string): Promise<void> {
        const url = `${this.api}/api/runs/${runId}/english/offering/start`;
        await firstValueFrom(this.http.post<void>(url, {}));
        // No local mutation needed; server will broadcast StateUpdated.
    }

    postEnglishSegments(runId: string, segs: any[]) {
        return firstValueFrom(
            this.http.post(
                `${environment.apiBaseUrl}/api/runs/${runId}/english/segments`, segs, {
                headers: { 'Content-Type': 'application/json' }
            })
        );
    }
}

