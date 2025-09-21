import { createTRPCProxyClient, httpBatchLink } from "@trpc/client";
import type { AppRouter } from "@backend/trpc";

const defaultUrl = "http://localhost:4000/trpc";

export const trpcClient = createTRPCProxyClient<AppRouter>({
  links: [
    httpBatchLink({
      url: (import.meta.env.VITE_TRPC_URL as string | undefined) ?? defaultUrl,
      maxURLLength: 100,
      fetch: (input, init) => fetch(input, { ...init, credentials: "same-origin" }),
    }),
  ],
});
