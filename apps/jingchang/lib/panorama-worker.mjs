import {parentPort,workerData} from 'node:worker_threads';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {projectPanorama} from './panorama-core.mjs';
try{const {directory,width,height,options}=workerData,pixels=await fs.readFile(path.join(directory,'source.rgba'));await fs.writeFile(path.join(directory,'view.rgba'),projectPanorama(pixels,width,height,options));parentPort.postMessage({ok:true});}catch(e){parentPort.postMessage({error:e.message});}
