import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import type {DatasetName} from '../domain.js';
import {artifactHash} from '../unified/store.js';

export const OFFICIAL_INITIALIZATION_VERSION='official-optional-user-initialization-v1';
export const OFFICIAL_INITIALIZATION_SELECTIONS=['baseline','pr10-selected','pr7-guidance'] as const;
export type OfficialInitializationSelection=typeof OFFICIAL_INITIALIZATION_SELECTIONS[number];
export type OfficialTaskPresentation='no-repeat'|'repeat-task-on-first-sample';
interface SourceAsset {readonly path:string;readonly sha256:string;}
export interface OfficialInitialization {
 readonly version:typeof OFFICIAL_INITIALIZATION_VERSION;
 readonly dataset:DatasetName;
 readonly selection:OfficialInitializationSelection;
 readonly guidance:Readonly<Record<string,unknown>>|null;
 readonly seedStrategy?:string;
 readonly presentation:OfficialTaskPresentation;
 readonly provenance:Readonly<{sourceCommit?:string;sourceCandidate?:string;sourceDefinitionHash?:string;assets:readonly SourceAsset[]}>;
 readonly identity:string;
}
const PR10_COMMIT='d9e51796b57407f1c083a44252ee0b44c832f67b';
const PR7_COMMIT='b641010f240ced610a45625653375816829c87e4';
const ASSETS:Readonly<Record<string,string>>=Object.freeze({
 'pr10/drop.json':'22b14529bb7845f8f68c90d6f4056398764649eb8dfb74433cb5afdc4ec077ac',
 'pr10/humaneval.json':'203a19ad8393c81fa17bdf77a780c60478a04da9f2bcfba480cb34687e0dc118',
 'pr10/mbpp.json':'b7a6aa137132802ede9985a10eda4b812bbb9ed7705ba893926809f907d3b77f',
 'pr10/automationbench.json':'d7ffe0b8bdb277d8adb87fd198fea3ee45b804ac5729a129509571fd1928d3ce',
 'pr10/strategy-template.json':'6bff91ec147d381156ebb3b27f95eafb301e4359a2cfcd322c56b504a05d1709',
 'pr7/dataset-initial-prompts.zh-CN.json':'d6b1bd82fbc1cd4ae5f48986c31b46204891f2ee76cf0b5c015330a58f3fcec3',
});
function immutable<T>(value:T):T{
 if(value&&typeof value==='object'){for(const child of Object.values(value))immutable(child);Object.freeze(value);}return value;
}
function readAsset(path:string):{data:any;source:SourceAsset}{
 const expected=ASSETS[path];if(!expected)throw Error('Unknown initialization asset');
 const bytes=readFileSync(new URL('../../prompts/initialization/'+path,import.meta.url)),sha256=createHash('sha256').update(bytes).digest('hex');
 if(sha256!==expected)throw Error(`Initialization asset identity changed: ${path}; explicitly version the asset provenance before use.`);
 return{data:JSON.parse(bytes.toString('utf8')),source:{path,sha256}};
}
/** Snapshot optional user priors once; the caller persists this value for resume/freeze. */
export function loadOfficialInitialization(dataset:DatasetName,selection:OfficialInitializationSelection='baseline'):OfficialInitialization{
 if(!OFFICIAL_INITIALIZATION_SELECTIONS.includes(selection))throw Error('Unknown official initialization selection');
 let guidance:OfficialInitialization['guidance']=null,seedStrategy:string|undefined,presentation:OfficialTaskPresentation='no-repeat';
 let provenance:OfficialInitialization['provenance']={assets:[]};
 if(selection==='pr10-selected'){
  if(!['drop','humaneval','mbpp','automationbench'].includes(dataset))throw Error(`No reviewed PR10 strategy asset for ${dataset}`);
  const card=readAsset('pr10/'+dataset+'.json'),template=readAsset('pr10/strategy-template.json'),profile=card.data;
  if(profile.dataset!==dataset||profile.version!=='dataset-initialization-v1'||template.data.version!=='strategy-construction-v1')throw Error('PR10 initialization schema mismatch');
  const selected=profile.selectedSeed;
  // Empty text is a deliberate baseline strategy in the HumanEval/Automation cards.
  if(typeof selected?.strategy!=='string'||!['no-repeat','repeat-task-on-first-sample'].includes(selected.presentation))throw Error('PR10 selected user strategy is invalid');
  seedStrategy=selected.strategy;presentation=selected.presentation;
  // Deliberately omit researchMetadata: historical scores/private diagnostics are not executable guidance.
  guidance={source:'pr10-user-strategy',template:template.data,profile:profile.optimizerProfile,scope:'Optional user strategy hypotheses. The fixed public task/answer contract and actual host capability catalogue take precedence; historical quality is not promised on this backend.'};
  provenance={sourceCommit:PR10_COMMIT,sourceCandidate:selected.sourceCandidate,sourceDefinitionHash:selected.sourceDefinitionHash,assets:[card.source,template.source]};
 }else if(selection==='pr7-guidance'){
  const asset=readAsset('pr7/dataset-initial-prompts.zh-CN.json'),profile=asset.data.datasets?.[dataset];
  if(asset.data.version!=='dataset-prompt-pool-v2'||!profile||typeof profile.task!=='string'||!Array.isArray(profile.initialPrompts))throw Error(`No reviewed PR7 prompt pool for ${dataset}`);
  guidance={source:'pr7-user-prompt-pool',taskGoal:profile.task,promptPool:profile.initialPrompts,scope:'Optional user-only strategy hypotheses. Do not copy these into system. Actual registered capabilities, task output rules and resource permissions override the historical A-route assumptions.'};
  // Old A-specific executionReminders and workerHints are not current resource authority.
  provenance={sourceCommit:PR7_COMMIT,assets:[asset.source]};
 }
 const snapshot:Omit<OfficialInitialization,'identity'>={version:OFFICIAL_INITIALIZATION_VERSION,dataset,selection,guidance,...(seedStrategy!==undefined?{seedStrategy}:{}),presentation,provenance};
 return immutable({...snapshot,identity:artifactHash(snapshot)});
}
