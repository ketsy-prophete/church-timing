import { HttpInterceptorFn } from '@angular/common/http';
import { environment } from '../../../../environments/environment';


export const ngrokSkipWarningInterceptor: HttpInterceptorFn = (req, next) => {
  if (req.url.startsWith(environment.apiBaseUrl)) {
    req = req.clone({ setHeaders: { 'ngrok-skip-browser-warning': 'true' } });
  }
  return next(req);
};
