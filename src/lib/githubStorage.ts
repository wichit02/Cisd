export interface SavedGithubConfig {
  githubToken: string;
  githubOwner: string;
  githubRepo: string;
  githubBranch: string;
  githubPrivate: boolean;
  githubUploadAllowed: boolean;
  githubAutoSyncCode: boolean;
  githubSyncSignals: boolean;
}

const STORAGE_KEY = 'ao_github_backup_v1';

export function loadSavedGithubConfig(): SavedGithubConfig | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SavedGithubConfig>;
    const token = typeof parsed.githubToken === 'string' ? parsed.githubToken.trim() : '';
    const repo = typeof parsed.githubRepo === 'string' ? parsed.githubRepo.trim() : '';
    if (!token || !repo) return null;
    return {
      githubToken: token,
      githubOwner: typeof parsed.githubOwner === 'string' ? parsed.githubOwner.trim() : '',
      githubRepo: repo,
      githubBranch:
        typeof parsed.githubBranch === 'string' && parsed.githubBranch.trim()
          ? parsed.githubBranch.trim()
          : 'main',
      githubPrivate: typeof parsed.githubPrivate === 'boolean' ? parsed.githubPrivate : true,
      githubUploadAllowed:
        typeof parsed.githubUploadAllowed === 'boolean' ? parsed.githubUploadAllowed : false,
      githubAutoSyncCode:
        typeof parsed.githubAutoSyncCode === 'boolean' ? parsed.githubAutoSyncCode : true,
      githubSyncSignals:
        typeof parsed.githubSyncSignals === 'boolean' ? parsed.githubSyncSignals : true,
    };
  } catch {
    return null;
  }
}

export function saveGithubConfigLocally(cfg: SavedGithubConfig): void {
  try {
    if (!cfg.githubToken.trim() || !cfg.githubRepo.trim()) return;
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        githubToken: cfg.githubToken.trim(),
        githubOwner: cfg.githubOwner.trim(),
        githubRepo: cfg.githubRepo.trim(),
        githubBranch: cfg.githubBranch.trim() || 'main',
        githubPrivate: Boolean(cfg.githubPrivate),
        githubUploadAllowed: Boolean(cfg.githubUploadAllowed),
        githubAutoSyncCode: Boolean(cfg.githubAutoSyncCode),
        githubSyncSignals: Boolean(cfg.githubSyncSignals),
      })
    );
  } catch {
    // Ignore storage quota or private mode errors
  }
}

export function clearSavedGithubConfig(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Ignore
  }
}
