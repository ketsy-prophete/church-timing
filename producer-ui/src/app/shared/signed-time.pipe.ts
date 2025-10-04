// src/app/shared/signed-time.pipe.ts
import { Pipe, PipeTransform } from '@angular/core';
@Pipe({ name: 'signedmmss', standalone: true })
export class SignedTimePipe implements PipeTransform {
  transform(sec?: number | null, plusForZero = false): string {
    if (sec == null) return '—';
    const n = Math.floor(sec);
    const sign = n < 0 ? '-' : (n > 0 || plusForZero) ? '+' : '';
    const a = Math.abs(n);
    const m = Math.floor(a / 60).toString().padStart(2, '0');
    const s = (a % 60).toString().padStart(2, '0');
    return `${sign}${m}:${s}`;
  }
}
