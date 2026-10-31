/**
 * Last-resort crash diagnostics.
 *
 * Installed from the root layout at module scope. The file-system import is
 * lazy and every failure is swallowed: diagnostics must never be the reason a
 * startup error becomes a silent, unusable app.
 */

type ErrorUtilsLike = {
  setGlobalHandler?: (handler: (error: Error, isFatal?: boolean) => void) => void;
};

type FileSystemModule = typeof import('expo-file-system');

function getErrorUtils(): ErrorUtilsLike | undefined {
  return (globalThis as unknown as { ErrorUtils?: ErrorUtilsLike }).ErrorUtils;
}

export async function appendCrashLog(
  error: Error,
  loadFileSystem: () => Promise<FileSystemModule> = () => import('expo-file-system'),
): Promise<void> {
  try {
    const { File, Paths } = await loadFileSystem();
    const file = new File(Paths.document, 'crash.log');
    if (!file.exists) {
      file.create({ intermediates: true });
    }
    const message = error?.message ?? String(error);
    const stack = error?.stack ?? '(no stack trace)';
    const entry = `[${new Date().toISOString()}]\n${message}\n${stack}\n\n`;
    await file.write(entry, { append: true });
  } catch {
    // A missing or broken file system must not hide the original error.
  }
}

export async function handleGlobalError(
  error: Error,
  loadFileSystem?: () => Promise<FileSystemModule>,
): Promise<void> {
  try {
    console.error('[Freehaven] Uncaught error', error);
  } catch {
    // console itself is allowed to be broken on exotic runtimes.
  }
  await appendCrashLog(error, loadFileSystem);
}

export function installGlobalErrorHandler(
  errorUtils: ErrorUtilsLike | undefined = getErrorUtils(),
): void {
  try {
    errorUtils?.setGlobalHandler?.((error) => {
      void handleGlobalError(error);
    });
  } catch {
    // Installing diagnostics must never be the reason startup fails.
  }
}
