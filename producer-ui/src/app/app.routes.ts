// src/app/app.routes.ts
import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: 'runs/:runId/english',
    loadComponent: () =>
      import('./features/english/english-view.component')
        .then(m => m.EnglishViewComponent)
  },
  {
    path: 'runs/:runId/spanish',
    loadComponent: () =>
      import('./features/spanish/spanish-view.component')
        .then(m => m.SpanishViewComponent)
  },
  {
    path: 'runs/:runId/editor',
    loadComponent: () =>
      import('./features/rundown/rundown-editor/rundown-editor.component')
        .then(m => m.RundownEditorComponent)
  },
  { path: '**', redirectTo: 'runs/3d7f3fdb-2e41-41eb-8e80-8556f949f8d3/english' },
  { path: '', pathMatch: 'full', redirectTo: 'runs/3d7f3fdb-2e41-41eb-8e80-8556f949f8d3/english' },
];
