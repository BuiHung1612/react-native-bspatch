import type { OtaConfig, OtaPatch, OtaStorageProvider } from '../types';

/**
 * Storage Provider for any static host with this layout: GitHub raw, a public
 * Cloudflare R2 bucket (r2.dev or custom domain), S3, a CDN...
 *
 * Direct URL mapping:
 * - Manifest: `${baseUrl}/${baseFolder}/ota_registry.json`
 * - Patch file: `${baseUrl}/${baseFolder}/${appVersion}/${channel}/${filename}`
 * - Assets: `${baseUrl}/${baseFolder}/assets/${hash}.${ext}`
 *
 * NOTE: Only the registry is mutable: it is fetched with Cache-Control: no-cache
 * and a timestamp query param (GitHub's CDN caches for 5 minutes). Bundles,
 * patches, manifests and assets are never overwritten, so they stay cacheable.
 */

/** Headers to bypass GitHub CDN cache on mutable files (registry, manifests) */
const NO_CACHE_HEADERS = { 'Cache-Control': 'no-cache' };

/** GET + JSON.parse with a timeout (fetch has none of its own); rejects on non-2xx. */
export const fetchJson = async (url: string, timeoutMs: number): Promise<any> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, { headers: NO_CACHE_HEADERS, signal: controller.signal });
        if (!res.ok) {
            throw new Error(`HTTP ${res.status} for ${url}`);
        }
        return await res.json();
    } finally {
        clearTimeout(timer);
    }
};

/** Append a timestamp query param to defeat CDN caches on mutable URLs */
const bustCache = (url: string): string =>
    `${url}?cb=${Date.now()}`;

const normalizeChannel = (channel: string): string => {
    const lower = channel.toLowerCase();
    if (lower === 'dev') return 'development';
    if (lower === 'prod') return 'production';
    return lower;
};

export class GitHubRawStorageProvider implements OtaStorageProvider {
    async fetchManifest(config: OtaConfig): Promise<OtaPatch[]> {
        if (!config.customServer) {
            throw new Error('[GitHubRawStorage] customServer configuration missing');
        }

        const { baseUrl, channel, baseFolder = 'ota' } = config.customServer;
        const channelName = normalizeChannel(channel);
        const normalizedBaseUrl = baseUrl.endsWith('/')
            ? baseUrl.slice(0, -1)
            : baseUrl;
        // Cache-bust: registry is mutable; must always fetch the latest version
        const registryUrl = bustCache(
            `${normalizedBaseUrl}/${baseFolder}/ota_registry.json`,
        );

        try {
            const registry = await fetchJson(registryUrl, 15000);

            if (!config.appVersion) {
                throw new Error(
                    '[GitHubRawStorage] config.appVersion is required to query OTA registry',
                );
            }
            const appGroup = registry?.apps?.[config.appVersion];
            const flavorGroup = appGroup?.flavors?.[channelName];

            return flavorGroup?.patches ?? [];
        } catch (error) {
            // Surface it: "no patches" would report a broken registry as up to date
            throw new Error(`[GitHubRawStorage] Manifest fetch error: ${(error as Error).message}`);
        }
    }

    async getUpdateFileUrl(
        filename: string,
        config: OtaConfig,
    ): Promise<string> {
        if (!config.customServer) {
            throw new Error('customServer configuration missing');
        }

        const { baseUrl, baseFolder = 'ota', channel } = config.customServer;
        const normalizedBaseUrl = baseUrl.endsWith('/')
            ? baseUrl.slice(0, -1)
            : baseUrl;
        const channelName = normalizeChannel(channel);

        // Versioned names, never overwritten: no cache-bust, so a CDN can cache them
        return `${normalizedBaseUrl}/${baseFolder}/${config.appVersion}/${channelName}/${filename}`;
    }

    async getAssetUrl(
        hash: string,
        ext: string,
        config: OtaConfig,
    ): Promise<string> {
        if (!config.customServer) return '';

        const { baseUrl, baseFolder = 'ota' } = config.customServer;
        const normalizedBaseUrl = baseUrl.endsWith('/')
            ? baseUrl.slice(0, -1)
            : baseUrl;

        // Assets are content-addressed (hash = filename) → immutable, no cache-bust needed
        return `${normalizedBaseUrl}/${baseFolder}/assets/${hash}.${ext}`;
    }
}
