import { Routes } from '@angular/router';
import { EnglishViewComponent } from './features/english/english-view.component';
import { SpanishViewComponent } from './features/spanish/spanish-view.component';

export const routes: Routes = [
  { path: 'runs/:id/english', component: EnglishViewComponent },
  { path: 'runs/:id/spanish', component: SpanishViewComponent },
  { path: '**', redirectTo: 'runs/3d7f3fdb-2e41-41eb-8e80-8556f949f8d3/english' }
  ];    
