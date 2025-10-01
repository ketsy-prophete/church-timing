import { Pipe, PipeTransform } from '@angular/core';

@Pipe({ name: 'mmss', standalone: true })
export class TimePipe implements PipeTransform {
  transform(sec?: number | null): string {
    if (sec == null) return '—';
    const s = Math.max(0, Math.floor(sec));
    const m = Math.floor(s / 60).toString().padStart(2, '0');
    const r = (s % 60).toString().padStart(2, '0');
    return `${m}:${r}`;
  }
}


