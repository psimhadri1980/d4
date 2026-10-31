import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode, type ReactNode } from 'react';
import { BrowserRouter } from 'react-router-dom';
import type { Platform } from './lifecycle';

/**
 * The providers a React lifecycle module renders inside: the shell's query cache and a router of
 * its own over the same URL. Platform hooks (`useMe`, `useAccess`, …) work under it.
 */
export function ModuleRoot({ platform, children }: { platform: Platform; children: ReactNode }) {
  return (
    <StrictMode>
      <QueryClientProvider client={platform.queryClient}>
        <BrowserRouter>{children}</BrowserRouter>
      </QueryClientProvider>
    </StrictMode>
  );
}
