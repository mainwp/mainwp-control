export function isWriteHostAllowed(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host.endsWith('.local')
  );
}

export function getWriteGuardReason(
  dashboardUrl: string,
  writesEnabled: boolean,
  target: 'live' | 'fixture'
): string | null {
  if (target === 'fixture') return null;
  if (!writesEnabled) return 'Write scenarios require --writes.';
  const hostname = new URL(dashboardUrl).hostname;
  if (!isWriteHostAllowed(hostname)) {
    return (
      `Dashboard host ${hostname} is not write-allowed. ` +
      'Use localhost, 127.0.0.1, or a .local host.'
    );
  }
  return null;
}
