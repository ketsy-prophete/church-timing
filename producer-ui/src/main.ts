import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';
import 'zone.js'; // required when using Angular with default change detection


bootstrapApplication(App, appConfig)
  .catch((err) => console.error(err));
