import {nativeBranchRound,nativeBranchProjectFromStep,nativeBranchEnabled} from '../public/native-branch-core.js';
import {userError} from './workspace.mjs';

export function planNativeBranchRound(project,loop,round) {
 try {return nativeBranchRound(project,loop,round);} catch(error) {throw userError(error.message);}
}
export function restoreNativeBranchProject(project,step) {
 try {return nativeBranchProjectFromStep(project,step);} catch(error) {throw userError(error.message);}
}
export function validateNativeBranchJob(job) {
 if (!job.snapshot?.nodes?.some(nativeBranchEnabled) && !job.steps?.some(step=>step.nativeBranch)) return;
 for (const step of job.steps) if (step.loopId || step.nativeBranch) restoreNativeBranchProject(job.snapshot,step);
}
