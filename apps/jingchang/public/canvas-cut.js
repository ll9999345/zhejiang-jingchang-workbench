function pointToSegmentDistance(point, start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (!lengthSquared) return Math.hypot(point.x - start.x, point.y - start.y);
  const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared));
  return Math.hypot(point.x - (start.x + dx * t), point.y - (start.y + dy * t));
}

function segmentDistance(a, b, c, d) {
  const orientation = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const onSegment = (p, q, r) => q.x >= Math.min(p.x, r.x) && q.x <= Math.max(p.x, r.x)
    && q.y >= Math.min(p.y, r.y) && q.y <= Math.max(p.y, r.y);
  const o1 = orientation(a, b, c), o2 = orientation(a, b, d);
  const o3 = orientation(c, d, a), o4 = orientation(c, d, b);
  if ((o1 === 0 && onSegment(a, c, b)) || (o2 === 0 && onSegment(a, d, b))
      || (o3 === 0 && onSegment(c, a, d)) || (o4 === 0 && onSegment(c, b, d))
      || ((o1 > 0) !== (o2 > 0) && (o3 > 0) !== (o4 > 0))) return 0;
  return Math.min(
    pointToSegmentDistance(a, c, d), pointToSegmentDistance(b, c, d),
    pointToSegmentDistance(c, a, b), pointToSegmentDistance(d, a, b)
  );
}

export function polylinesTouch(first, second, tolerance = 9) {
  if (!Array.isArray(first) || !Array.isArray(second) || first.length < 2 || second.length < 2) return false;
  for (let i = 1; i < first.length; i++) {
    for (let j = 1; j < second.length; j++) {
      if (segmentDistance(first[i - 1], first[i], second[j - 1], second[j]) <= tolerance) return true;
    }
  }
  return false;
}
