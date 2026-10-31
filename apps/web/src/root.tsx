import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { AuthProvider, createQueryClient } from '@d4/web-platform';
import { createPlatform, loadLifecycleModules } from './lifecycle';

const queryClient = createQueryClient();

export function renderApp(container: HTMLElement): void {
  // Lifecycle modules load alongside the shell; the menu and routes pick each one up as it arrives.
  loadLifecycleModules(createPlatform(queryClient));
  createRoot(container).render(
    <StrictMode>
      <AuthProvider>
        <QueryClientProvider client={queryClient}>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </QueryClientProvider>
      </AuthProvider>
    </StrictMode>,
  );
}
