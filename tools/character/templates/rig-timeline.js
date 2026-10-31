// Deterministic timeline shared by the preview, MP4 capture and HyperFrames.
function buildCharacterTimeline(root, actionTimeline, poses, rigs) {
  const tl = gsap.timeline({ paused: true });
  const poseMap = new Map((poses.characters || []).map(c => [c.character_id, c.poses || {}]));
  const rigMap = new Map((rigs.characters || []).map(c => [c.character_id, c]));
  const slug = text => String(text).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '');
  const allowed = new Set(['x', 'y', 'rotation', 'scale', 'scaleX', 'scaleY', 'opacity']);
  root.querySelectorAll('.character').forEach(node => {
    const originalId = (rigs.characters || []).find(c => slug(c.character_id) === node.dataset.character)?.character_id || node.dataset.character;
    const rig = rigMap.get(originalId) || {};
    Object.entries(rig.joints || {}).forEach(([part, joint]) => {
      if (!Array.isArray(joint.pivot)) return;
      const shape = node.querySelector('.' + part.replaceAll('_', '-'));
      if (shape) gsap.set(shape, { svgOrigin: joint.pivot.join(' ') });
    });
    const actions = (actionTimeline.scenes || []).flatMap(s => s.actions || [])
      .filter(a => slug(a.character_id) === node.dataset.character)
      .sort((a, b) => a.at_seconds - b.at_seconds);
    actions.forEach(action => {
      const at = Math.max(0, Number(action.at_seconds) || 0);
      const duration = Math.max(0.02, Number(action.duration_seconds) || 0.2);
      const pose = (poseMap.get(action.character_id) || {})[action.pose] || {};
      const defaults = { idle: {}, blink: { eye_left: { scaleY: 0.08 }, eye_right: { scaleY: 0.08 } },
        look_left: { pupil_left: { x: -6 }, pupil_right: { x: -6 } },
        look_right: { pupil_left: { x: 6 }, pupil_right: { x: 6 } },
        surprised: { head: { y: -4, rotation: -4 }, arm_right: { rotation: 24 } } };
      const parts = { ...(defaults[action.pose] || {}), ...(pose.parts || {}) };
      const ease = action.easing || pose.transition || 'power2.inOut';
      if (action.pose === 'idle') {
        tl.to(node.querySelectorAll('.head, .eye, .pupil, .arm, .leg'),
          { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, duration, ease }, at);
      }
      Object.entries(parts).forEach(([part, properties]) => {
        const shape = node.querySelector('.' + part.replaceAll('_', '-'));
        if (!shape) return;
        const transform = Object.fromEntries(Object.entries(properties).filter(([key, value]) => allowed.has(key) && Number.isFinite(value)));
        if (Object.keys(transform).length) tl.to(shape, { ...transform, duration, ease }, at);
        if (part === 'mouth' && properties.shape === 'small_o') {
          tl.set(shape, { attr: { d: 'M307 277 C307 258 333 258 333 277 C333 296 307 296 307 277 Z' } }, at);
        }
      });
      if (action.action === 'anticipate' || action.action === 'react') {
        tl.to(node, { y: 8, scaleY: 0.97, duration: duration * 0.45, ease }, at);
        tl.to(node, { y: 0, scaleY: 1, duration: duration * 0.55, ease }, at + duration * 0.45);
      }
      if (action.action === 'settle') tl.to(node, { y: 0, scaleY: 1, duration, ease }, at);
    });
  });
  const end = Math.max(0.1, ...(actionTimeline.scenes || []).map(s => Number(s.end_seconds) || 0));
  tl.to({}, { duration: end }, 0);
  return tl;
}
