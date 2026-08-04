/**
 * GitHub Releases Storage Provider
 *
 * Reads the OTA registry from a GitHub Release asset and resolves download URLs
 * directly from the release. Supports both public and token-authenticated repos.
 *
 * Registry format:
 * - Expected at: `https://raw.githubusercontent.com/{owner}/{repo}/{tag}/{registryPath}`
 * - Asset download: `https://github.com/{owner}/{repo}/releases/download/{tag}/{filename}`
 */

import { Platform } from 'react-native';
import ReactNativeBlobUtil from 'react-native-blob-util';
import type { OtaPatch, OtaConfig, OtaStorageProvider } from '../types';

export class GitHubReleaseStorageProvider implements OtaStorageProvider {
    private getRawRegistryUrl(config: OtaConfig): string {
        const { repo, tag, registryPath = 'ota_registry.json' } = config.githubRelease!;
        return `https://raw.githubusercontent.com/${repo}/${tag}/${registryPath}`;
    }

    private getAssetDownloadUrl(config: OtaConfig, filename: string): string {
        const { repo, tag } = config.githubRelease!;
        return `https://github.com/${repo}/releases/download/${tag}/${filename}`;
    }

    private authHeaders(token?: string): Record<string, string> {
        if (!token) return {};
        return { Authorization: `Bearer ${token}` };
    }

    async fetchManifest(config: OtaConfig): Promise<OtaPatch[]> {
        if (!config.githubRelease) return config.bundledPatches || [];

        const { token } = config.githubRelease;
        const url = this.getRawRegistryUrl(config);

        try {
            const res = await ReactNativeBlobUtil.fetch(
                'GET',
                url,
                this.authHeaders(token),
            );

            if (res.respInfo.status !== 200) {
                throw new Error(`Registry fetch failed with status ${res.respInfo.status}`);
            }

            const registry =
                typeof res.data === 'string'
                    ? JSON.parse(res.data)
                    : JSON.parse(JSON.stringify(res.data));

            // Support both flat array (legacy) and structured format
            if (Array.isArray(registry)) {
                return registry.filter(
                    (p: OtaPatch) => !p.platform || p.platform === Platform.OS,
                );
            }

            // Structured: apps["1.0.0"].channels["production"].patches[]
            const appGroup = registry?.apps?.[config.appVersion];
            const channelGroup = appGroup?.channels?.[config.githubRelease.repo] // use repo as channel fallback
                ?? appGroup?.channels?.production
                ?? appGroup?.flavors?.production;

            if (!channelGroup?.patches?.length) {
                return config.bundledPatches || [];
            }

            return channelGroup.patches.filter(
                (p: OtaPatch) => !p.platform || p.platform === Platform.OS,
            );
        } catch (error) {
            console.warn('[GitHubStorage] Manifest fetch error:', (error as Error).message);
            return config.bundledPatches || [];
        }
    }

    async getUpdateFileUrl(filename: string, config: OtaConfig): Promise<string> {
        if (!config.githubRelease) throw new Error('githubRelease config missing');
        return this.getAssetDownloadUrl(config, filename);
    }

    async getAssetUrl(hash: string, ext: string, config: OtaConfig): Promise<string> {
        if (!config.githubRelease) return '';

        const { assetBaseUrl, tag, repo } = config.githubRelease;

        // If a custom CDN/base is provided, use it
        if (assetBaseUrl) {
            return `${assetBaseUrl}/${hash}.${ext}`;
        }

        // Fallback: serve from GitHub raw with optional token
        return `https://raw.githubusercontent.com/${repo}/${tag}/assets/${hash}.${ext}`;
    }
}
