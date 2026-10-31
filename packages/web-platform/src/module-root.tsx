import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode, type ReactNode } from 'react';
import { BrowserRouter } from 'react-router-dom';
import type { Platform } from './lifecycle';
import { ViewProvider } from './view';

/**
 * The providers a React lifecycle module renders inside: the shell's query cache, a router of its
 * own over the same URL, and the model view (date and scenario, kept per browser tab, so it
 * carries from one module's pages to another's). Platform hooks (`useMe`, `useView`, …) work under it.
 */
export function ModuleRoot({ platform, children }: { platform: Platform; children: ReactNode }) {
  return (
    <StrictMode>
      <QueryClientProvider client={platform.queryClient}>
        <BrowserRouter>
          <ViewProvider workspaceId={platform.workspace() ?? ''}>{children}</ViewProvider>
        </BrowserRouter>
      </QueryClientProvider>
    </StrictMode>
  );
}
