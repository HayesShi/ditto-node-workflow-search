import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {migrateLegacyDefinition} from '../dist/official-agent/migration.js';
import {validateOfficialDefinition,officialArtifactHash} from '../dist/official-agent/schema.js';

const flags=new Map();for(let i=2;i<process.argv.length;i+=2){const key=process.argv[i],value=process.argv[i+1];if(!['--input','--output'].includes(key)||!value||flags.has(key))throw Error('Use --input candidate.json --output agent.json');flags.set(key,value);}
if(!flags.has('--input')||!flags.has('--output'))throw Error('Use --input candidate.json --output agent.json');
const input=resolve(flags.get('--input')),output=resolve(flags.get('--output')),raw=JSON.parse(await readFile(input,'utf8')),source=raw.definition??raw;
const imported=source.version===1&&!Array.isArray(source.graphs)?{definition:validateOfficialDefinition(source,raw.toolArtifacts),toolArtifacts:raw.toolArtifacts,migration:{sourceProtocol:'official-version-1',semanticChanges:[]}}:migrateLegacyDefinition(source);
await mkdir(dirname(output),{recursive:true});
await writeFile(output,JSON.stringify(imported.definition,null,2)+'\n',{flag:'wx'});
await writeFile(output+'.candidate.json',JSON.stringify({...imported,artifactHash:officialArtifactHash(imported.definition,imported.toolArtifacts),source:input},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({output,candidate:output+'.candidate.json',qualityReused:false}));
