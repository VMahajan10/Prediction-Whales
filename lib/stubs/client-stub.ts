/**
 * Webpack client-bundle stub for server-only modules.
 * If this file is ever executed, a server module leaked into the browser graph.
 */
throw new Error(
  "Server-only module reached the client bundle. Import API routes or client modules instead."
);
