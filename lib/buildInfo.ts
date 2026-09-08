/** Identidade do deploy — ajuda a saber se o Render puxou o main certo. */
export const APP_VERSION = '1.0.2';
export const BUILD_MARKER = 'n8n+quota100+pwd8+trial-pg';

export function getBuildInfo() {
  return {
    version: APP_VERSION,
    marker: BUILD_MARKER,
    git: process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || null,
    started_at: process.env.RENDER_SERVICE_ID
      ? undefined
      : undefined,
  };
}
