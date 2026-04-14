/**
 * Wagmi + React config for Hypurrmium Auto-Buy frontend.
 *
 * Drop this into your React app entry point or wrap <App /> with the providers.
 *
 * Usage:
 *   import { WagmiProvider } from 'wagmi';
 *   import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
 *   import { wagmiConfig } from './wagmi-config';
 *
 *   const queryClient = new QueryClient();
 *
 *   <WagmiProvider config={wagmiConfig}>
 *     <QueryClientProvider client={queryClient}>
 *       <App />
 *     </QueryClientProvider>
 *   </WagmiProvider>
 */

import { createConfig, http } from 'wagmi';
import { arbitrum } from 'wagmi/chains';
import { injected, walletConnect } from 'wagmi/connectors';

export const wagmiConfig = createConfig({
  chains: [arbitrum],
  connectors: [
    injected(),
    walletConnect({
      projectId: import.meta.env.VITE_WC_PROJECT_ID || 'YOUR_WALLETCONNECT_PROJECT_ID',
    }),
  ],
  transports: {
    [arbitrum.id]: http(),
  },
});
