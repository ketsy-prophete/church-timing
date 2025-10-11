import { Injectable, NgZone } from '@angular/core';
import { interval, map, startWith, shareReplay } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class TickerService {
  // emits a monotonic "now" in ms (local clock)
  readonly now$ = interval(250).pipe(      // 4×/sec feels smooth; change to 1000 for 1 Hz
    startWith(0),
    map(() => Date.now()),
    shareReplay({ bufferSize: 1, refCount: true })
  );

  constructor(zone: NgZone) {
    // run outside Angular to avoid excessive CD, components can opt-in via async pipe
    zone.runOutsideAngular(() => this.now$.subscribe());
  }
}
