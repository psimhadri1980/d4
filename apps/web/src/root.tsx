import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { AuthProvider, createQueryClient } from '@d4/web-platform';
import { createPlatform, initModules } from './lifecycle';

const queryClient = createQueryClient();

export function renderApp(container: HTMLElement): void {
  // Lifecycle modules load once signed in (Layout); the menu and routes pick each one up as it arrives.
  initModules(createPlatform(queryClient));
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
