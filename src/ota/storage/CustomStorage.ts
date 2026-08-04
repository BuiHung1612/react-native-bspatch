import { Platform } from 'react-native';
import ReactNativeBlobUtil from 'react-native-blob-util';
import type { OtaPatch, OtaConfig, OtaStorageProvider } from '../types';

interface TokenCache {
    token: string;
    expiresAt: number;
}

/** Cache tokens per server endpoint so switching configs invalidates stale tokens. */
const tokenCache = new Map<string, TokenCache>();

/**
 * Implementation for the custom MinIO-based storage server.
 */
export class CustomStorageProvider implements OtaStorageProvider {
  private getEndpoint(config: OtaConfig, key: 'login' | 'genDownloadLink' | 'downloadFile', fallback: string): string {
    return config.customServer?.endpoints?.[key] ?? fallback;
  }

  private async getAccessToken(config: OtaConfig): Promise<string> {
    if (!config.customServer) {
      throw new Error('customServer configuration missing');
    }

    const { baseUrl, username, password } = config.customServer;
    const cacheKey = `${baseUrl}|${username}`;
    const now = Date.now();

    const cached = tokenCache.get(cacheKey);
    if (cached && now < cached.expiresAt - 30000) {
      return cached.token;
    }

    const loginPath = this.getEndpoint(config, 'login', 'public/authen/login');
    const loginUrl = baseUrl.endsWith('/') ? `${baseUrl}${loginPath}` : `${baseUrl}/${loginPath}`;

    try {
      const res = await ReactNativeBlobUtil.fetch(
        'POST',
        loginUrl,
        { 'Content-Type': 'application/json; charset=utf-8' },
        JSON.stringify({ username, password })
      );

      const json = JSON.parse(res.data);
      const token = json.data?.accessTokenInfo?.accessToken;

      if (!token) throw new Error('Login failed: token not found');

      tokenCache.set(cacheKey, { token, expiresAt: now + 3600000 }); // 1 hour
      return token;
    } catch (error) {
      throw new Error(`Authentication failed: ${(error as Error).message}`);
    }
  }

  async fetchManifest(config: OtaConfig): Promise<OtaPatch[]> {
    if (!config.customServer) return config.bundledPatches || [];

    const { baseUrl, channel, baseFolder = 'bspatch' } = config.customServer;
    const registryPath = `${baseFolder}/ota_registry.json`;

    try {
      const token = await this.getAccessToken(config);
      const normalizedBaseUrl = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
      const genLinkPath = this.getEndpoint(config, 'genDownloadLink', 'api/minio/gen-download-link');
      const genLinkUrl = `${normalizedBaseUrl}/${genLinkPath}?pathFile=${encodeURIComponent(registryPath)}`;

      const linkRes = await ReactNativeBlobUtil.fetch('GET', genLinkUrl, {
        Authorization: `Bearer ${token}`,
      });
      const linkJson = JSON.parse(linkRes.data);
      const registryUrl = linkJson.data;
      if (!registryUrl) throw new Error('Failed to generate registry download link');

      const registryRes = await ReactNativeBlobUtil.fetch('GET', registryUrl);
      if (registryRes.respInfo.status !== 200) {
        throw new Error(`Registry fetch failed with status ${registryRes.respInfo.status}`);
      }

      const registry = JSON.parse(registryRes.data);
      const appGroup = registry?.apps?.[config.appVersion];
      const flavorGroup = appGroup?.flavors?.[channel.toLowerCase()];

      if (!flavorGroup || !flavorGroup.patches?.length) {
        return config.bundledPatches || [];
      }

      return (flavorGroup.patches || []).filter((p: OtaPatch) => p.platform === Platform.OS);
    } catch (error) {
      console.warn('[CustomStorage] Manifest fetch error:', (error as Error).message);
      return config.bundledPatches || [];
    }
  }

  async getUpdateFileUrl(filename: string, config: OtaConfig): Promise<string> {
    if (!config.customServer) throw new Error('customServer config missing');

    const { baseUrl, baseFolder = 'bspatch', useMinio } = config.customServer;
    const normalizedBaseUrl = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
    const channel = config.customServer.channel.toLowerCase();
    const remotePath = `${baseFolder}/${config.appVersion}/${channel}/${filename}`;

    if (useMinio) {
      const token = await this.getAccessToken(config);
      const genLinkPath = this.getEndpoint(config, 'genDownloadLink', 'api/minio/gen-download-link');
      const genLinkUrl = `${normalizedBaseUrl}/${genLinkPath}?pathFile=${encodeURIComponent(remotePath)}`;
      const res = await ReactNativeBlobUtil.fetch('GET', genLinkUrl, {
        Authorization: `Bearer ${token}`,
      });
      const json = JSON.parse(res.data);
      if (!json.data) throw new Error(`Failed to generate link for: ${filename}`);
      return json.data;
    }

    const downloadPath = this.getEndpoint(config, 'downloadFile', 'files/downloadStreamFile');
    return `${normalizedBaseUrl}/${downloadPath}?filepath=${encodeURIComponent(remotePath)}`;
  }

  async getAssetUrl(hash: string, ext: string, config: OtaConfig): Promise<string> {
    if (!config.customServer) return '';

    const { baseUrl, baseFolder = 'bspatch', useMinio } = config.customServer;
    const normalizedBaseUrl = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
    const filename = `${hash}.${ext}`;
    const remotePath = `${baseFolder}/assets/${filename}`;

    if (useMinio) {
      const token = await this.getAccessToken(config);
      const genLinkPath = this.getEndpoint(config, 'genDownloadLink', 'api/minio/gen-download-link');
      const genLinkUrl = `${normalizedBaseUrl}/${genLinkPath}?pathFile=${encodeURIComponent(remotePath)}`;
      const res = await ReactNativeBlobUtil.fetch('GET', genLinkUrl, {
        Authorization: `Bearer ${token}`,
      });
      const json = JSON.parse(res.data);
      return json.data || '';
    }

    const downloadPath = this.getEndpoint(config, 'downloadFile', 'files/downloadStreamFile');
    return `${normalizedBaseUrl}/${downloadPath}?filepath=${encodeURIComponent(remotePath)}`;
  }
}
