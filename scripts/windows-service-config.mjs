const SAFE_SERVICE_ENV_NAMES = new Set([
  'APPDATA',
  'CTI_HOME',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'LOCALAPPDATA',
  'NO_PROXY',
  'PATH',
  'USERPROFILE',
]);

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export function filterServiceEnvEntries(entries) {
  return [...entries]
    .filter((entry) => entry && SAFE_SERVICE_ENV_NAMES.has(String(entry.Name || '').toUpperCase()))
    .map((entry) => ({
      Name: String(entry.Name),
      Value: String(entry.Value),
    }))
    .sort((left, right) => left.Name.localeCompare(right.Name, 'en'));
}

export function buildWinSWServiceXml({
  serviceName,
  nodePath,
  daemonPath,
  workingDirectory,
  logDirectory,
  envEntries = [],
}) {
  const envXml = filterServiceEnvEntries(envEntries)
    .map((entry) => `  <env name="${escapeXml(entry.Name)}" value="${escapeXml(entry.Value)}"/>`)
    .join('\r\n');

  return [
    '<service>',
    `  <id>${escapeXml(serviceName)}</id>`,
    '  <name>Claude-to-IM Bridge</name>',
    '  <description>Claude-to-IM bridge daemon</description>',
    `  <executable>${escapeXml(nodePath)}</executable>`,
    `  <arguments>${escapeXml(daemonPath)}</arguments>`,
    `  <workingdirectory>${escapeXml(workingDirectory)}</workingdirectory>`,
    envXml,
    `  <logpath>${escapeXml(logDirectory)}</logpath>`,
    '  <log mode="append">',
    '    <logfile>bridge-service.log</logfile>',
    '  </log>',
    '  <onfailure action="restart" delay="10 sec"/>',
    '  <onfailure action="restart" delay="30 sec"/>',
    '  <onfailure action="none"/>',
    '</service>',
    '',
  ].filter(Boolean).join('\r\n');
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--')) continue;
    result[key.slice(2)] = value ?? '';
  }
  return result;
}

if (process.argv[2] === 'build-winsw-xml') {
  const args = parseArgs(process.argv.slice(3));
  const envEntries = args['env-json'] ? JSON.parse(args['env-json']) : [];
  process.stdout.write(buildWinSWServiceXml({
    serviceName: args['service-name'],
    nodePath: args['node-path'],
    daemonPath: args['daemon-path'],
    workingDirectory: args['working-directory'],
    logDirectory: args['log-directory'],
    envEntries,
  }));
}
