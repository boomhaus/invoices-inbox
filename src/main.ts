// Trigger entry points, nothing else (spec §6). Each function here must
// have a matching global shim line in tools/build.mjs.

export function dailyRun(): void {
  console.log('dailyRun: scaffold only, no pipeline yet');
}

export function weeklyHeartbeat(): void {
  console.log('weeklyHeartbeat: scaffold only, no checks yet');
}

// Temporary Phase 1.2 verification: proves the advanced Drive and Gmail
// services are enabled and authorized (spec Step 1 risk note). Removed once
// the real adapters exist.
export function verifySetup(): void {
  if (!Drive || !Drive.Drives) {
    throw new Error('Advanced Drive service is not enabled');
  }
  if (!Gmail || !Gmail.Users || !Gmail.Users.Labels) {
    throw new Error('Advanced Gmail service is not enabled');
  }

  const drives = Drive.Drives.list();
  const names = (drives.drives ?? []).map((d) => d.name).join(', ');
  console.log(`Drive advanced service OK. Shared drives: ${names}`);

  const labels = Gmail.Users.Labels.list('me');
  const invoiceLabels = (labels.labels ?? [])
    .map((l) => l.name ?? '')
    .filter((n) => n.startsWith('invoices/'))
    .join(', ');
  console.log(`Gmail advanced service OK. Invoice labels: ${invoiceLabels}`);
}
