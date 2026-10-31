import {parentPort,workerData} from 'node:worker_threads';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {replayEdits,editPixels} from './image-edit-core.mjs';
try{const {width,height,operations,directory}=workerData,state=replayEdits(width,height,await fs.readFile(path.join(directory,'source.rgba')),operations);for(const mode of ['image','mask','input'])await fs.writeFile(path.join(directory,mode+'.rgba'),editPixels(state,mode));parentPort.postMessage({width:state.width,height:state.height});}catch(error){parentPort.postMessage({error:error.message});}
