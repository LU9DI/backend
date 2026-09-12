/** Identidade do deploy. */
export const APP_VERSION = '1.1.5';
export const BUILD_MARKER = 'pdf-postgres-trial-fix';

const STARTED_AT = new Date().toISOString();
const STARTED_MS = Date.now();

export function getBuildInfo() {
  return {
    version: APP_VERSION,
    marker: BUILD_MARKER,
    git: process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || null,
    service: process.env.RENDER_SERVICE_NAME || process.env.RENDER_SERVICE_ID || null,
    started_at: STARTED_AT,
    uptime_s: Math.floor((Date.now() - STARTED_MS) / 1000),
  };
}
