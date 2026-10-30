import NativeBsPatch from '../NativeBsPatch';
import { DOCUMENT_DIR } from './otaMetadata';

// Outside ota/: resetToFactory and native rollbacks keep it
const INSTALL_ID_PATH = `${DOCUMENT_DIR}/bspatch-install-id`;
let installId: Promise<string> | undefined;

/** Random ID made on first use and kept for the life of the install (rollout bucket, QA lists, telemetry) */
export const getInstallId = (): Promise<string> =>
    (installId ??= (async () => {
        try {
            const saved = (await NativeBsPatch.readFile(INSTALL_ID_PATH)).trim();
            if (/^[0-9a-f]{32}$/.test(saved)) return saved;
        } catch {}
        const id = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
        await NativeBsPatch.writeFile(INSTALL_ID_PATH, id).catch(() => {});
        return id;
    })());
