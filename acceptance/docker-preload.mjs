// Test-only Docker process fixture. Loaded explicitly by the offline CLI test;
// production CLI has no skip-preflight flag and never loads this module.
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const spawn = childProcess.spawn;
const fixture = `
const args=JSON.parse(process.argv[1]);
if(args[0]==='image'&&args[1]==='inspect') {
  console.log('sha256:2fc2c915ed384368f492e415d42f7491defbaaa29436b3013e84627fe85b57a6');
} else { console.error('Unexpected Docker command in offline CLI fixture'); process.exitCode=125; }
`;
childProcess.spawn = (command, args, options) => command === 'docker'
  ? spawn(process.execPath, ['-e', fixture, JSON.stringify(args)], options)
  : spawn(command, args, options);
syncBuiltinESMExports();
