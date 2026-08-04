import { Platform } from 'react-native';
import ReactNativeBlobUtil from 'react-native-blob-util';
import type { OtaConfig, OtaPatch, OtaStorageProvider } from '../types';

/**
 * Storage Provider for fetching OTA updates directly from a GitHub Raw repository.
 *
 * Direct URL mapping:
 * - Manifest: `${baseUrl}/${baseFolder}/ota_registry.json`
 * - Patch file: `${baseUrl}/${baseFolder}/${appVersion}/${channel}/${filename}`
 * - Assets: `${baseUrl}/${baseFolder}/assets/${hash}.${ext}`
 */
export class GitHubRawStorageProvider implements OtaStorageProvider {
    async fetchManifest(config: OtaConfig): Promise<OtaPatch[]> {
        if (!config.customServer) return config.bundledPatches || [];

        const { baseUrl, channel, baseFolder = 'ota' } = config.customServer;
        const normalizedBaseUrl = baseUrl.endsWith('/')
            ? baseUrl.slice(0, -1)
            : baseUrl;
        const registryUrl = `${normalizedBaseUrl}/${baseFolder}/ota_registry.json`;

        try {
            const res = await ReactNativeBlobUtil.fetch('GET', registryUrl);
            if (res.respInfo.status !== 200) {
                throw new Error(
                    `Registry fetch failed with status ${res.respInfo.status}`,
                );
            }

            const registry =
                typeof res.data === 'string'
                    ? JSON.parse(res.data)
                    : res.data;

            const appGroup = registry?.apps?.[config.appVersion];
            const flavorGroup =
                appGroup?.flavors?.[channel.toLowerCase()] ||
                appGroup?.flavors?.development;

            if (!flavorGroup?.patches?.length) {
                return config.bundledPatches || [];
            }

            return (flavorGroup.patches || []).filter(
                (p: OtaPatch) =>
                    !p.platform ||
                    p.platform.toLowerCase() === Platform.OS.toLowerCase(),
            );
        } catch (error) {
            console.warn(
                '[GitHubRawStorage] Manifest fetch error:',
                (error as Error).message,
            );
            return config.bundledPatches || [];
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
        const channelName = channel.toLowerCase();

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

        return `${normalizedBaseUrl}/${baseFolder}/assets/${hash}.${ext}`;
    }
}
