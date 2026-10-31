import test from 'node:test';
import assert from 'node:assert/strict';
import {imageAssetReferences,jobReferenceAssetIds} from '../lib/media-lineage.mjs';

test('生成任务只保留本地参考素材编号并去重',()=>{
  assert.deepEqual(jobReferenceAssetIds({kind:'image-api',input:{referenceIds:['local-a','local-a','']}}),['local-a']);
  assert.deepEqual(jobReferenceAssetIds({kind:'comfy',imageBindings:[{assetId:'local-b'},{assetId:'local-b'}]}),['local-b']);
  assert.deepEqual(jobReferenceAssetIds({kind:'studio',input:{studio:{references:[{assetId:'local-c'},{url:'https://example.invalid/ref.png'}]}}}),['local-c']);
  assert.deepEqual(jobReferenceAssetIds({kind:'runninghub',input:{recipe:{fields:[{source:'asset',assetId:'local-d'},{source:'asset',assetId:'disabled',enabled:false},{source:'value',assetId:'ignored'}]}}}),['local-d']);
});

test('比较记录只关联当前项目中的图片输出和图片参考',()=>{
  const project={assets:[
    {id:'output-image',type:'image/png'},
    {id:'reference-image',type:'image/jpeg'},
    {id:'video',type:'video/mp4'},
  ]};
  assert.deepEqual(imageAssetReferences(project,[
    {id:'output-image',referenceAssetIds:['reference-image','video','foreign','reference-image']},
    {id:'video',referenceAssetIds:['reference-image']},
    {id:'reference-image',referenceAssetIds:['reference-image']},
  ]),[{assetId:'output-image',referenceAssetIds:['reference-image']}]);
  assert.deepEqual(imageAssetReferences(project,['output-image'],['foreign','video','reference-image']),[
    {assetId:'output-image',referenceAssetIds:['reference-image']},
  ]);
});
