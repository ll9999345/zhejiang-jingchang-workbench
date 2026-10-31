/** Return only project-local asset ids that were supplied as generation inputs. */
export function jobReferenceAssetIds(job = {}) {
  const values = [];
  const add = value => {
    if (typeof value === 'string' && value.length > 0) values.push(value);
  };

  if (job.kind === 'image-api') {
    for (const id of job.input?.referenceIds || []) add(id);
  } else if (job.kind === 'comfy') {
    for (const binding of job.imageBindings || []) add(binding?.assetId);
  } else if (job.kind === 'studio') {
    for (const ref of job.input?.studio?.references || []) add(ref?.assetId);
  } else if (job.kind === 'runninghub') {
    for (const field of job.input?.recipe?.fields || []) {
      if (field?.source === 'asset' && field.enabled !== false) add(field.assetId);
    }
  }

  return [...new Set(values)];
}

/**
 * Build safe image-to-image comparison records. Both the output and every
 * reference must be image assets in this project; URLs and foreign ids vanish.
 */
export function imageAssetReferences(project, outputs = [], defaultReferenceIds = []) {
  const assets = new Map((project?.assets || []).map(asset => [asset.id, asset]));
  const imageIds = ids => [...new Set((ids || []).filter(id =>
    typeof id === 'string' && assets.get(id)?.type?.startsWith('image/')) )];
  const fallback = imageIds(defaultReferenceIds);
  const records = [];

  for (const output of outputs) {
    const assetId = typeof output === 'string' ? output : output?.id;
    if (typeof assetId !== 'string' || !assets.get(assetId)?.type?.startsWith('image/')) continue;
    const refs = imageIds(Array.isArray(output?.referenceAssetIds) ? output.referenceAssetIds : fallback)
      .filter(id => id !== assetId);
    if (refs.length) records.push({assetId, referenceAssetIds: refs});
  }

  return records;
}
